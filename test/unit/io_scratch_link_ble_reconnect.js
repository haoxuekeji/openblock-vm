const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

// Browser globals the BLE backends touch. Installed before the module
// under test is loaded.
if (!global.window) {
    global.window = {};
}
global.window.setTimeout = setTimeout.bind(global);
global.window.clearTimeout = clearTimeout.bind(global);
if (!global.navigator) {
    global.navigator = {};
}

const {ScratchLinkBLE} = require('../../src/io/ble');

const EVENTS = {
    PERIPHERAL_LIST_UPDATE: 'PERIPHERAL_LIST_UPDATE',
    USER_PICKED_PERIPHERAL: 'USER_PICKED_PERIPHERAL',
    PERIPHERAL_SCAN_TIMEOUT: 'PERIPHERAL_SCAN_TIMEOUT',
    PERIPHERAL_CONNECTED: 'PERIPHERAL_CONNECTED',
    PERIPHERAL_DISCONNECTED: 'PERIPHERAL_DISCONNECTED',
    PERIPHERAL_CONNECTION_LOST_ERROR: 'PERIPHERAL_CONNECTION_LOST_ERROR',
    PERIPHERAL_REQUEST_ERROR: 'PERIPHERAL_REQUEST_ERROR'
};

/**
 * A fake ScratchLinkSocket backed by a scriptable fake Link server.
 * @param {object} server - the fake link server this socket talks to.
 */
class FakeLinkSocket {
    constructor (server) {
        this._server = server;
        this._onOpen = null;
        this._onClose = null;
        this._onError = null;
        this._handleMessage = null;
        this._open = false;
        this.closedByClient = false;
    }
    setOnOpen (fn) {
        this._onOpen = fn;
    }
    setOnClose (fn) {
        this._onClose = fn;
    }
    setOnError (fn) {
        this._onError = fn;
    }
    setHandleMessage (fn) {
        this._handleMessage = fn;
    }
    isOpen () {
        return this._open;
    }
    open () {
        setImmediate(() => {
            if (this._server.reachable) {
                this._open = true;
                this._server.attach(this);
                this._onOpen();
            } else {
                this._onError(new Error('connection refused'));
                this._onClose();
            }
        });
    }
    close () {
        if (!this._open) return;
        this._open = false;
        this.closedByClient = true;
        this._server.detach(this);
        setImmediate(() => this._onClose());
    }
    // Called by the server to simulate a close from the Link side.
    serverClose () {
        if (!this._open) return;
        this._open = false;
        setImmediate(() => this._onClose());
    }
    sendMessage (message) {
        if (!this._open) return;
        this._server.receive(this, message);
    }
    // Called by the server to push a message to the client.
    push (message) {
        setImmediate(() => this._handleMessage(message));
    }
}

/**
 * A scriptable fake Link BLE server: answers discover/connect and lets
 * tests control whether the board is advertising or connectable.
 */
class FakeLinkServer {
    constructor () {
        this.reachable = true;
        this.advertising = true;
        this.peripheralId = 'aa:bb:cc';
        this.connectError = null;
        this.discoverCount = 0;
        this.connectCount = 0;
        this.sockets = [];
    }
    attach (socket) {
        this.sockets.push(socket);
    }
    detach (socket) {
        this.sockets = this.sockets.filter(item => item !== socket);
    }
    receive (socket, message) {
        const {id, method} = message;
        if (method === 'discover') {
            this.discoverCount++;
            socket.push({jsonrpc: '2.0', id, result: null});
            if (this.advertising) {
                socket.push({
                    jsonrpc: '2.0',
                    method: 'didDiscoverPeripheral',
                    params: {peripheralId: this.peripheralId, name: 'OB32-test', rssi: -42}
                });
            }
            return;
        }
        if (method === 'connect') {
            this.connectCount++;
            if (this.connectError) {
                socket.push({jsonrpc: '2.0', id, error: {message: this.connectError}});
            } else {
                socket.push({jsonrpc: '2.0', id, result: null});
            }
            return;
        }
        if (method === 'write') {
            socket.push({jsonrpc: '2.0', id, result: 3});
            return;
        }
        if (typeof id !== 'undefined' && id !== null) {
            socket.push({jsonrpc: '2.0', id, result: null});
        }
    }
    closeAll () {
        this.sockets.slice().forEach(socket => socket.serverClose());
        this.sockets = [];
    }
}

const makeRuntime = (server, events) => ({
    constructor: EVENTS,
    emit (name, data) {
        events.push({name, data});
    },
    getScratchLinkSocket () {
        return new FakeLinkSocket(server);
    }
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const eventNames = events => events.map(event => event.name);

const makeBackend = (server, events, options = {}) => {
    const runtime = makeRuntime(server, events);
    const backend = new ScratchLinkBLE(
        runtime, 'testDevice', {filters: [{services: ['6e400001']}]},
        options.connectCallback || (() => Promise.resolve()),
        options.resetCallback || null,
        Object.assign({rediscoverTimeout: 300, notificationSetupTimeout: 300}, options.options)
    );
    return backend;
};

test('discover reports the board and connect resolves true, emits connected', async t => {
    const server = new FakeLinkServer();
    const events = [];
    let connectCallbackRuns = 0;
    const backend = makeBackend(server, events, {
        connectCallback: () => {
            connectCallbackRuns++;
            return Promise.resolve();
        }
    });
    await wait(50);
    t.ok(eventNames(events).includes('PERIPHERAL_LIST_UPDATE'), 'scan list published');

    const connected = await backend.connectPeripheral(server.peripheralId);
    t.equal(connected, true, 'connect resolves true');
    t.equal(backend.isConnected(), true, 'backend connected');
    t.equal(connectCallbackRuns, 1, 'notification setup ran');
    t.ok(eventNames(events).includes('PERIPHERAL_CONNECTED'), 'connected event emitted');
    t.end();
});

test('expected disconnect (board reboot) does not raise the lost error', async t => {
    const server = new FakeLinkServer();
    const events = [];
    const backend = makeBackend(server, events);
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    backend.expectDisconnect();
    server.closeAll();
    await wait(50);

    t.equal(backend.isConnected(), false, 'backend no longer connected');
    t.notOk(eventNames(events).includes('PERIPHERAL_CONNECTION_LOST_ERROR'),
        'no connection lost error for a planned reboot');
    t.notOk(eventNames(events).includes('PERIPHERAL_DISCONNECTED'),
        'no disconnected event either (owner drives the reconnect)');
    t.end();
});

test('unexpected close hands the loss to onUnexpectedDisconnect', async t => {
    const server = new FakeLinkServer();
    const events = [];
    let drops = 0;
    const backend = makeBackend(server, events, {
        options: {
            onUnexpectedDisconnect: () => {
                drops++;
            }
        }
    });
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    server.closeAll();
    await wait(50);

    t.equal(drops, 1, 'owner notified once');
    t.notOk(eventNames(events).includes('PERIPHERAL_CONNECTION_LOST_ERROR'),
        'no lost error while the owner retries');
    t.end();
});

test('unexpected close without a handler keeps the legacy lost error', async t => {
    const server = new FakeLinkServer();
    const events = [];
    let resets = 0;
    const backend = makeBackend(server, events, {
        resetCallback: () => {
            resets++;
        }
    });
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    server.closeAll();
    await wait(50);

    t.equal(resets, 1, 'reset callback ran');
    t.ok(eventNames(events).includes('PERIPHERAL_CONNECTION_LOST_ERROR'), 'lost error emitted');
    t.end();
});

test('silent reconnect after the server closed the session reopens and rediscovers', async t => {
    const server = new FakeLinkServer();
    const events = [];
    let connectCallbackRuns = 0;
    const backend = makeBackend(server, events, {
        connectCallback: () => {
            connectCallbackRuns++;
            return Promise.resolve();
        }
    });
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    // The board reboots: the Link server closes the session socket.
    backend.expectDisconnect();
    server.closeAll();
    await wait(50);
    t.equal(backend.isConnected(), false, 'session dropped');

    events.length = 0;
    const reconnected = await backend.connectPeripheral(server.peripheralId, {silent: true});
    t.equal(reconnected, true, 'silent reconnect resolves true');
    t.equal(backend.isConnected(), true, 'backend connected again');
    t.equal(server.discoverCount, 2, 'a new discovery ran on the fresh session');
    t.equal(connectCallbackRuns, 2, 'notification setup ran again');
    t.ok(eventNames(events).includes('PERIPHERAL_CONNECTED'), 'connected event emitted for the GUI');
    t.notOk(eventNames(events).includes('PERIPHERAL_LIST_UPDATE'),
        'no scan list updates during the silent reconnect');
    t.end();
});

test('silent reconnect rejects when the board never advertises again', async t => {
    const server = new FakeLinkServer();
    const events = [];
    const backend = makeBackend(server, events);
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    backend.expectDisconnect();
    server.closeAll();
    await wait(50);

    server.advertising = false;
    events.length = 0;
    await t.rejects(
        backend.connectPeripheral(server.peripheralId, {silent: true}),
        /did not advertise/,
        'attempt rejects so the retry loop can count it'
    );
    t.equal(backend.isConnected(), false, 'still disconnected');
    t.equal(events.length, 0, 'no events emitted for a failed silent attempt');
    t.end();
});

test('silent reconnect rejects when the Link server is gone', async t => {
    const server = new FakeLinkServer();
    const events = [];
    const backend = makeBackend(server, events);
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    backend.expectDisconnect();
    server.closeAll();
    await wait(50);

    server.reachable = false;
    events.length = 0;
    await t.rejects(
        backend.connectPeripheral(server.peripheralId, {silent: true}),
        /socket closed/,
        'unreachable Link fails the attempt'
    );
    t.equal(events.length, 0, 'no events emitted for a failed silent attempt');
    t.end();
});

test('silent connect on a live session rediscovers when the id is stale', async t => {
    const server = new FakeLinkServer();
    const events = [];
    const backend = makeBackend(server, events);
    await wait(50);

    // The session socket is open, but the server answers the first
    // connect with "invalid peripheral ID" (fresh session state). Like
    // the real session, a discover refreshes the state and the retry
    // succeeds.
    server.connectError = `invalid peripheral ID: ${server.peripheralId}`;
    const originalReceive = server.receive.bind(server);
    server.receive = (socket, message) => {
        if (message.method === 'discover') {
            server.connectError = null;
        }
        originalReceive(socket, message);
    };

    const reconnected = await backend.connectPeripheral(server.peripheralId, {silent: true});
    t.equal(reconnected, true, 'reconnected after rediscovery');
    t.ok(server.connectCount >= 2, 'connect retried after rediscovery');
    t.end();
});

test('silent connect fails when the notification setup hangs', async t => {
    const server = new FakeLinkServer();
    const events = [];
    const backend = makeBackend(server, events, {
        connectCallback: () => new Promise(() => {})
    });
    await wait(50);

    await t.rejects(
        backend.connectPeripheral(server.peripheralId, {silent: true}),
        /notification setup timed out/,
        'half-open rx path fails the attempt'
    );
    t.equal(backend.isConnected(), false, 'attempt did not leave a half-connected state');
    t.end();
});

test('disconnect supports the silent option, requests reject on close', async t => {
    const server = new FakeLinkServer();
    const events = [];
    const backend = makeBackend(server, events);
    await wait(50);
    await backend.connectPeripheral(server.peripheralId);

    // A request stranded by the close must reject, not hang. The catch
    // is attached right away so the early rejection is never unhandled.
    server.receive = () => {};
    let writeError = null;
    const pendingWrite = backend.write('6e400001', '6e400002', 'AAA=', 'base64', false)
        .catch(err => {
            writeError = err;
        });

    events.length = 0;
    backend.disconnect({silent: true});
    await wait(50);
    t.notOk(eventNames(events).includes('PERIPHERAL_DISCONNECTED'),
        'silent disconnect emits nothing');
    await pendingWrite;
    t.match(`${writeError && writeError.message}`, /socket closed/, 'stranded request rejected');

    backend.disconnect();
    t.ok(eventNames(events).includes('PERIPHERAL_DISCONNECTED'),
        'normal disconnect still reports');
    t.end();
});
