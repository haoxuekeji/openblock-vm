const tap = require('tap');

const WebSerial = require('../../src/io/webserial');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const tick = () => new Promise(resolve => setImmediate(resolve));

const EVENTS = {
    PERIPHERAL_CONNECTED: 'PERIPHERAL_CONNECTED',
    PERIPHERAL_DISCONNECTED: 'PERIPHERAL_DISCONNECTED',
    PERIPHERAL_CONNECTION_LOST_ERROR: 'PERIPHERAL_CONNECTION_LOST_ERROR',
    PERIPHERAL_REQUEST_ERROR: 'PERIPHERAL_REQUEST_ERROR',
    PERIPHERAL_LIST_UPDATE: 'PERIPHERAL_LIST_UPDATE'
};

const makeRuntime = () => {
    const emitted = [];
    return {
        emitted,
        constructor: EVENTS,
        emit (...args) {
            emitted.push(args);
        }
    };
};

/**
 * Fake Web Serial SerialPort: reads block until cancelled, opens/closes
 * are counted, writes recorded.
 * @return {{port: object, state: object}} - the fake and its state.
 */
const makeFakePort = () => {
    const state = {opens: 0, closes: 0, isOpen: false, written: [], openArgs: null, failNextOpen: false};
    let pendingRead = null;
    const port = {
        open (options) {
            if (state.failNextOpen) {
                state.failNextOpen = false;
                return Promise.reject(new Error('InvalidStateError: port already open'));
            }
            state.opens++;
            state.openArgs = options;
            state.isOpen = true;
            return Promise.resolve();
        },
        close () {
            state.closes++;
            state.isOpen = false;
            return Promise.resolve();
        },
        readable: {
            getReader () {
                return {
                    read: () => new Promise(resolve => {
                        pendingRead = resolve;
                    }),
                    cancel () {
                        if (pendingRead) {
                            pendingRead({done: true});
                            pendingRead = null;
                        }
                        return Promise.resolve();
                    },
                    releaseLock () {}
                };
            }
        },
        writable: {
            getWriter () {
                return {
                    write (data) {
                        state.written.push(data);
                        return Promise.resolve();
                    },
                    releaseLock () {}
                };
            }
        }
    };
    return {port, state};
};

// Node ships a read-only global navigator without .serial; replace it so
// the transport's event listener wiring works like in a browser.
Object.defineProperty(global, 'navigator', {
    value: {
        serial: {
            addEventListener () {},
            removeEventListener () {}
        }
    },
    configurable: true,
    writable: true
});

const makeConnectedSerial = async () => {
    const runtime = makeRuntime();
    const serial = new WebSerial(runtime, 'dev', {baudRate: 115200}, null, null, () => {});
    const {port, state} = makeFakePort();
    serial._port = port;
    serial.connectPeripheral();
    await tick();
    return {serial, port, state, runtime};
};

test('lendPort stops the read loop, closes the port and hands it over', async t => {
    const {serial, port, state} = await makeConnectedSerial();
    t.ok(serial.isConnected(), 'connected after open');
    t.equal(state.opens, 1, 'port opened once for the REPL');

    const lent = await serial.lendPort();
    t.equal(lent, port, 'the underlying SerialPort is handed over');
    t.equal(state.closes, 1, 'port closed before the handover');
    t.ok(serial.isConnected(), 'logical connection state survives the lend');

    await serial.write(new Uint8Array([1]));
    t.same(state.written, [], 'writes are dropped while lent');

    await t.rejects(serial.lendPort(), /already lent/, 'double lend is rejected');

    serial.disconnect();
    t.end();
});

test('reclaimPort reopens the port and restores writing', async t => {
    const {serial, state} = await makeConnectedSerial();
    await serial.lendPort();

    await serial.reclaimPort();
    t.equal(state.opens, 2, 'port reopened on reclaim');
    t.equal(state.openArgs.baudRate, 115200, 'reopened at the REPL baud rate');

    await serial.write(new Uint8Array([2]));
    t.equal(state.written.length, 1, 'writes flow again after reclaim');

    serial.disconnect();
    t.end();
});

test('reclaimPort closes and reopens when the borrower left the port open', async t => {
    const {serial, state} = await makeConnectedSerial();
    await serial.lendPort();

    // Borrower (esptool-js transport) failed before closing the port.
    state.failNextOpen = true;
    await serial.reclaimPort();
    t.equal(state.closes, 2, 'stuck port closed once more before the reopen');
    t.equal(state.opens, 2, 'port reopened after the fallback close');

    serial.disconnect();
    t.end();
});
