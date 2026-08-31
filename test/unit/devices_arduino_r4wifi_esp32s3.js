const tap = require('tap');

const OpenBlockArduinoUnoR4MinimaDevice = require(
    '../../src/devices/arduinoUnoR4Minima/arduinoUnoR4Minima'
);
const OpenBlockArduinoUnoR4WifiDevice = require(
    '../../src/devices/arduinoUnoR4Wifi/arduinoUnoR4Wifi'
);
const OpenBlockArduinoEsp32Device = require(
    '../../src/devices/arduinoEsp32/arduinoEsp32'
);
const OpenBlockArduinoEsp32S3Device = require(
    '../../src/devices/arduinoEsp32S3/arduinoEsp32S3'
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

test('r4 wifi inherits the minima block set and adds the display category', t => {
    const wifi = new OpenBlockArduinoUnoR4WifiDevice(makeRuntime(), 'arduinoUnoR4Wifi');

    t.equal(wifi.DEVICE_ID, 'arduinoUnoR4Wifi');
    t.equal(wifi._peripheral.diveceOpt.fqbn, 'arduino:renesas_uno:unor4wifi');
    t.ok(wifi._peripheral.pnpidList.includes('USB\\VID_2341&PID_1002'));
    t.equal(wifi._peripheral.numDigitalPins, 14);

    const categories = wifi.getInfo().map(category => category.id);
    t.same(categories, ['pin', 'display', 'serial', 'data'],
        'display category inserted after pins');

    const display = wifi.getInfo().find(category => category.id === 'display');
    const opcodes = display.blocks.map(block => block.opcode).filter(Boolean);
    t.same(opcodes,
        ['showImage', 'showImageUntil', 'showUntilScrollDone', 'clearDisplay', 'lightPixelAt']);
    t.ok(display.menus.ledState, 'led state menu present');
    t.end();
});

test('r4 minima is not affected by the wifi subclass', t => {
    const minima = new OpenBlockArduinoUnoR4MinimaDevice(makeRuntime(), 'arduinoUnoR4Minima');

    t.equal(minima.DEVICE_ID, 'arduinoUnoR4Minima');
    t.equal(minima._peripheral.diveceOpt.fqbn, 'arduino:renesas_uno:minima');

    const categories = minima.getInfo().map(category => category.id);
    t.same(categories, ['pin', 'serial', 'data'], 'no display category on the minima');
    t.end();
});

test('esp32-s3 inherits the esp32 block set with s3 pins and no DAC', t => {
    const s3 = new OpenBlockArduinoEsp32S3Device(makeRuntime(), 'arduinoEsp32S3');

    t.equal(s3.DEVICE_ID, 'arduinoEsp32S3');
    t.ok(s3._peripheral.diveceOpt.fqbn.linux.startsWith('esp32:esp32:esp32s3:'));
    t.ok(s3._peripheral.pnpidList.includes('USB\\VID_1A86&PID_55D3'), 'CH343 pnp id present');

    const pinValues = s3.PINS_MENU.map(item => item.value);
    t.ok(pinValues.includes('44'), 'S3 GPIO44 listed');
    t.notOk(pinValues.includes('25'), 'classic esp32 GPIO25 absent');
    t.notOk(pinValues.includes('35'), 'octal flash pins hidden');

    t.same(s3.OUT_PINS_MENU, s3.PINS_MENU, 'all usable S3 pins are output capable');

    const analogValues = s3.ANALOG_PINS_MENU.map(item => Number(item.value));
    t.ok(analogValues.every(pin => pin >= 1 && pin <= 20), 'ADC on GPIO1-20');

    const touchValues = s3.TOUCH_PINS_MENU.map(item => Number(item.value));
    t.ok(touchValues.every(pin => pin >= 1 && pin <= 15), 'touch on GPIO1-15');

    const pinCategory = s3.getInfo().find(category => category.id === 'pin');
    const opcodes = pinCategory.blocks.map(block => block.opcode).filter(Boolean);
    t.notOk(opcodes.includes('esp32SetDACOutput'), 'no DAC block on the s3');
    t.notOk(pinCategory.menus.dacPins, 'dac pins menu removed');
    t.ok(opcodes.includes('esp32ReadTouchPin'), 'touch block kept');
    t.same(pinCategory.menus.pins.items, s3.PINS_MENU, 's3 pin menu wired into getInfo');
    t.end();
});

test('classic esp32 is not affected by the s3 subclass', t => {
    const esp32 = new OpenBlockArduinoEsp32Device(makeRuntime(), 'arduinoEsp32');

    const pinCategory = esp32.getInfo().find(category => category.id === 'pin');
    const opcodes = pinCategory.blocks.map(block => block.opcode).filter(Boolean);
    t.ok(opcodes.includes('esp32SetDACOutput'), 'DAC block kept on the classic esp32');
    t.ok(pinCategory.menus.dacPins, 'dac pins menu kept');

    const outPinValues = esp32.OUT_PINS_MENU.map(item => item.value);
    t.notOk(outPinValues.includes('34'), 'input-only pins stay out of the out pins menu');
    t.end();
});
