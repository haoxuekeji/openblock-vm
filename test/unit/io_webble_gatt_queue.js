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
if (typeof global.btoa !== 'function') {
    global.btoa = binary => Buffer.from(binary, 'binary').toString('base64');
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
 * Chrome's rejection for a read/write that overlaps another operation on
 * the same characteristic. The link itself stays up.
 * @return {Error} - the NetworkError.
 */
const inProgressError = () => Object.assign(
    new Error('GATT operation already in progress.'), {name: 'NetworkError'});

/**
 * A connectable fake device with one characteristic. Every GATT
 * operation is counted and, like Chrome, rejected when another one on
 * the characteristic is still pending.
 * @param {string} id - device id.
 * @param {object} impl - {write, read} implementations (both optional).
 * @return {object} - {device, characteristic, stats}.
 */
const makeConnectableDevice = (id, impl = {}) => {
    const stats = {inFlight: 0, maxInFlight: 0, writes: 0, reads: 0, listeners: 0};
    const guard = run => {
        if (stats.inFlight > 0) {
            return Promise.reject(inProgressError());
        }
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        return Promise.resolve()
            .then(run)
            .then(value => {
                stats.inFlight--;
                return value;
            }, error => {
                stats.inFlight--;
                throw error;
            });
    };
    const settleLater = value => new Promise(resolve => setTimeout(() => resolve(value), 15));
    const characteristic = {
        addEventListener () {
            stats.listeners++;
        },
        startNotifications: () => Promise.resolve(),
        writeValueWithoutResponse: data => {
            stats.writes++;
            return guard(() => {
                if (impl.write) return impl.write(data);
                return settleLater();
            });
        },
        readValue: () => {
            stats.reads++;
            return guard(() => {
                if (impl.read) return impl.read();
                return settleLater(new DataView(new Uint8Array([7]).buffer));
            });
        }
    };
    characteristic.writeValueWithResponse = characteristic.writeValueWithoutResponse;
    const server = {
        getPrimaryService: () => Promise.resolve({
            getCharacteristic: () => Promise.resolve(characteristic)
        })
    };
    const device = {
        id,
        name: `Hub ${id}`,
        addEventListener () {},
        gatt: {
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
        }
    };
    return {device, characteristic, stats};
};

const connect = async (events, device, options = {}) => {
    global.navigator.bluetooth = {
        getDevices: () => Promise.resolve([]),
        requestDevice: () => Promise.resolve(device)
    };
    const backend = new WebBLE(
        makeRuntime(events), `dev-${device.id}`,
        {filters: [{services: ['abc']}]},
        () => Promise.resolve(), null, options
    );
    await backend.requestPeripheral();
    if (await backend.connectPeripheral(device.id) !== true) {
        throw new Error('fake device did not connect');
    }
    return backend;
};

const payload = Buffer.from([5, 2, 1, 0]).toString('base64');
const lostEvents = events => events.filter(event =>
    event.name === 'PERIPHERAL_DISCONNECTED' || event.name === 'PERIPHERAL_CONNECTION_LOST_ERROR');

test('overlapping writes to one characteristic are serialized and keep the link', async t => {
    const events = [];
    const {device, stats} = makeConnectableDevice('q1');
    const backend = await connect(events, device);

    // The WeDo 2.0 stop button: stop tone + both motors off in one tick.
    const results = await Promise.all([
        backend.write('svc', 'out', payload, 'base64'),
        backend.write('svc', 'out', payload, 'base64'),
        backend.write('svc', 'out', payload, 'base64')
    ]);
    t.equal(results.length, 3, 'every write settled');
    t.equal(stats.writes, 3, 'every write reached the characteristic');
    t.equal(stats.maxInFlight, 1, 'never more than one GATT operation in flight');
    t.equal(backend.isConnected(), true, 'link kept');
    t.same(lostEvents(events), [], 'no disconnect reported');
    t.end();
});

test('reads and writes share the queue', async t => {
    const events = [];
    const {device, stats} = makeConnectableDevice('q2');
    const backend = await connect(events, device);

    const [written, read] = await Promise.all([
        backend.write('svc', 'out', payload, 'base64'),
        backend.read('svc', 'battery')
    ]);
    t.ok(written !== null, 'write settled');
    t.same(read, {message: Buffer.from([7]).toString('base64'), encoding: 'base64'}, 'read value delivered');
    t.equal(stats.maxInFlight, 1, 'the battery poll waited for the write');
    t.equal(backend.isConnected(), true, 'link kept');
    t.end();
});

test('a write rejected on a live link is not a connection loss', async t => {
    const events = [];
    let unexpectedDisconnects = 0;
    const {device} = makeConnectableDevice('q3', {
        write: () => Promise.reject(inProgressError())
    });
    const backend = await connect(events, device, {
        onUnexpectedDisconnect: () => {
            unexpectedDisconnects++;
        }
    });

    await t.rejects(
        backend.write('svc', 'out', payload, 'base64'),
        /already in progress/,
        'the failure is propagated to the caller'
    );
    t.equal(backend.isConnected(), true, 'link kept');
    t.equal(device.gatt.disconnectCalls, 0, 'GATT not torn down');
    t.equal(unexpectedDisconnects, 0, 'no reconnect triggered');
    t.same(lostEvents(events), [], 'no disconnect reported');

    // A read failing the same way is swallowed (legacy contract) and
    // equally harmless for the link.
    const {device: readDevice} = makeConnectableDevice('q3b', {
        read: () => Promise.reject(inProgressError())
    });
    const readEvents = [];
    const readBackend = await connect(readEvents, readDevice);
    t.equal(await readBackend.read('svc', 'battery'), undefined, 'read resolves empty');
    t.equal(readBackend.isConnected(), true, 'link kept after the failed read');
    t.end();
});

test('a write rejected because the GATT server dropped still tears the link down', async t => {
    const events = [];
    const holder = {};
    const failing = makeConnectableDevice('q4', {
        write: () => {
            // The link went away under the operation: the handle says so.
            holder.device.gatt.connected = false;
            return Promise.reject(Object.assign(
                new Error('GATT Server is disconnected. Cannot perform GATT operations.'),
                {name: 'NetworkError'}));
        }
    });
    holder.device = failing.device;
    const backend = await connect(events, failing.device);

    await t.rejects(backend.write('svc', 'out', payload, 'base64'), /disconnected/, 'write rejects');
    t.equal(backend.isConnected(), false, 'link torn down');
    t.ok(events.some(event => event.name === 'PERIPHERAL_CONNECTION_LOST_ERROR'), 'loss reported');
    t.end();
});

test('operations queued behind a torn down link fail fast', async t => {
    const events = [];
    const {device, stats} = makeConnectableDevice('q5');
    const backend = await connect(events, device);
    backend.disconnect();
    const disconnectEvents = lostEvents(events).length;

    await t.rejects(
        backend.write('svc', 'out', payload, 'base64'),
        /not connected/,
        'write rejects instead of touching a stale server'
    );
    t.equal(stats.writes, 0, 'nothing reached the characteristic');
    t.equal(lostEvents(events).length, disconnectEvents, 'no second disconnect reported');
    t.end();
});

test('re-subscribing to a characteristic attaches a single value listener', async t => {
    const events = [];
    const {device, stats} = makeConnectableDevice('q6');
    const backend = await connect(events, device);
    const received = [];
    const onChange = value => received.push(value);

    await backend.startNotifications('svc', 'in', onChange);
    await backend.startNotifications('svc', 'in', onChange);
    await backend.read('svc', 'in', true, onChange);
    t.equal(stats.listeners, 1, 'one listener for three subscriptions');
    t.end();
});
