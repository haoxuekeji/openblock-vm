const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const makeRuntime = () => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
        PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA'
    },
    emit () {},
    on () {},
    removeListener () {},
    registerPeripheralExtension () {},
    isRealtimeMode: () => true
});

/**
 * Build a connected peripheral wired to a fake board that answers the
 * live-mode handshake, with fast watchdog thresholds for the test.
 * @return {{peripheral: MicroPythonBlePeripheral, writes: Array.<string>}} -
 *   the peripheral under test and the list of written raw texts.
 */
const makeStalledPeripheral = () => {
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(), 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._liveWatchdogIntervalMs = 10;
    peripheral._liveWatchdogStallMs = 30;
    const writes = [];
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        writes.push(text);
        const reply = answer => peripheral._routeIncoming(Buffer.from(answer, 'latin1'));
        if (text === '\r\x01') {
            reply('raw REPL; CTRL-B to exit\r\n>');
        } else if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            reply('OK\x04\x04>');
        }
        return Promise.resolve();
    };
    return {peripheral, writes};
};

test('watchdog rebuilds a live session stalled while connected in realtime mode', async t => {
    const {peripheral, writes} = makeStalledPeripheral();
    t.notOk(peripheral._liveReady, 'session starts stalled');

    peripheral._startLiveWatchdog();
    // Stall detection (~40ms) + interrupt drain (~350ms) + handshake.
    await wait(800);

    t.ok(peripheral._liveReady, 'watchdog re-entered live mode');
    t.equal(writes.filter(text => text === '\r\x01').length, 1,
        'exactly one raw REPL re-entry, no stacking while recovering');
    t.notOk(peripheral._liveWatchdogRecovering, 'recovery flag cleared');

    const before = writes.length;
    await wait(120);
    t.equal(writes.length, before, 'no re-entry once the session is up');

    peripheral.reset();
    t.equal(peripheral._liveWatchdogTimer, null, 'reset stops the watchdog');
    t.end();
});

test('watchdog stays quiet while the channel is legitimately busy', async t => {
    const {peripheral, writes} = makeStalledPeripheral();

    // A board-fs command / handshake in flight keeps capture depth > 0.
    peripheral._replCaptureDepth = 1;
    peripheral._startLiveWatchdog();
    await wait(120);
    t.same(writes, [], 'no recovery while a REPL exchange is capturing');
    t.equal(peripheral._liveStalledSince, null, 'stall clock not running');

    // An upload owns the channel exclusively.
    peripheral._replCaptureDepth = 0;
    peripheral._uploading = true;
    await wait(120);
    t.same(writes, [], 'no recovery while uploading');

    // A healthy session never triggers the watchdog.
    peripheral._uploading = false;
    peripheral._liveReady = true;
    await wait(120);
    t.same(writes, [], 'no recovery when the session is ready');

    peripheral.reset();
    t.end();
});

test('watchdog stays quiet in upload program mode and when disconnected', async t => {
    const {peripheral, writes} = makeStalledPeripheral();

    peripheral._runtime.isRealtimeMode = () => false;
    peripheral._startLiveWatchdog();
    await wait(120);
    t.same(writes, [], 'no recovery outside realtime mode');

    peripheral._runtime.isRealtimeMode = () => true;
    peripheral.isConnected = () => false;
    await wait(120);
    t.same(writes, [], 'no recovery without a connection');

    peripheral.reset();
    t.end();
});
