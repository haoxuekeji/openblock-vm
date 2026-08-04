const tap = require('tap');

const MicroPythonMultiTransportPeripheral = require(
    '../../src/devices/common/micropython-multi-transport-peripheral'
);
const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);
const VirtualMachine = require('../../src/virtual-machine');

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

test('MicroPython device switches transports without changing device id', t => {
    const runtime = makeRuntime();
    const peripheral = new MicroPythonMultiTransportPeripheral(
        runtime,
        'microPythonEsp32',
        'microPythonEsp32',
        ['USB\\VID_1A86&PID_7523'],
        {baudRate: 115200, dataBits: 8, stopBits: 1},
        {type: 'microPython'}
    );

    t.equal(runtime.peripheralExtensions.microPythonEsp32, peripheral);
    t.equal(peripheral.getTransport(), 'link');
    t.same(peripheral.getSupportedTransports(), ['link', 'webserial', 'webble']);

    peripheral.setTransport('webserial');
    t.equal(peripheral.getTransport(), 'webserial');
    t.equal(runtime.peripheralExtensions.microPythonEsp32, peripheral);

    peripheral.setTransport('webble');
    t.equal(peripheral.getTransport(), 'webble');
    t.equal(runtime.peripheralExtensions.microPythonEsp32, peripheral);

    t.throws(() => peripheral.setTransport('invalid'));
    t.end();
});

test('legacy ESP32 transport device ids migrate to the canonical device', async t => {
    const vm = new VirtualMachine();
    await vm.extensionManager.loadDeviceURL({
        deviceId: 'microPythonEsp32WebSerial',
        type: 'microPython',
        pnpidList: []
    });

    t.equal(vm.runtime.getDevice().deviceId, 'microPythonEsp32');
    t.equal(vm.getPeripheralTransport('microPythonEsp32'), 'webserial');
});

test('MicroPython library URLs become importable board file names', t => {
    t.equal(
        MicroPythonBlePeripheral.libraryFileNameFromUrl(
            'http://127.0.0.1:20112/extensions/espTm1650/lib/tm1650.py?v=1.0.1'
        ),
        'tm1650.py'
    );
    t.equal(
        MicroPythonBlePeripheral.libraryFileNameFromUrl('extensions/example/lib/my%20driver.py#latest'),
        'my driver.py'
    );
    t.throws(() => MicroPythonBlePeripheral.libraryFileNameFromUrl('extensions/example/lib/'));
    t.end();
});

test('device extension realtime primitives register and unload cleanly', t => {
    const vm = new VirtualMachine();
    const primitive = () => 42;

    vm.runtime.addDeviceExtension('espLcd1602', '<xml/>', null, [], {
        espLcd1602_clear: primitive
    });
    t.equal(vm.runtime.getOpcodeFunction('espLcd1602_clear'), primitive);

    vm.runtime.removeDeviceExtension('espLcd1602');
    t.notOk(vm.runtime.getOpcodeFunction('espLcd1602_clear'));
    t.end();
});

test('device extension toolbox follows supported program modes', t => {
    const vm = new VirtualMachine();
    vm.runtime.setDevice({deviceId: 'microPythonEsp32', type: 'microPython'});
    vm.runtime.addDeviceExtension(
        'uploadOnly', '<category id="uploadOnly"/>', null, [], null, ['upload']
    );
    vm.runtime.addDeviceExtension(
        'bothModes', '<category id="bothModes"/>', null, [], null, ['realtime', 'upload']
    );

    const realtimeIds = vm.runtime.getBlocksXML(null).map(category => category.id);
    t.ok(realtimeIds.includes('bothModes'));
    t.notOk(realtimeIds.includes('uploadOnly'));

    vm.runtime.setRealtimeMode(false);
    const uploadIds = vm.runtime.getBlocksXML(null).map(category => category.id);
    t.ok(uploadIds.includes('bothModes'));
    t.ok(uploadIds.includes('uploadOnly'));
    t.end();
});
