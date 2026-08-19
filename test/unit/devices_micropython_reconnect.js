const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = () => {
    const events = [];
    return {
        constructor: {
            PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
            PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
            PERIPHERAL_RECONNECTING: 'PERIPHERAL_RECONNECTING',
            PERIPHERAL_CONNECTION_LOST_ERROR: 'PERIPHERAL_CONNECTION_LOST_ERROR',
            PERIPHERAL_REQUEST_ERROR: 'PERIPHERAL_REQUEST_ERROR'
        },
        events,
        emit (name, data) {
            events.push({name, data});
        },
        on () {},
        removeListener () {},
        registerPeripheralExtension () {},
        isRealtimeMode: () => true
    };
};

/**
 * Build a peripheral wired to a stateful fake BLE backend. The backend
 * runs the peripheral connect callback on connectPeripheral like the
 * real Web Bluetooth backend does.
 * @param {object} options - behavior switches.
 * @param {number} options.failConnects - reject this many connect attempts.
 * @return {{peripheral: MicroPythonBlePeripheral, ble: object, runtime: object}} -
 *   the assembled test fixture.
 */
const makeFixture = (options = {}) => {
    const runtime = makeRuntime();
    const peripheral = new MicroPythonBlePeripheral(
        runtime, 'dev', 'dev', {register: false}
    );
    peripheral._peripheralId = 'board-1';
    let failConnects = options.failConnects || 0;
    const ble = {
        connected: false,
        connectCalls: 0,
        disconnectCalls: [],
        connectPeripheral () {
            this.connectCalls++;
            if (failConnects > 0) {
                failConnects--;
                return Promise.reject(new Error('still rebooting'));
            }
            this.connected = true;
            return Promise.resolve(peripheral._onConnect()).then(() => true);
        },
        disconnect (opts = {}) {
            this.disconnectCalls.push(opts === true || opts.silent === true);
            this.connected = false;
        },
        isConnected () {
            return this.connected;
        },
        startNotifications () {
            return Promise.resolve();
        },
        expectDisconnect () {}
    };
    peripheral._ble = ble;
    ble.connected = true;
    return {peripheral, ble, runtime};
};

test('an unexpected drop reconnects silently and rebuilds the live session', async t => {
    const {peripheral, ble, runtime} = makeFixture();
    let liveEntries = 0;
    peripheral._enterLiveMode = () => {
        liveEntries++;
        peripheral._liveReady = true;
        return Promise.resolve();
    };

    ble.connected = false;
    await peripheral._handleConnectionDrop();
    await peripheral._liveQueue;

    t.equal(ble.connectCalls, 1, 'reconnected on the first attempt');
    t.ok(runtime.events.some(e => e.name === 'PERIPHERAL_RECONNECTING'),
        'reconnecting event emitted');
    t.notOk(runtime.events.some(e => e.name === 'PERIPHERAL_CONNECTION_LOST_ERROR'),
        'no lost-connection error emitted');
    t.notOk(peripheral._connectionDropped, 'drop flag cleared by the new session');
    t.equal(liveEntries, 1, 'live session rebuilt after the reconnect');
    t.end();
});

test('the reconnect loop retries until the board is back', async t => {
    const {peripheral, ble} = makeFixture({failConnects: 1});
    peripheral._enterLiveMode = () => Promise.resolve();

    ble.connected = false;
    const connected = await peripheral._reconnect({
        initialDelayMs: 0,
        shouldContinue: () => true
    });

    t.ok(connected, 'reconnect eventually succeeded');
    t.equal(ble.connectCalls, 2, 'first failed attempt was retried');
    t.end();
});

test('in-flight live exchanges fail fast when the link drops', async t => {
    const {peripheral, ble} = makeFixture();
    peripheral._liveReady = true;
    peripheral._writeRaw = () => Promise.resolve(); // the board never answers

    const started = Date.now();
    const pending = peripheral.execLive('p4.value(1)'); // 5s default timeout
    await new Promise(resolve => setTimeout(resolve, 20));

    ble.connected = false;
    peripheral._reconnect = () => Promise.resolve(false); // stay offline
    await peripheral._handleConnectionDrop();
    const output = await pending;

    t.equal(output, null, 'command reported as failed');
    t.ok(Date.now() - started < 2000, 'failed well before the REPL timeout');
    t.end();
});

test('giving up publishes the connection loss once', async t => {
    const {peripheral, ble, runtime} = makeFixture();
    peripheral._reconnect = () => Promise.resolve(false);

    ble.connected = false;
    await peripheral._handleConnectionDrop();

    const lost = runtime.events.filter(e => e.name === 'PERIPHERAL_CONNECTION_LOST_ERROR');
    t.equal(lost.length, 1, 'exactly one lost-connection error');
    t.equal(lost[0].data.deviceId, 'dev', 'error carries the device id');
    t.ok(ble.disconnectCalls.includes(false),
        'disconnected state published (non-silent)');
    t.notOk(peripheral._connectionDropped, 'drop flag cleared after giving up');
    t.end();
});

test('a user rescan during the reconnect keeps the failure silent', async t => {
    const {peripheral, ble, runtime} = makeFixture();
    peripheral._reconnect = () => {
        // scan()/reset() clears the flag when the user picks a new device.
        peripheral._connectionDropped = false;
        return Promise.resolve(false);
    };

    ble.connected = false;
    await peripheral._handleConnectionDrop();

    t.notOk(runtime.events.some(e => e.name === 'PERIPHERAL_CONNECTION_LOST_ERROR'),
        'no lost-connection error emitted');
    t.equal(ble.disconnectCalls.length, 0, 'the new scan object is left alone');
    t.end();
});

test('every new GATT session re-probes the ATT MTU', async t => {
    const {peripheral} = makeFixture();
    peripheral._enterLiveMode = () => Promise.resolve();
    peripheral._bleMtuProbed = true;
    peripheral._bleChunkSize = 514;

    await peripheral._onConnect();

    t.notOk(peripheral._bleMtuProbed, 'MTU probe re-armed');
    t.equal(peripheral._bleChunkSize, 20, 'writes fall back to the safe chunk size');
    t.end();
});
