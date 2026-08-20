const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = events => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
        PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
        PERIPHERAL_LIVE_UNAVAILABLE: 'PERIPHERAL_LIVE_UNAVAILABLE',
        PERIPHERAL_LIVE_AVAILABLE: 'PERIPHERAL_LIVE_AVAILABLE'
    },
    emit (name) {
        events.push(name);
    },
    on () {},
    removeListener () {},
    registerPeripheralExtension () {},
    isRealtimeMode: () => true
});

/**
 * Build a connected peripheral wired to a fake board that answers the
 * live handshake, recording every runtime event emission.
 * @return {{peripheral: MicroPythonBlePeripheral, events: Array.<string>}} -
 *   the peripheral under test and the emitted runtime event names.
 */
const makePeripheral = () => {
    const events = [];
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(events), 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        const reply = answer => peripheral._routeIncoming(Buffer.from(answer, 'latin1'));
        if (text === '\r\x01') {
            reply('raw REPL; CTRL-B to exit\r\n>');
        } else if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            reply('OK\x04\x04>');
        }
        return Promise.resolve();
    };
    return {peripheral, events};
};

const countOf = (events, name) => events.filter(event => event === name).length;

test('null returning blocks raise a throttled live-unavailable hint', async t => {
    const {peripheral, events} = makePeripheral();
    t.notOk(peripheral._liveReady, 'session starts down');

    const first = await peripheral.execLive('p4.value(1)');
    t.equal(first, null, 'command reports null');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_UNAVAILABLE'), 1, 'hint emitted');

    await peripheral.execLive('p4.value(1)');
    await peripheral.execLive('p4.value(1)');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_UNAVAILABLE'), 1,
        'immediate repeats are throttled');

    // The live session comes back: the hint must be withdrawn once.
    await peripheral._enterLiveMode();
    t.equal(countOf(events, 'PERIPHERAL_LIVE_AVAILABLE'), 1, 'recovery clears the hint');

    const output = await peripheral.execLive('p4.value(1)');
    t.equal(output, '', 'commands work again');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_UNAVAILABLE'), 1, 'no further hint while healthy');
    t.end();
});

test('no hint when disconnected, in upload mode or without a prior hint', async t => {
    const {peripheral, events} = makePeripheral();

    peripheral.isConnected = () => false;
    await peripheral.execLive('p4.value(1)');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_UNAVAILABLE'), 0,
        'plain disconnect has its own GUI state');

    peripheral.isConnected = () => true;
    peripheral._runtime.isRealtimeMode = () => false;
    await peripheral.execLive('p4.value(1)');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_UNAVAILABLE'), 0, 'quiet outside realtime mode');

    // A healthy session entering live mode owes no AVAILABLE event.
    peripheral._runtime.isRealtimeMode = () => true;
    await peripheral._enterLiveMode();
    t.equal(countOf(events, 'PERIPHERAL_LIVE_AVAILABLE'), 0, 'no unsolicited all-clear');
    t.end();
});

test('a protocol-level live failure raises the hint before recovery', async t => {
    const {peripheral, events} = makePeripheral();
    peripheral._liveReady = true;
    let dropReplies = 1;
    const baseWrite = peripheral._writeRaw;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        if (dropReplies > 0 && text.endsWith('\x04') && !text.startsWith('\x05') && text !== '\r\x01') {
            dropReplies--;
            return Promise.resolve();
        }
        return baseWrite(buffer);
    };

    const failed = await peripheral.execLive('p4.value(1)', 50);
    t.equal(failed, null, 'timed out command reports null');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_UNAVAILABLE'), 1, 'hint raised on the failure');
    t.ok(peripheral._liveReady, 'session recovered');
    t.equal(countOf(events, 'PERIPHERAL_LIVE_AVAILABLE'), 1, 'hint withdrawn after recovery');
    t.end();
});
