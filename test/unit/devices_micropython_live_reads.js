const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = () => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
        PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
        PERIPHERAL_LIVE_UNAVAILABLE: 'PERIPHERAL_LIVE_UNAVAILABLE',
        PERIPHERAL_LIVE_AVAILABLE: 'PERIPHERAL_LIVE_AVAILABLE'
    },
    emit () {},
    on () {},
    removeListener () {},
    registerPeripheralExtension () {},
    isRealtimeMode: () => true
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Build a live peripheral wired to a fake board that answers read
 * commands from a value table: batched commands get their lambda
 * expressions looked up and joined with the record separator, plain
 * print commands get the single value. Values are looked up when the
 * reply is produced, so tests can change them between round trips.
 * @param {object} values - expression -> reply value (string).
 * @param {object} options - fake transport options.
 * @param {number} options.latency - delay each reply this many ms
 *   (simulates a high-RTT link such as BLE).
 * @param {boolean} options.manual - hold every reply until the test
 *   calls release(), for exact in-flight timing control.
 * @return {{peripheral: MicroPythonBlePeripheral, commands: Array.<string>,
 *   release: Function, heldCount: Function}} - the peripheral, the raw
 *   REPL commands the board received, and the manual-mode controls.
 */
const makeReadPeripheral = (values, options = {}) => {
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(), 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._liveReady = true;
    // This file covers the batched-read and resident-pump semantics,
    // i.e. the refresh path when the board push sampler is not running
    // (Web Serial, old firmware, push failure). The push path has its
    // own suite in devices_micropython_live_push.js.
    peripheral._livePushEnabled = false;
    const commands = [];
    const held = [];
    const answer = (command, rawPaste) => {
        let stdout = '';
        if (command.startsWith('_r=[]')) {
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
        // Raw-paste replies carry the end-of-data ack and no leading OK.
        const reply = rawPaste ? `\x04${stdout}\x04\x04>` : `OK${stdout}\x04\x04>`;
        peripheral._routeIncoming(Buffer.from(reply, 'latin1'));
    };
    const deliver = (command, rawPaste) => {
        if (options.manual) {
            held.push(() => answer(command, rawPaste));
        } else if (options.latency) {
            setTimeout(() => answer(command, rawPaste), options.latency);
        } else {
            answer(command, rawPaste);
        }
    };
    // Large commands (a full read batch exceeds the plain raw REPL size
    // limit) arrive through the raw-paste protocol instead.
    let pasteBuffer = null;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        if (text === '\x05A\x01') {
            pasteBuffer = '';
            // Supported, flow control window 2048 bytes.
            peripheral._routeIncoming(Buffer.from('R\x01\x00\x08', 'latin1'));
            return Promise.resolve();
        }
        if (pasteBuffer !== null) {
            pasteBuffer += text;
            if (pasteBuffer.endsWith('\x04')) {
                const command = pasteBuffer.slice(0, -1);
                pasteBuffer = null;
                commands.push(command);
                deliver(command, true);
            }
            return Promise.resolve();
        }
        if (!text.endsWith('\x04')) return Promise.resolve();
        const command = text.slice(0, -1);
        commands.push(command);
        deliver(command, false);
        return Promise.resolve();
    };
    return {
        peripheral,
        commands,
        release: () => {
            const reply = held.shift();
            if (reply) reply();
        },
        heldCount: () => held.length
    };
};

test('reads issued within one tick merge into a single round trip', async t => {
    const {peripheral, commands} = makeReadPeripheral({
        'p4.value()': '1',
        'adc5.read()': '4095',
        'tp6.read()': '233'
    });

    const [a, b, c] = await Promise.all([
        peripheral.readLiveString('p4.value()'),
        peripheral.readLiveString('adc5.read()'),
        peripheral.readLiveString('tp6.read()')
    ]);
    t.equal(a, '1', 'first value dispatched in order');
    t.equal(b, '4095', 'second value dispatched in order');
    t.equal(c, '233', 'third value dispatched in order');
    t.equal(commands.length, 1, 'one REPL round trip for all three reads');
    t.ok(commands[0].startsWith('_r=[]'), 'batched command used');
    t.end();
});

test('a single pending read keeps the plain print command', async t => {
    const {peripheral, commands} = makeReadPeripheral({'p4.value()': '0'});

    const value = await peripheral.readLiveString('p4.value()');
    t.equal(value, '0', 'value returned');
    t.same(commands, ['print(p4.value())'], 'no batch wrapper for one read');
    t.end();
});

test('numbers parse through the batch and same-tick duplicates share it', async t => {
    const {peripheral, commands} = makeReadPeripheral({
        'p4.value()': '1',
        'adc5.read()': '2048'
    });

    const [level, levelAgain, adc] = await Promise.all([
        peripheral.readLiveNumber('p4.value()'),
        peripheral.readLiveNumber('p4.value()'),
        peripheral.readLiveNumber('adc5.read()')
    ]);
    t.equal(level, 1, 'digital value parsed');
    t.equal(levelAgain, 1, 'duplicate read served from the same round trip');
    t.equal(adc, 2048, 'analog value parsed');
    t.equal(commands.length, 1, 'one round trip in total');
    t.end();
});

test('an empty slot (board-side per-expression failure) hits only that read', async t => {
    const {peripheral} = makeReadPeripheral({
        'broken.read()': '',
        'adc5.read()': '4095'
    });

    const [broken, healthy] = await Promise.all([
        peripheral.readLiveString('broken.read()'),
        peripheral.readLiveString('adc5.read()')
    ]);
    t.equal(broken, '', 'failing expression degrades to empty');
    t.equal(healthy, '4095', 'other readings unaffected');
    t.end();
});

test('an unparseable batch reply degrades every read to empty', async t => {
    const {peripheral} = makeReadPeripheral({});
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            peripheral._routeIncoming(Buffer.from('OKgarbage no separators\r\n\x04\x04>', 'latin1'));
        }
        return Promise.resolve();
    };

    const [a, b] = await Promise.all([
        peripheral.readLiveString('p4.value()'),
        peripheral.readLiveString('adc5.read()')
    ]);
    t.equal(a, '', 'first read degraded');
    t.equal(b, '', 'second read degraded');
    t.end();
});

test('reads resolve empty when the live channel is down', async t => {
    const {peripheral} = makeReadPeripheral({'p4.value()': '1'});
    peripheral._liveReady = false;

    const value = await peripheral.readLiveString('p4.value()');
    t.equal(value, '', 'no live session degrades to empty');
    t.end();
});

test('buildLiveReadBatchCommand isolates expressions and joins with the separator', t => {
    const command = MicroPythonBlePeripheral.buildLiveReadBatchCommand(
        ['p4.value()', 'max(1,2)']
    );
    t.equal(command,
        '_r=[]\n' +
        'for _f in (lambda:(p4.value()),lambda:(max(1,2)),):\n' +
        ' try:_r.append(str(_f()))\n' +
        " except:_r.append('')\n" +
        "print('\\x1e'.join(_r))",
        'python source as designed');
    t.end();
});

test('reads arriving while a command is in flight merge into the next batch', async t => {
    const {peripheral, commands, release} = makeReadPeripheral({
        'adc4.read()': '111',
        'adc5.read()': '222',
        'tp6.read()': '333'
    }, {manual: true});

    const first = peripheral.readLiveString('adc4.read()');
    await wait(20);
    t.equal(commands.length, 1, 'first read departed after its window');

    // These two arrive in different batch windows; without the
    // queue-idle departure rule each would flush its own command.
    const second = peripheral.readLiveString('adc5.read()');
    await wait(15);
    const third = peripheral.readLiveString('tp6.read()');
    await wait(15);
    t.equal(commands.length, 1, 'batch held back while a command is in flight');

    release();
    await first;
    await wait(5);
    t.equal(commands.length, 2, 'held batch departed right when the queue drained');
    t.ok(commands[1].includes('adc5.read()') && commands[1].includes('tp6.read()'),
        'both later reads share one round trip');

    release();
    const [a, b, c] = await Promise.all([first, second, third]);
    t.equal(a, '111', 'first value answered');
    t.equal(b, '222', 'held value answered');
    t.equal(c, '333', 'held value answered');
    t.equal(commands.length, 2, 'no further round trips needed');
    t.end();
});

test('the resident pump refreshes hot expressions and reads answer from the cache', async t => {
    const values = {'adc4.read()': '100', 'adc5.read()': '200'};
    const {peripheral, commands, release, heldCount} = makeReadPeripheral(values, {manual: true});
    const releaseNext = async () => {
        while (heldCount() === 0) await wait(2);
        release();
    };

    const warmup = Promise.all([
        peripheral.readLiveString('adc4.read()'),
        peripheral.readLiveString('adc5.read()')
    ]);
    await releaseNext();
    const [x1, y1] = await warmup;
    t.equal(x1, '100', 'first axis read');
    t.equal(y1, '200', 'second axis read');
    t.equal(commands.length, 1, 'warmup merged into one round trip');

    // The board values change; the next pump beat picks them up without
    // any block asking for them.
    values['adc4.read()'] = '101';
    values['adc5.read()'] = '201';
    await releaseNext();
    t.equal(commands.length, 2, 'pump sent one background refresh');
    t.ok(commands[1].startsWith('_r=[]'), 'pump refresh is one batched command');
    t.ok(commands[1].includes('adc4.read()') && commands[1].includes('adc5.read()'),
        'pump refreshes both hot expressions in one round trip');
    // Let the released reply settle into the cache.
    await wait(2);

    const x2 = await peripheral.readLiveString('adc4.read()');
    const y2 = await peripheral.readLiveString('adc5.read()');
    t.equal(x2, '101', 'read answered the pumped value from the cache');
    t.equal(y2, '201', 'read answered the pumped value from the cache');
    t.equal(commands.length, 2, 'cache hits cost no extra round trip');
    t.end();
});

test('pump batches respect the batch expression limit', async t => {
    const values = {};
    const names = [];
    for (let i = 0; i < 30; i++) {
        const expression = `adc${i}.read()`;
        names.push(expression);
        values[expression] = String(i);
    }
    const {peripheral, commands, release, heldCount} = makeReadPeripheral(values, {manual: true});
    const releaseNext = async () => {
        while (heldCount() === 0) await wait(2);
        release();
    };

    const warmup = Promise.all(names.map(expression => peripheral.readLiveString(expression)));
    await releaseNext();
    await releaseNext();
    const settled = await warmup;
    t.same(settled, names.map((expression, i) => String(i)),
        'thirty cold reads all answered');
    t.equal(commands.length, 2, 'thirty cold reads took two batches');

    await releaseNext();
    t.equal(commands.length, 3, 'pump refresh departed');
    t.equal((commands[2].match(/lambda:/g) || []).length, 24,
        'pump batch capped at the expression limit');
    t.end();
});

test('a state-changing command invalidates in-flight ride-along values', async t => {
    const values = {'adc4.read()': '100', 'adc5.read()': '200'};
    const {peripheral, commands, release, heldCount} = makeReadPeripheral(values, {manual: true});
    const releaseNext = async () => {
        while (heldCount() === 0) await wait(2);
        release();
    };

    // Warm both axes up so they are hot and cached.
    const warmup = Promise.all([
        peripheral.readLiveString('adc4.read()'),
        peripheral.readLiveString('adc5.read()')
    ]);
    await releaseNext();
    await warmup;
    await wait(60);

    // The first axis departs with the second riding along...
    const x = peripheral.readLiveString('adc4.read()');
    await wait(15);
    t.equal(commands.length, 2, 'read batch departed');
    t.ok(commands[1].includes('adc5.read()'), 'second axis rode along');

    // ...and a write command arrives while that batch is in flight.
    const write = peripheral.execLive('p4.value(1)');
    await releaseNext();
    t.equal(await x, '100', 'in-flight read still answered');
    values['adc5.read()'] = '999';
    await releaseNext();
    await write;

    // The ride-along value predates the write, it must not be served.
    const y = peripheral.readLiveString('adc5.read()');
    await releaseNext();
    t.equal(await y, '999', 'post-write read went back to the board');
    t.equal(commands.length, 4, 'a fresh round trip was needed');
    t.end();
});

test('a lone hot expression keeps the plain print fast path', async t => {
    const {peripheral, commands, release, heldCount} = makeReadPeripheral(
        {'adc4.read()': '7'}, {manual: true}
    );
    const releaseNext = async () => {
        while (heldCount() === 0) await wait(2);
        release();
    };

    const first = peripheral.readLiveString('adc4.read()');
    await releaseNext();
    t.equal(await first, '7', 'first read answered');

    await releaseNext();
    t.equal(commands.length, 2, 'pump refreshed the lone expression');
    t.same(commands, ['print(adc4.read())', 'print(adc4.read())'],
        'a single expression with nothing to ride along never batches');
    t.end();
});

test('sequential two-axis polling runs at frame rate, not at RTT rate', async t => {
    const {peripheral, commands} = makeReadPeripheral({
        'adc4.read()': '1872',
        'adc5.read()': '1904'
    }, {latency: 100});

    // Cold start: the very first read of each axis pays a round trip.
    const x0 = await peripheral.readLiveString('adc4.read()');
    const y0 = await peripheral.readLiveString('adc5.read()');
    t.equal(x0, '1872', 'first axis cold read answered');
    t.equal(y0, '1904', 'second axis cold read answered');

    // Warm loop: every read hits the pumped cache and never waits for
    // the 100ms RTT, so the loop runs at its own frame gap.
    const iterations = 6;
    const start = Date.now();
    for (let i = 0; i < iterations; i++) {
        const x = await peripheral.readLiveString('adc4.read()');
        const y = await peripheral.readLiveString('adc5.read()');
        t.equal(x, '1872', `iteration ${i} first axis answered`);
        t.equal(y, '1904', `iteration ${i} second axis answered`);
        await wait(60);
    }
    const elapsed = Date.now() - start;
    // 6 iterations x 60ms frame gap plus scheduling noise; the pre-pump
    // behavior serialized about one full RTT per iteration on top of
    // the frame gap (>=960ms).
    t.ok(elapsed < 700, `two-axis loop took ${elapsed}ms, not RTT-bound`);
    // Round trips track the pump rate (roughly elapsed / RTT), fully
    // decoupled from the iteration count.
    t.ok(commands.length <= Math.ceil(elapsed / 100) + 3,
        `${commands.length} round trips track the link rate`);
    const pumped = commands.slice(2);
    t.ok(pumped.length > 0, 'pump kept refreshing in the background');
    t.ok(pumped.every(command =>
        command.includes('adc4.read()') && command.includes('adc5.read()')),
    'every pump batch refreshes both axes in one round trip');
    t.end();
});

test('reads served from the pumped cache answer within 5ms', async t => {
    const {peripheral, commands} = makeReadPeripheral({
        'adc4.read()': '1872',
        'adc5.read()': '1904'
    }, {latency: 100});

    await peripheral.readLiveString('adc4.read()');
    await peripheral.readLiveString('adc5.read()');
    const countBefore = commands.length;

    const start = Date.now();
    const x = await peripheral.readLiveString('adc4.read()');
    const y = await peripheral.readLiveString('adc5.read()');
    const elapsed = Date.now() - start;
    t.equal(x, '1872', 'first axis answered');
    t.equal(y, '1904', 'second axis answered');
    t.ok(elapsed <= 5, `cache-hit reads answered in ${elapsed}ms`);
    t.equal(commands.length, countBefore, 'the reads issued no round trip');
    t.end();
});

test('the pump keeps at most one command in flight and no backlog builds up', async t => {
    const {peripheral, commands} = makeReadPeripheral({
        'adc4.read()': '1872',
        'adc5.read()': '1904'
    }, {latency: 20});
    let maxInFlight = 0;
    const baseWrite = peripheral._writeRaw;
    peripheral._writeRaw = buffer => {
        maxInFlight = Math.max(maxInFlight, peripheral._liveInFlight);
        return baseWrite(buffer);
    };

    // A scaled-down soak: blocks keep polling both axes while the pump
    // refreshes them in the background.
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
        await peripheral.readLiveString('adc4.read()');
        await peripheral.readLiveString('adc5.read()');
        await wait(10);
    }
    t.equal(maxInFlight, 1, 'never more than one live command in flight');
    t.equal(peripheral._pendingLiveReads.length, 0, 'no pending read backlog');
    t.ok(commands.length <= Math.ceil(400 / 20) + 4,
        `round trips bounded by the link rate (${commands.length})`);
    t.equal(Object.keys(peripheral._liveReadCache).length, 2,
        'cache stays bounded to the hot expressions');
    t.equal(Object.keys(peripheral._liveReadLastSeen).length, 2,
        'hot table stays bounded');
    t.end();
});

test('the pump falls silent once no expression was read for the hot window', async t => {
    const {peripheral, commands} = makeReadPeripheral({'adc4.read()': '7'});

    await peripheral.readLiveString('adc4.read()');
    // Age the hot table instead of sleeping through the real window.
    peripheral._liveReadLastSeen['adc4.read()'] -= 3000;
    await wait(50);
    const settled = commands.length;
    await wait(50);
    t.equal(commands.length, settled, 'no further pump batches');
    t.notOk(peripheral._liveReadPumpTimer, 'pump timer gone');
    t.same(peripheral._liveReadLastSeen, {}, 'stale hot entry cleaned up');
    t.end();
});

test('the pump pauses during an upload and resumes afterwards', async t => {
    const values = {'adc4.read()': '7'};
    const {peripheral, commands} = makeReadPeripheral(values, {latency: 5});

    await peripheral.readLiveString('adc4.read()');
    await wait(60);
    t.ok(commands.length >= 2, 'pump running before the upload');

    peripheral._uploading = true;
    await wait(40);
    const during = commands.length;
    await wait(60);
    t.equal(commands.length, during, 'pump paused while uploading');

    peripheral._uploading = false;
    const value = await peripheral.readLiveString('adc4.read()');
    t.equal(value, '7', 'read after the upload answered');
    await wait(60);
    t.ok(commands.length > during, 'pump resumed after the upload');
    t.end();
});

test('reset stops the pump and clears the hot table', async t => {
    const {peripheral, commands} = makeReadPeripheral({'adc4.read()': '7'}, {latency: 5});

    await peripheral.readLiveString('adc4.read()');
    await wait(40);
    t.ok(commands.length >= 1, 'pump ran while connected');

    peripheral.reset();
    const after = commands.length;
    await wait(60);
    t.equal(commands.length, after, 'no pump batches after reset');
    t.notOk(peripheral._liveReadPumpTimer, 'pump timer cleared');
    t.same(peripheral._liveReadLastSeen, {}, 'hot table cleared');
    t.end();
});
