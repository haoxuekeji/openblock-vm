const fs = require('fs');
const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = () => {
    const emitted = [];
    return {
        constructor: {
            PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
            PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
            PERIPHERAL_LIVE_UNAVAILABLE: 'PERIPHERAL_LIVE_UNAVAILABLE',
            PERIPHERAL_LIVE_AVAILABLE: 'PERIPHERAL_LIVE_AVAILABLE'
        },
        emitted,
        emit (name, payload) {
            emitted.push({name, payload});
        },
        on () {},
        removeListener () {},
        registerPeripheralExtension () {},
        isRealtimeMode: () => true
    };
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const FRAME_START = '\x1c';
const FRAME_END = '\x1d';

/**
 * Build a live peripheral wired to a fake board that also understands
 * the push sampler protocol: start commands are acknowledged (or not,
 * via options.pushAck=false) and read commands are answered from a
 * value table, like the live-reads harness. sendFrame() injects a
 * sampler frame into the notification stream; the generation of the
 * last acknowledged start command is parsed from the command source,
 * exactly what a real board would embed in its frames.
 * @param {object} values - expression -> reply value (string).
 * @param {object} options - fake transport options.
 * @param {boolean} options.pushAck - answer start commands with the
 *   ack marker (default true).
 * @param {boolean} options.holdWrites - hold non-push, non-read
 *   commands until releaseWrite() (write in-flight timing control).
 * @return {object} - peripheral, commands, frame/write controls.
 */
const makePushPeripheral = (values, options = {}) => {
    const runtime = makeRuntime();
    const peripheral = new MicroPythonBlePeripheral(
        runtime, 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._liveReady = true;
    const commands = [];
    const heldWrites = [];
    let boardGen = null;
    const answer = command => {
        let stdout = '';
        if (command.startsWith('import sys,time,_thread')) {
            const match = /_ob_push_g=(\d+)/.exec(command);
            if (options.pushAck === false) {
                stdout = '';
            } else {
                boardGen = match ? Number(match[1]) : null;
                stdout = 'OBPUSH1\r\n';
            }
        } else if (command.startsWith('_ob_push_g=-1')) {
            boardGen = null;
            stdout = 'OBPUSHOFF\r\n';
        } else if (command.startsWith('_r=[]')) {
            const expressions = [];
            const pattern = /lambda:\((.*?)\),/g;
            let match;
            while ((match = pattern.exec(command)) !== null) {
                expressions.push(match[1]);
            }
            stdout = `${expressions.map(expression => values[expression] || '').join('\x1e')}\r\n`;
        } else if (command.startsWith('print(')) {
            stdout = `${values[command.slice(6, -1)] || ''}\r\n`;
        }
        peripheral._routeIncoming(Buffer.from(`OK${stdout}\x04\x04>`, 'latin1'));
    };
    let pasteBuffer = null;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        if (text === '\x05A\x01') {
            pasteBuffer = '';
            peripheral._routeIncoming(Buffer.from('R\x01\x00\x08', 'latin1'));
            return Promise.resolve();
        }
        if (pasteBuffer !== null) {
            pasteBuffer += text;
            if (pasteBuffer.endsWith('\x04')) {
                const command = pasteBuffer.slice(0, -1);
                pasteBuffer = null;
                commands.push(command);
                // Raw-paste replies have no leading OK.
                let stdout = '';
                if (command.startsWith('import sys,time,_thread') && options.pushAck !== false) {
                    const match = /_ob_push_g=(\d+)/.exec(command);
                    boardGen = match ? Number(match[1]) : null;
                    stdout = 'OBPUSH1\r\n';
                }
                peripheral._routeIncoming(Buffer.from(`\x04${stdout}\x04\x04>`, 'latin1'));
            }
            return Promise.resolve();
        }
        if (!text.endsWith('\x04')) return Promise.resolve();
        const command = text.slice(0, -1);
        commands.push(command);
        const isPushOrRead = command.startsWith('import sys,time,_thread') ||
            command.startsWith('_ob_push_g=-1') ||
            command.startsWith('_r=[]') || command.startsWith('print(');
        if (options.holdWrites && !isPushOrRead) {
            heldWrites.push(() => answer(command));
        } else {
            answer(command);
        }
        return Promise.resolve();
    };
    return {
        peripheral,
        runtime,
        commands,
        boardGen: () => boardGen,
        sendFrame: (gen, frameValues) => {
            peripheral._routeIncoming(Buffer.from(
                `${FRAME_START}P${gen};${frameValues.join('\x1e')}${FRAME_END}`, 'latin1'));
        },
        releaseWrite: () => {
            const reply = heldWrites.shift();
            if (reply) reply();
        },
        startCommands: () => commands.filter(
            command => command.startsWith('import sys,time,_thread'))
    };
};

test('command builders: sampler thread source and stop', t => {
    const command = MicroPythonBlePeripheral.buildLivePushStartCommand(
        ['p4.value()', 'adc5.read()'], 7, 25);
    t.ok(command.includes('_ob_push_g=7'), 'generation assigned first (kills the old thread)');
    t.ok(command.includes('lambda:(p4.value()),lambda:(adc5.read())'),
        'expressions isolated exactly like a batched read');
    t.ok(command.includes("except:_r.append('')"), 'per-expression failure degrades to empty');
    t.ok(command.includes('_thread.start_new_thread(_ob_push_run,(7,'),
        'thread started with the same generation');
    t.ok(command.includes('time.sleep_ms(25)'), 'sampling period embedded');
    t.ok(command.includes("print('OBPUSH1')"), 'start is acknowledged');
    t.ok(command.includes('if len(_s)<=512:'), 'oversized frames are skipped board-side');
    const stop = MicroPythonBlePeripheral.buildLivePushStopCommand();
    t.ok(stop.startsWith('_ob_push_g=-1'), 'stop invalidates the generation');
    t.end();
});

test('hot expressions start the sampler and frames answer reads from the cache', async t => {
    const {peripheral, commands, sendFrame, boardGen, startCommands} =
        makePushPeripheral({'adc32.read()': '1000'});

    const first = await peripheral.readLiveString('adc32.read()');
    t.equal(first, '1000', 'first read goes to the board');

    await wait(30); // one pump beat: the sampler start departs
    t.equal(startCommands().length, 1, 'one sampler start command');
    t.ok(peripheral._livePushActive, 'push active after the ack');
    t.ok(commands[0].startsWith('print('), 'plain read stayed the fast path');

    const before = commands.length;
    sendFrame(boardGen(), ['2048']);
    const pushed = await peripheral.readLiveString('adc32.read()');
    t.equal(pushed, '2048', 'read answered with the pushed value');
    sendFrame(boardGen(), ['2049']);
    const again = await peripheral.readLiveString('adc32.read()');
    t.equal(again, '2049', 'next frame refreshes the cache again');
    t.equal(commands.length, before, 'no REPL round trip for pushed reads');
    t.end();
});

test('frames split across packets and interleaved with a reply stay intact', async t => {
    const {peripheral} = makePushPeripheral({});
    peripheral._writeRaw = () => Promise.resolve();
    peripheral._livePushActive = true;
    peripheral._livePushExprs = ['adc32.read()'];
    peripheral._livePushGen = 5;
    peripheral._liveReadLastSeen['adc32.read()'] = Date.now();

    // A frame torn across two notification packets.
    peripheral._routeIncoming(Buffer.from(`${FRAME_START}P5;77`, 'latin1'));
    t.equal(peripheral._livePushCarry.length > 0, true, 'partial frame carried');
    peripheral._routeIncoming(Buffer.from(`7${FRAME_END}`, 'latin1'));
    t.equal(peripheral._livePushCarry, '', 'carry consumed');
    const value = await peripheral.readLiveString('adc32.read()');
    t.equal(value, '777', 'torn frame reassembled into the cache');

    // A frame in the middle of a raw REPL reply must not disturb it.
    const readPromise = peripheral.readLiveString('p4.value()');
    await wait(15); // batch window + queue: the command is on the wire now
    peripheral._routeIncoming(Buffer.from(
        `OK1${FRAME_START}P5;888${FRAME_END}\r\n\x04\x04>`, 'latin1'));
    t.equal(await readPromise, '1', 'reply parsed as if the frame was not there');
    const riding = await peripheral.readLiveString('adc32.read()');
    t.equal(riding, '888', 'interleaved frame still consumed');
    t.end();
});

test('an expression set change restarts the sampler; stale generations are dropped', async t => {
    const {peripheral, sendFrame, boardGen, startCommands} = makePushPeripheral({
        'adc32.read()': '10',
        'adc33.read()': '20'
    });

    await peripheral.readLiveString('adc32.read()');
    await wait(30);
    t.equal(startCommands().length, 1, 'sampler running for the first expression');
    const oldGen = boardGen();

    await peripheral.readLiveString('adc33.read()');
    await wait(40);
    t.equal(startCommands().length, 2, 'config change restarted the sampler');
    const lastStart = startCommands()[1];
    t.ok(lastStart.includes('lambda:(adc32.read()),lambda:(adc33.read())'),
        'new sampler serves both expressions sorted');
    t.notEqual(boardGen(), oldGen, 'generation advanced');

    sendFrame(oldGen, ['9999']);
    const fresh = await peripheral.readLiveString('adc32.read()');
    t.notEqual(fresh, '9999', 'stale-generation frame never lands in the cache');

    sendFrame(boardGen(), ['111', '222']);
    t.equal(await peripheral.readLiveString('adc32.read()'), '111', 'first value by list order');
    t.equal(await peripheral.readLiveString('adc33.read()'), '222', 'second value by list order');
    t.end();
});

test('frames around a state-changing command never resurrect pre-write values', async t => {
    const {peripheral, sendFrame, releaseWrite} = makePushPeripheral(
        {'p4.value()': '333'}, {holdWrites: true});
    peripheral._livePushWriteMuteMs = 30;
    peripheral._livePushActive = true;
    peripheral._livePushExprs = ['p4.value()'];
    peripheral._livePushGen = 5;
    peripheral._liveReadLastSeen['p4.value()'] = Date.now();

    sendFrame(5, ['111']);
    t.equal(await peripheral.readLiveString('p4.value()'), '111', 'frame served before the write');

    const write = peripheral.execLive('p4.value(1)');
    await wait(5); // the queued command reaches the (holding) board
    sendFrame(5, ['111']); // sampled before the write executed
    releaseWrite();
    await write;
    t.notOk(peripheral._liveReadCache['p4.value()'], 'in-flight frame dropped, cache stays cleared');

    sendFrame(5, ['222']); // still inside the post-write grace
    const afterWrite = await peripheral.readLiveString('p4.value()');
    t.equal(afterWrite, '333', 'read went to the board instead of a muted frame');

    await wait(40); // grace over
    sendFrame(5, ['444']);
    t.equal(await peripheral.readLiveString('p4.value()'), '444', 'frames land again after the grace');
    t.end();
});

test('a sampler that never acks falls back to the resident pump for the session', async t => {
    const {peripheral, commands, startCommands} = makePushPeripheral(
        {'adc32.read()': '55'}, {pushAck: false});

    await peripheral.readLiveString('adc32.read()');
    await wait(60); // two beats: first start fails, the retry spends the budget
    t.equal(startCommands().length, 2, 'start attempted and retried once');
    t.notOk(peripheral._livePushActive, 'no ack, never active');
    t.ok(peripheral._livePushUnsupported, 'push given up for the session');

    const before = commands.length;
    await wait(40);
    const pumped = commands.slice(before).filter(command => command.startsWith('print('));
    t.ok(pumped.length > 0, 'resident pump refreshes the hot expression instead');
    t.equal(startCommands().length, 2, 'no further start attempts');
    t.end();
});

test('a stalled sampler hands the beat to the pump and retries within budget', async t => {
    const {peripheral, commands, sendFrame, boardGen, startCommands} =
        makePushPeripheral({'adc32.read()': '66'});

    await peripheral.readLiveString('adc32.read()');
    await wait(30);
    t.equal(startCommands().length, 1, 'sampler started');
    peripheral._livePushStallMs = 25;
    sendFrame(boardGen(), ['67']);

    await wait(60); // no more frames: stall detected on a beat
    t.notOk(peripheral._livePushUnsupported, 'first stall only costs one failure');
    t.equal(startCommands().length, 2, 'restart attempted after the stall');
    // The restart was acked but this sampler stalls silently too.
    await wait(60);
    t.ok(peripheral._livePushUnsupported, 'second stall spends the budget');
    const pumped = commands.filter(command => command.startsWith('print('));
    t.ok(pumped.length > 0, 'pump kept the expression refreshed throughout');
    t.end();
});

test('leaving live mode stops the sampler; a reset drops all push state', async t => {
    const {peripheral, commands, sendFrame} = makePushPeripheral({});
    peripheral._livePushActive = true;
    peripheral._livePushExprs = ['adc32.read()'];
    peripheral._livePushGen = 5;

    await peripheral._exitLiveMode();
    t.ok(commands.some(command => command.startsWith('_ob_push_g=-1')),
        'stop command sent while the raw REPL was still ours');
    t.notOk(peripheral._livePushActive, 'push inactive');

    sendFrame(5, ['12345']);
    t.notOk(peripheral._liveReadCache['adc32.read()'],
        'frames of the stopped sampler are ignored (generation bumped)');

    // A session reset (drop/reboot) also drops a half-received frame:
    // the next connection is a new byte stream.
    peripheral._livePushCarry = `${FRAME_START}P5;12`;
    peripheral._resetLiveState();
    t.equal(peripheral._livePushCarry, '', 'partial frame dropped with the session');
    t.end();
});

test('stray frame-start bytes in program output are released, not eaten', async t => {
    const {peripheral, runtime} = makePushPeripheral({});
    const junk = FRAME_START + 'x'.repeat(1100); // larger than any real frame
    peripheral._routeIncoming(Buffer.from(junk, 'latin1'));
    await wait(40); // console aggregation flush
    const received = runtime.emitted
        .filter(event => event.name === 'PERIPHERAL_RECIVE_DATA')
        .map(event => event.payload.toString('latin1'))
        .join('');
    t.equal(received, junk, 'withheld bytes released to the console byte for byte');
    t.end();
});

test('transports with the push gate off leave the stream untouched', async t => {
    const {peripheral, runtime, startCommands} = makePushPeripheral({'adc32.read()': '77'});
    peripheral._livePushEnabled = false;

    await peripheral.readLiveString('adc32.read()');
    await wait(40);
    t.equal(startCommands().length, 0, 'no sampler start on a gated transport');

    const raw = `${FRAME_START}P1;99${FRAME_END}`;
    peripheral._routeIncoming(Buffer.from(raw, 'latin1'));
    await wait(40);
    const received = runtime.emitted
        .filter(event => event.name === 'PERIPHERAL_RECIVE_DATA')
        .map(event => event.payload.toString('latin1'))
        .join('');
    t.equal(received, raw, 'frame-looking bytes flow to the console untouched');
    t.end();
});

test('the live prologue kills leftover samplers of a previous session', t => {
    t.ok(MicroPythonBlePeripheral.buildLivePushStartCommand(['x'], 1, 25)
        .includes('while _ob_push_g==_g:'), 'thread exits on generation mismatch');
    // The prologue reassigns the generation, so a sampler surviving a
    // session rebuild (browser reload, board-fs exchange) dies on the
    // next handshake without costing a round trip.
    const source = fs.readFileSync(
        require.resolve('../../src/devices/common/micropython-ble-peripheral'), 'utf8');
    t.ok(/LIVE_PROLOGUE = '[^']*_ob_push_g=-1'/.test(source),
        'prologue resets the sampler generation');
    t.end();
});
