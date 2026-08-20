const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

// Browser globals the WebBLE backend touches. Installed before the
// module under test is loaded.
const storage = {};
global.window = {
    localStorage: {
        getItem: key => {
            return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
        },
        setItem: (key, value) => {
            storage[key] = String(value);
        }
    },
    setTimeout: setTimeout.bind(global),
    clearTimeout: clearTimeout.bind(global)
};
global.navigator = {bluetooth: {}};

const {WebBLE} = require('../../src/io/ble');

const makeRuntime = events => ({
    constructor: {
        PERIPHERAL_LIST_UPDATE: 'PERIPHERAL_LIST_UPDATE',
        PERIPHERAL_CONNECTED: 'PERIPHERAL_CONNECTED',
        PERIPHERAL_DISCONNECTED: 'PERIPHERAL_DISCONNECTED',
        PERIPHERAL_REQUEST_ERROR: 'PERIPHERAL_REQUEST_ERROR'
    },
    emit (name, data) {
        events.push({name, data});
    }
});

const makeDevice = id => ({
    id,
    name: `Board ${id}`,
    addEventListener () {},
    gatt: {
        connected: false,
        connect () {
            return Promise.reject(new Error('connect not stubbed'));
        },
        disconnect () {}
    }
});

const makeBackend = (events, deviceId, options = {}) => new WebBLE(
    makeRuntime(events), deviceId,
    {filters: [{services: ['abc']}]},
    () => Promise.resolve(), null, options
);

test('remembered granted device is reused without the chooser', async t => {
    const events = [];
    storage['openblock.webble.last.devA'] = 'dev-1';
    const granted = makeDevice('dev-1');
    let chooserOpened = false;
    global.navigator.bluetooth = {
        getDevices: () => Promise.resolve([makeDevice('dev-0'), granted]),
        requestDevice: () => {
            chooserOpened = true;
            return Promise.reject(new Error('chooser should not open'));
        }
    };

    const backend = makeBackend(events, 'devA');
    await backend.requestPeripheral();

    t.notOk(chooserOpened, 'no system chooser');
    const update = events.find(event => event.name === 'PERIPHERAL_LIST_UPDATE');
    t.ok(update, 'peripheral list published');
    t.ok(update.data['dev-1'], 'remembered device listed');
    t.equal(update.data['dev-1'].rememberedDevice, true, 'flagged for GUI auto connect');
    t.end();
});

test('chooser opens when nothing was remembered; the pick is remembered on connect', async t => {
    const events = [];
    const picked = makeDevice('dev-2');
    picked.gatt.connect = () => {
        picked.gatt.connected = true;
        return Promise.resolve({});
    };
    global.navigator.bluetooth = {
        getDevices: () => Promise.resolve([]),
        requestDevice: () => Promise.resolve(picked)
    };

    const backend = makeBackend(events, 'devB');
    await backend.requestPeripheral();
    const update = events.find(event => event.name === 'PERIPHERAL_LIST_UPDATE');
    t.ok(update.data['dev-2'], 'picked device listed');
    t.notOk(update.data['dev-2'].rememberedDevice, 'chooser pick needs the usual click');

    const connected = await backend.connectPeripheral('dev-2');
    t.equal(connected, true, 'connected');
    t.equal(storage['openblock.webble.last.devB'], 'dev-2',
        'device id remembered after a successful connection');
    t.end();
});

test('a failed silent reconnect falls back to the chooser on the next scan', async t => {
    const events = [];
    storage['openblock.webble.last.devC'] = 'dev-3';
    const offline = makeDevice('dev-3');
    offline.gatt.connect = () => Promise.reject(new Error('device unreachable'));
    let chooserOpens = 0;
    global.navigator.bluetooth = {
        getDevices: () => Promise.resolve([offline]),
        requestDevice: () => {
            chooserOpens++;
            return Promise.reject(new Error('user cancelled'));
        }
    };

    const backend = makeBackend(events, 'devC');
    await backend.requestPeripheral();
    t.equal(chooserOpens, 0, 'first scan used the silent path');
    const connected = await backend.connectPeripheral('dev-3');
    t.equal(connected, false, 'connect failed');

    // The next scan (new backend instance, same page session) must not
    // silently retry the unreachable device.
    const backend2 = makeBackend(events, 'devC');
    await backend2.requestPeripheral().catch(() => {});
    t.equal(chooserOpens, 1, 'second scan fell back to the chooser');

    // A successful connection through the chooser unblocks the silent
    // path again for future scans.
    const online = makeDevice('dev-3');
    online.gatt.connect = () => {
        online.gatt.connected = true;
        return Promise.resolve({});
    };
    global.navigator.bluetooth.requestDevice = () => Promise.resolve(online);
    const backend3 = makeBackend(events, 'devC');
    await backend3.requestPeripheral();
    await backend3.connectPeripheral('dev-3');
    const backend4 = makeBackend(events, 'devC');
    await backend4.requestPeripheral();
    t.equal(chooserOpens, 1, 'silent path usable again after a successful connect');
    t.end();
});

test('forceChooser (user rescans to switch boards) skips the silent path', async t => {
    const events = [];
    storage['openblock.webble.last.devD'] = 'dev-4';
    let chooserOpens = 0;
    global.navigator.bluetooth = {
        getDevices: () => Promise.resolve([makeDevice('dev-4')]),
        requestDevice: () => {
            chooserOpens++;
            return Promise.reject(new Error('user cancelled'));
        }
    };

    const backend = makeBackend(events, 'devD', {forceChooser: true});
    await backend.requestPeripheral().catch(() => {});
    t.equal(chooserOpens, 1, 'chooser shown despite a remembered device');
    t.end();
});

test('getDevices errors degrade to the chooser', async t => {
    const events = [];
    storage['openblock.webble.last.devE'] = 'dev-5';
    let chooserOpens = 0;
    global.navigator.bluetooth = {
        getDevices: () => Promise.reject(new Error('flag disabled')),
        requestDevice: () => {
            chooserOpens++;
            return Promise.reject(new Error('user cancelled'));
        }
    };

    const backend = makeBackend(events, 'devE');
    await backend.requestPeripheral().catch(() => {});
    t.equal(chooserOpens, 1, 'fell back to the chooser');
    t.end();
});
