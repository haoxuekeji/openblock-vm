const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

// Browser globals touched by the transport, installed before loading it.
global.navigator = {serial: {}};

const WebSerial = require('../../src/io/webserial');

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

const makePort = (vid, pid, openImpl) => ({
    getInfo: () => ({usbVendorId: vid, usbProductId: pid}),
    open: openImpl || (() => Promise.resolve()),
    close: () => Promise.resolve(),
    readable: null,
    writable: {getWriter: () => ({write: () => Promise.resolve(), releaseLock () {}})}
});

const FILTERS = [{usbVendorId: 0x1a86, usbProductId: 0x7523}, {usbVendorId: 0x10c4, usbProductId: 0xea60}];

const makeTransport = (events, deviceId = 'esp32') => new WebSerial(
    makeRuntime(events), deviceId, {baudRate: 115200, filters: FILTERS},
    () => null, () => null, () => null
);

const listUpdate = events => events.find(event => event.name === 'PERIPHERAL_LIST_UPDATE');

test('one granted matching port is reused without the chooser and flagged remembered', async t => {
    const events = [];
    let chooserOpened = false;
    global.navigator.serial = {
        getPorts: () => Promise.resolve([makePort(0x1a86, 0x7523), makePort(0x0403, 0x6001)]),
        requestPort: () => {
            chooserOpened = true;
            return Promise.reject(new Error('chooser should not open'));
        }
    };
    const transport = makeTransport(events, 'dev-reuse');
    await transport.requestPeripheral(false);
    t.notOk(chooserOpened, 'no system chooser');
    const update = listUpdate(events);
    t.ok(update, 'port published');
    t.equal(update.data['web-serial'].rememberedDevice, true, 'remembered flag set');
    t.notOk(update.data['web-serial'].autoConnect, 'no autoConnect flag on the silent path');
    t.equal(update.data['web-serial'].name, 'USB Serial (1A86:7523)');
    t.end();
});

test('several matching granted ports -> chooser, pick flagged autoConnect', async t => {
    const events = [];
    let chooserOpened = false;
    global.navigator.serial = {
        getPorts: () => Promise.resolve([makePort(0x1a86, 0x7523), makePort(0x10c4, 0xea60)]),
        requestPort: options => {
            chooserOpened = true;
            t.same(options.filters, FILTERS, 'chooser filtered by the device vid/pid');
            return Promise.resolve(makePort(0x10c4, 0xea60));
        }
    };
    const transport = makeTransport(events, 'dev-many');
    await transport.requestPeripheral(false);
    t.ok(chooserOpened, 'chooser opened');
    const update = listUpdate(events);
    t.equal(update.data['web-serial'].autoConnect, true, 'chooser pick connects without a tile click');
    t.notOk(update.data['web-serial'].rememberedDevice);
    t.end();
});

test('no matching granted port -> chooser; listAll drops the filters', async t => {
    const events = [];
    const seen = [];
    global.navigator.serial = {
        getPorts: () => Promise.resolve([makePort(0x0403, 0x6001)]),
        requestPort: options => {
            seen.push(options);
            return Promise.resolve(makePort(0x0403, 0x6001));
        }
    };
    const transport = makeTransport(events, 'dev-none');
    await transport.requestPeripheral(false);
    t.same(seen[0].filters, FILTERS, 'filtered chooser when nothing granted matches');
    await transport.requestPeripheral(true);
    t.notOk(seen[1].filters, 'listAll: unfiltered chooser');
    t.end();
});

test('forceChooser skips the granted-port path (refresh means pick again)', async t => {
    const events = [];
    let chooserOpened = false;
    global.navigator.serial = {
        getPorts: () => Promise.resolve([makePort(0x1a86, 0x7523)]),
        requestPort: () => {
            chooserOpened = true;
            return Promise.resolve(makePort(0x1a86, 0x7523));
        }
    };
    const transport = makeTransport(events, 'dev-force');
    await transport.requestPeripheral(false, {forceChooser: true});
    t.ok(chooserOpened, 'chooser opened despite a reusable granted port');
    t.end();
});

test('a reused port that fails to open blocks the silent path for the device', async t => {
    const events = [];
    let chooserOpened = 0;
    const busy = makePort(0x1a86, 0x7523, () => Promise.reject(new Error('Failed to open serial port')));
    global.navigator.serial = {
        getPorts: () => Promise.resolve([busy]),
        requestPort: () => {
            chooserOpened += 1;
            return Promise.resolve(busy);
        },
        addEventListener () {},
        removeEventListener () {}
    };
    const transport = makeTransport(events, 'dev-busy');
    await transport.requestPeripheral(false);
    t.equal(chooserOpened, 0, 'first scan silent');
    transport.connectPeripheral();
    await new Promise(resolve => setTimeout(resolve, 5));
    t.ok(events.find(event => event.name === 'PERIPHERAL_REQUEST_ERROR'), 'open failure reported');

    const again = makeTransport([], 'dev-busy');
    await again.requestPeripheral(false);
    t.equal(chooserOpened, 1, 'next scan for the same device opens the chooser');

    const other = makeTransport([], 'dev-other');
    await other.requestPeripheral(false);
    t.equal(chooserOpened, 1, 'other devices are unaffected');
    t.end();
});

test('getPorts unavailable or failing -> chooser', async t => {
    const events = [];
    let chooserOpened = 0;
    global.navigator.serial = {
        requestPort: () => {
            chooserOpened += 1;
            return Promise.resolve(makePort(0x1a86, 0x7523));
        }
    };
    await makeTransport(events, 'dev-old').requestPeripheral(false);
    t.equal(chooserOpened, 1, 'no getPorts: chooser');
    global.navigator.serial.getPorts = () => Promise.reject(new Error('nope'));
    await makeTransport(events, 'dev-err').requestPeripheral(false);
    t.equal(chooserOpened, 2, 'getPorts error: chooser');
    t.end();
});
