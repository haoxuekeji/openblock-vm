const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

// Browser globals the WebBLE backend touches. Installed before the
// module under test is loaded.
const storage = {};
global.window = {
    localStorage: {
        getItem (key) {
            return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
        },
        setItem (key, value) {
            storage[key] = String(value);
        }
    },
    setTimeout: setTimeout.bind(global),
    clearTimeout: clearTimeout.bind(global)
};
global.navigator = {bluetooth: {}};
if (typeof global.atob !== 'function') {
    global.atob = base64 => Buffer.from(base64, 'base64').toString('binary');
}

const {WebBLE} = require('../../src/io/ble');

const makeRuntime = events => ({
    constructor: {
        PERIPHERAL_LIST_UPDATE: 'PERIPHERAL_LIST_UPDATE',
        PERIPHERAL_CONNECTED: 'PERIPHERAL_CONNECTED',
        PERIPHERAL_DISCONNECTED: 'PERIPHERAL_DISCONNECTED',
        PERIPHERAL_CONNECTION_LOST_ERROR: 'PERIPHERAL_CONNECTION_LOST_ERROR',
        PERIPHERAL_REQUEST_ERROR: 'PERIPHERAL_REQUEST_ERROR'
    },
    emit (name, data) {
        events.push({name, data});
    }
});

/**
 * A connectable fake device: gatt.connect resolves a server whose only
 * characteristic uses the injected writeValueWithoutResponse.
 * @param {string} id - device id.
 * @param {Function} writeImpl - writeValueWithoutResponse implementation.
 * @return {object} - the fake BluetoothDevice.
 */
const makeConnectableDevice = (id, writeImpl) => {
    const device = {
        id,
        name: `Board ${id}`,
        addEventListener () {},
        gatt: null
    };
    const characteristic = {
        addEventListener () {},
        startNotifications: () => Promise.resolve(),
        writeValueWithoutResponse: writeImpl,
        writeValueWithResponse: writeImpl
    };
    const server = {
        getPrimaryService: () => Promise.resolve({
            getCharacteristic: () => Promise.resolve(characteristic)
        })
    };
    device.gatt = {
        connected: false,
        disconnectCalls: 0,
        connect () {
            this.connected = true;
            return Promise.resolve(server);
        },
        disconnect () {
            this.disconnectCalls++;
            this.connected = false;
        }
    };
    return device;
};

const adopt = (events, device, {connectCallback, options}) => {
    global.navigator.bluetooth = {
        getDevices: () => Promise.resolve([]),
        requestDevice: () => Promise.resolve(device)
    };
    const backend = new WebBLE(
        makeRuntime(events), `dev-${device.id}`,
        {filters: [{services: ['abc']}]},
        connectCallback, null, options
    );
    return backend.requestPeripheral().then(() => backend);
};

test('a GATT write that never settles times out, tears the link down and rejects', async t => {
    const events = [];
    let unexpectedDisconnects = 0;
    const device = makeConnectableDevice('w1', () => new Promise(() => {}));
    const backend = await adopt(events, device, {
        connectCallback: () => Promise.resolve(),
        options: {
            gattWriteTimeout: 60,
            onUnexpectedDisconnect: () => {
                unexpectedDisconnects++;
            }
        }
    });
    t.equal(await backend.connectPeripheral(device.id), true, 'connected');

    const started = Date.now();
    await t.rejects(
        backend.write('svc', 'chr', Buffer.from('\r\x03\x03').toString('base64'), 'base64', false),
        /GATT write timed out/,
        'write rejects instead of pending forever'
    );
    t.ok(Date.now() - started < 2000, 'rejected via the write timeout');
    t.equal(backend.isConnected(), false, 'link torn down');
    t.equal(unexpectedDisconnects, 1, 'owner notified for automatic reconnect');
    t.end();
});

test('a silent reconnect with a hanging notification setup fails the attempt', async t => {
    const events = [];
    const device = makeConnectableDevice('n1', () => Promise.resolve());
    const backend = await adopt(events, device, {
        connectCallback: () => new Promise(() => {}),
        options: {silentNotificationSetupTimeout: 60}
    });

    await t.rejects(
        backend.connectPeripheral(device.id, {silent: true}),
        /notification setup timed out/,
        'half-open link is not accepted'
    );
    t.equal(backend.isConnected(), false, 'not connected');
    t.ok(device.gatt.disconnectCalls >= 1, 'wedged GATT connection dropped for a clean retry');
    t.end();
});

test('a user connect keeps the legacy bail-and-continue on slow notification setup', async t => {
    const events = [];
    const device = makeConnectableDevice('n2', () => Promise.resolve());
    const backend = await adopt(events, device, {
        connectCallback: () => new Promise(() => {}),
        options: {notificationSetupTimeout: 60}
    });

    t.equal(await backend.connectPeripheral(device.id), true, 'connect resolves');
    t.equal(backend.isConnected(), true, 'stays connected');
    t.ok(events.some(event => event.name === 'PERIPHERAL_CONNECTED'), 'connected event emitted');
    t.end();
});
