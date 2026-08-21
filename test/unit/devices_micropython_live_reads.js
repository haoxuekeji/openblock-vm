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

test('hot expressions ride along and refresh the cache', async t => {
    const values = {'adc4.read()': '100', 'adc5.read()': '200'};
    const {peripheral, commands} = makeReadPeripheral(values);

    const [x1, y1] = await Promise.all([
        peripheral.readLiveString('adc4.read()'),
        peripheral.readLiveString('adc5.read()')
    ]);
    t.equal(x1, '100', 'first axis read');
    t.equal(y1, '200', 'second axis read');
    t.equal(commands.length, 1, 'warmup merged into one round trip');

    await wait(60);
    values['adc4.read()'] = '101';
    values['adc5.read()'] = '201';

    const x2 = await peripheral.readLiveString('adc4.read()');
    t.equal(x2, '101', 'expired read went to the board');
    t.equal(commands.length, 2, 'one more round trip');
    t.ok(commands[1].startsWith('_r=[]'), 'ride-along made it a batched command');
    t.ok(commands[1].includes('adc5.read()'), 'hot expression rode along');

    const y2 = await peripheral.readLiveString('adc5.read()');
    t.equal(y2, '201', 'ride-along value served from the cache');
    t.equal(commands.length, 2, 'second axis cost no extra round trip');
    t.end();
});

test('ride-alongs respect the batch expression limit', async t => {
    const values = {};
    const names = [];
    for (let i = 0; i < 30; i++) {
        const expression = `adc${i}.read()`;
        names.push(expression);
        values[expression] = String(i);
    }
    const {peripheral, commands} = makeReadPeripheral(values);

    await Promise.all(names.map(expression => peripheral.readLiveString(expression)));
    await wait(60);
    commands.length = 0;

    const value = await peripheral.readLiveString('adc0.read()');
    t.equal(value, '0', 'requested read answered');
    t.equal(commands.length, 1, 'one round trip');
    t.equal((commands[0].match(/lambda:/g) || []).length, 24,
        'ride-alongs fill the batch only up to the limit');
    t.ok(commands[0].includes('adc0.read()'), 'the real read is aboard');
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
    const {peripheral, commands} = makeReadPeripheral({'adc4.read()': '7'});

    const v1 = await peripheral.readLiveString('adc4.read()');
    await wait(60);
    const v2 = await peripheral.readLiveString('adc4.read()');
    t.equal(v1, '7', 'first read answered');
    t.equal(v2, '7', 'second read answered');
    t.same(commands, ['print(adc4.read())', 'print(adc4.read())'],
        'a single expression with nothing to ride along never batches');
    t.end();
});

test('sequential two-axis polling costs about one round trip per iteration at high RTT', async t => {
    const {peripheral, commands} = makeReadPeripheral({
        'adc4.read()': '1872',
        'adc5.read()': '1904'
    }, {latency: 100});

    const iterations = 6;
    for (let i = 0; i < iterations; i++) {
        const x = await peripheral.readLiveString('adc4.read()');
        const y = await peripheral.readLiveString('adc5.read()');
        t.equal(x, '1872', `iteration ${i} first axis answered`);
        t.equal(y, '1904', `iteration ${i} second axis answered`);
        // Frame gap; also lets the read cache expire like a real loop.
        await wait(60);
    }
    // The first iteration pays two round trips (nothing is hot yet),
    // every following one shares a single round trip between both axes
    // thanks to the ride-along refresh. The old to-the-window flush cost
    // two round trips per iteration on a high-RTT link.
    t.equal(commands.length, iterations + 1,
        `${commands.length} round trips for ${iterations} two-axis iterations`);
    t.end();
});
