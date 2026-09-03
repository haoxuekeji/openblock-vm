const tap = require('tap');

const OpenBlockMicroPythonEsp32Device = require(
    '../../src/devices/microPythonEsp32/microPythonEsp32'
);
const OpenBlockMicroPythonEsp32C3Device = require(
    '../../src/devices/microPythonEsp32C3/microPythonEsp32C3'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = () => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE'
    },
    peripheralExtensions: {},
    emit () {},
    on () {},
    removeListener () {},
    registerPeripheralExtension (deviceId, peripheral) {
        this.peripheralExtensions[deviceId] = peripheral;
    },
    setRealtimeBaudrate () {}
});

const flushMicrotasks = () => new Promise(resolve => setImmediate(resolve));

const makeLivePeripheral = readValue => ({
    isReady: () => true,
    execLive: () => Promise.resolve(''),
    readDigitalPin: () => Promise.resolve(readValue.value)
});

test('pin event hat is registered as a HAT block in the pin category', t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const info = device.getInfo();
    const pinCategory = info.find(category => category.id === 'pin');

    const hat = pinCategory.blocks.find(block => block.opcode === 'whenPinLevel');
    t.ok(hat, 'whenPinLevel block present');
    t.equal(hat.blockType, 'hat', 'block is a hat');
    t.equal(hat.arguments.PIN.menu, 'pins', 'pin argument uses the pin menu');
    t.equal(hat.arguments.LEVEL.menu, 'levelDetect', 'level argument uses the field-only menu');
    t.ok(pinCategory.menus.levelDetect, 'field-only level menu registered');
    t.notOk(pinCategory.menus.levelDetect.acceptReporters,
        'hat level menu takes no reporter inputs');
    t.end();
});

test('pin event hat is inherited by the chip variants', t => {
    const device = new OpenBlockMicroPythonEsp32C3Device(makeRuntime(), 'microPythonEsp32C3');
    const info = device.getInfo();
    const pinCategory = info.find(category => category.id === 'pin');

    t.ok(pinCategory.blocks.find(block => block.opcode === 'whenPinLevel'),
        'whenPinLevel present on the C3 variant');
    t.end();
});

test('whenPinLevel predicate answers from the sampled level', async t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const readValue = {value: true};
    device._peripheral = makeLivePeripheral(readValue);

    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), false,
        'no sample yet on the first poll');

    await flushMicrotasks();
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), true,
        'high sample matches level 1');
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '0'}), false,
        'high sample does not match level 0');

    // The predicate answers from the previous sample: one poll after the
    // level flip still reports the stale level while the refresh with the
    // new level is in flight, the next poll sees it.
    readValue.value = false;
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '0'}), false,
        'level flip not visible before the next refresh lands');
    await flushMicrotasks();
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '0'}), true,
        'low sample matches level 0 after refresh');
    t.end();
});

test('whenPinLevel samples are tracked per pin', async t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const levels = {4: true, 5: false};
    device._peripheral = {
        isReady: () => true,
        execLive: () => Promise.resolve(''),
        readDigitalPin: pin => Promise.resolve(levels[pin])
    };

    device.whenPinLevel({PIN: '4', LEVEL: '1'});
    device.whenPinLevel({PIN: '5', LEVEL: '1'});
    await flushMicrotasks();

    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), true, 'pin 4 sampled high');
    t.equal(device.whenPinLevel({PIN: '5', LEVEL: '1'}), false, 'pin 5 sampled low');
    t.end();
});

test('whenPinLevel stays false when the connection is not live', t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');

    device._peripheral = {isReady: () => false};
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), false,
        'not ready peripheral never fires');

    device._peripheral = {
        isReady: () => true,
        execLive: () => Promise.resolve('')
    };
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), false,
        'peripheral without realtime pin reads never fires');
    t.end();
});

test('whenPinLevel keeps the last sample when a live read drops', async t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const behaviour = {reject: false};
    device._peripheral = {
        isReady: () => true,
        execLive: () => Promise.resolve(''),
        readDigitalPin: () => {
            if (behaviour.reject) return Promise.reject(new Error('link dropped'));
            return Promise.resolve(true);
        }
    };

    device.whenPinLevel({PIN: '4', LEVEL: '1'});
    await flushMicrotasks();
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), true, 'sample landed');

    behaviour.reject = true;
    await flushMicrotasks();
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), true,
        'rejected refresh keeps the previous sample without crashing');
    t.end();
});

test('whenPinLevel biases the idle level away from the watched edge', t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const calls = [];
    device._peripheral = {
        isReady: () => true,
        execLive: () => Promise.resolve(''),
        readDigitalPin: (pin, idleMode) => {
            calls.push([pin, idleMode]);
            return Promise.resolve(false);
        }
    };

    device.whenPinLevel({PIN: '4', LEVEL: '1'});
    device.whenPinLevel({PIN: '5', LEVEL: '0'});

    t.same(calls[0], ['4', 'INPUT_PULLDOWN'], 'watching high pulls the idle level down');
    t.same(calls[1], ['5', 'INPUT_PULLUP'], 'watching low pulls the idle level up');
    t.end();
});

test('whenPinLevel drops its samples when the link goes away', async t => {
    const device = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const link = {ready: true};
    device._peripheral = {
        isReady: () => link.ready,
        execLive: () => Promise.resolve(''),
        readDigitalPin: () => Promise.resolve(true)
    };

    device.whenPinLevel({PIN: '4', LEVEL: '1'});
    await flushMicrotasks();
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), true, 'sampled high while connected');

    link.ready = false;
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), false, 'no fire while disconnected');

    // Reconnected but not sampled yet: answering from the pre-disconnect
    // level here would fire the hat on a level the pin may not have.
    link.ready = true;
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), false,
        'first poll after reconnect does not fire from the stale sample');

    await flushMicrotasks();
    t.equal(device.whenPinLevel({PIN: '4', LEVEL: '1'}), true,
        'fires again once a fresh sample lands');
    t.end();
});
