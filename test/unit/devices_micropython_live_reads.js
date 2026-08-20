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

/**
 * Build a live peripheral wired to a fake board that answers read
 * commands from a value table: batched commands get their lambda
 * expressions looked up and joined with the record separator, plain
 * print commands get the single value.
 * @param {object} values - expression -> reply value (string).
 * @return {{peripheral: MicroPythonBlePeripheral, commands: Array.<string>}} -
 *   the peripheral and the raw REPL commands the board received.
 */
const makeReadPeripheral = values => {
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(), 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._liveReady = true;
    const commands = [];
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        const reply = answer => peripheral._routeIncoming(Buffer.from(answer, 'latin1'));
        if (!text.endsWith('\x04') || text.startsWith('\x05')) return Promise.resolve();
        const command = text.slice(0, -1);
        commands.push(command);
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
        reply(`OK${stdout}\x04\x04>`);
        return Promise.resolve();
    };
    return {peripheral, commands};
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
