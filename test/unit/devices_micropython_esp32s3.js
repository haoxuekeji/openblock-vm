const tap = require('tap');

const OpenBlockMicroPythonEsp32S3Device = require(
    '../../src/devices/microPythonEsp32S3/microPythonEsp32S3'
);
const OpenBlockMicroPythonEsp32Device = require(
    '../../src/devices/microPythonEsp32/microPythonEsp32'
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

test('esp32-s3 device id and uploader options target the s3 chip', t => {
    const device = new OpenBlockMicroPythonEsp32S3Device(makeRuntime(), 'microPythonEsp32S3');

    t.equal(device.DEVICE_ID, 'microPythonEsp32S3');
    t.equal(device.DIVECE_OPT.chip, 'esp32s3');
    t.equal(device.DIVECE_OPT.flashAddress, '0x0');
    t.equal(device.DIVECE_OPT.firmwarePrefix, 'esp32s3-ble-openblock');
    t.equal(device.DIVECE_OPT.webFirmware, 'static/firmwares/esp32s3-ble-openblock.bin');
    t.ok(device.PNPID_LIST.includes('USB\\VID_303A&PID_1001'),
        'native USB serial/JTAG pnp id present');
    t.end();
});

test('esp32-s3 pin menus follow the s3 gpio map', t => {
    const device = new OpenBlockMicroPythonEsp32S3Device(makeRuntime(), 'microPythonEsp32S3');

    const pinValues = device.PINS_MENU.map(item => item.value);
    // USB D-/D+ pins are reserved for the native USB serial/JTAG transport.
    t.notOk(pinValues.includes('19'), 'GPIO19 (USB D-) hidden');
    t.notOk(pinValues.includes('20'), 'GPIO20 (USB D+) hidden');
    // Flash pins do not appear.
    t.notOk(pinValues.includes('26'), 'flash pins hidden');
    t.ok(pinValues.includes('0'));
    t.ok(pinValues.includes('21'));
    t.ok(pinValues.includes('48') === false, 'pin list matches the arduino s3 board map');
    t.ok(pinValues.includes('43'), 'UART0 TX listed like other chips');
    t.ok(pinValues.includes('44'), 'UART0 RX listed like other chips');

    const analogValues = device.ANALOG_PINS_MENU.map(item => Number(item.value));
    t.ok(analogValues.length > 0);
    t.ok(analogValues.every(pin => pin >= 1 && pin <= 10), 'ADC1 only (GPIO1-10)');

    const touchValues = device.TOUCH_PINS_MENU.map(item => Number(item.value));
    t.ok(touchValues.length > 0);
    t.ok(touchValues.every(pin => pin >= 1 && pin <= 14), 'touch channels on GPIO1-14');
    t.end();
});

test('esp32-s3 keeps touch blocks but drops the DAC block', t => {
    const s3 = new OpenBlockMicroPythonEsp32S3Device(makeRuntime(), 'microPythonEsp32S3');
    const s3Pin = s3.getInfo().find(category => category.id === 'pin');
    const s3Opcodes = s3Pin.blocks.map(block => block.opcode).filter(Boolean);

    t.notOk(s3Opcodes.includes('esp32SetDACOutput'), 'no DAC block on the s3');
    t.notOk(s3Pin.menus.dacPins, 'dac pin menu removed');
    t.ok(s3Opcodes.includes('esp32ReadTouchPin'), 'touch block kept');
    t.ok(s3Pin.menus.touchPins, 'touch pin menu kept');

    // The classic esp32 keeps the DAC block, ensuring the filter is s3-specific.
    const esp32 = new OpenBlockMicroPythonEsp32Device(makeRuntime(), 'microPythonEsp32');
    const esp32Pin = esp32.getInfo().find(category => category.id === 'pin');
    const esp32Opcodes = esp32Pin.blocks.map(block => block.opcode).filter(Boolean);
    t.ok(esp32Opcodes.includes('esp32SetDACOutput'));
    t.end();
});

test('esp32-s3 multi transport peripheral registers under the s3 id', t => {
    const runtime = makeRuntime();
    const device = new OpenBlockMicroPythonEsp32S3Device(runtime, 'microPythonEsp32S3');

    t.equal(runtime.peripheralExtensions.microPythonEsp32S3, device._peripheral);
    t.equal(device._peripheral.getTransport(), 'link');
    t.same(device._peripheral.getSupportedTransports(), ['link', 'webserial', 'webble']);
    t.end();
});
