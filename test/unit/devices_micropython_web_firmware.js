const tap = require('tap');

const MicroPythonWebSerialPeripheral = require(
    '../../src/devices/common/micropython-webserial-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const EVENTS = {
    PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
    PERIPHERAL_UPLOAD_STDOUT: 'PERIPHERAL_UPLOAD_STDOUT',
    PERIPHERAL_UPLOAD_SUCCESS: 'PERIPHERAL_UPLOAD_SUCCESS',
    PERIPHERAL_UPLOAD_ERROR: 'PERIPHERAL_UPLOAD_ERROR',
    PERIPHERAL_SET_UPLOAD_ABORT_ENABLED: 'PERIPHERAL_SET_UPLOAD_ABORT_ENABLED',
    PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA'
};

const makeRuntime = () => {
    const emitted = [];
    return {
        emitted,
        constructor: EVENTS,
        emit (...args) {
            emitted.push(args);
        },
        on () {},
        removeListener () {},
        registerPeripheralExtension () {},
        isRealtimeMode: () => false
    };
};

const DEVICE_OPT = {
    type: 'microPython',
    chip: 'esp32',
    flashAddress: '0x1000',
    webFirmware: 'static/firmwares/esp32-ble-openblock.bin'
};

/**
 * Build a peripheral with a fake serial transport and a fake esptool-js
 * module, recording every interaction.
 * @param {object} overrides - {chipName, mainError} fake flasher tweaks.
 * @return {object} - {peripheral, runtime, calls}.
 */
const makePeripheral = (overrides = {}) => {
    const runtime = makeRuntime();
    const peripheral = new MicroPythonWebSerialPeripheral(
        runtime, 'dev', 'dev', [], {register: false, deviceOpt: DEVICE_OPT}
    );
    const calls = {
        lends: 0,
        reclaims: 0,
        transportDisconnects: 0,
        flashOptions: null,
        after: null,
        main: 0
    };
    const fakePort = {fake: 'port'};
    peripheral._serial = {
        isConnected: () => true,
        lendPort: async () => {
            calls.lends++;
            return fakePort;
        },
        reclaimPort: async () => {
            calls.reclaims++;
        }
    };
    peripheral._firmwareBootMs = 0;
    peripheral._loadEsptool = () => ({
        Transport: class {
            constructor (port) {
                calls.transportPort = port;
            }
            disconnect () {
                calls.transportDisconnects++;
                return Promise.resolve();
            }
        },
        ESPLoader: class {
            constructor (options) {
                calls.loaderOptions = options;
                this.chip = {CHIP_NAME: overrides.chipName || 'ESP32'};
            }
            async main () {
                calls.main++;
                if (overrides.mainError) {
                    throw overrides.mainError;
                }
            }
            async writeFlash (options) {
                calls.flashOptions = options;
                options.reportProgress(0, 512, 1024);
            }
            async after (mode) {
                calls.after = mode;
            }
        }
    });
    return {peripheral, runtime, calls, fakePort};
};

const emittedOf = (runtime, name) => runtime.emitted.filter(entry => entry[0] === name);

test('capability follows the webFirmware device option', t => {
    const runtime = makeRuntime();
    const bare = new MicroPythonWebSerialPeripheral(runtime, 'dev', 'dev', [], {register: false});
    t.notOk(bare.canUploadFirmware(), 'no webFirmware configured: not supported');

    const {peripheral} = makePeripheral();
    t.ok(peripheral.canUploadFirmware(), 'webFirmware configured: supported');
    t.end();
});

test('happy path: fetch, flash with erase-all at the chip address, reboot, success', async t => {
    const {peripheral, runtime, calls, fakePort} = makePeripheral();
    const firmwareBytes = new Uint8Array([0xE9, 1, 2, 3]);
    global.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => firmwareBytes.buffer
    });

    await peripheral.uploadFirmware();

    t.equal(calls.lends, 1, 'port lent once');
    t.equal(calls.reclaims, 1, 'port reclaimed once');
    t.equal(calls.transportPort, fakePort, 'esptool transport got the lent port');
    t.equal(calls.main, 1, 'loader synced with the chip');
    t.equal(calls.flashOptions.eraseAll, true, 'flash erases everything first');
    t.equal(calls.flashOptions.fileArray[0].address, 0x1000, 'image written at the esp32 address');
    t.equal(calls.flashOptions.fileArray[0].data.length, firmwareBytes.length, 'whole image written');
    t.equal(calls.flashOptions.flashSize, 'keep', 'flash params from the image header are kept');
    t.equal(calls.after, 'hard_reset', 'chip hard-reset after flashing');
    t.equal(calls.transportDisconnects, 1, 'esptool transport closed the port');

    const success = emittedOf(runtime, EVENTS.PERIPHERAL_UPLOAD_SUCCESS);
    t.equal(success.length, 1, 'upload success reported');
    const abortToggles = emittedOf(runtime, EVENTS.PERIPHERAL_SET_UPLOAD_ABORT_ENABLED);
    t.same(abortToggles[0][1], false, 'abort disabled during the firmware flow');
    t.notOk(peripheral._uploading, 'uploading flag cleared');
    t.end();
});

test('sync failure surfaces the Chinese BOOT guidance and still reclaims the port', async t => {
    const {peripheral, runtime, calls} = makePeripheral({
        mainError: new Error('Failed to connect with the device')
    });
    global.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer
    });

    await peripheral.uploadFirmware();

    t.equal(calls.reclaims, 1, 'port reclaimed despite the failure');
    t.equal(calls.transportDisconnects, 1, 'esptool transport cleaned up');
    const errors = emittedOf(runtime, EVENTS.PERIPHERAL_UPLOAD_ERROR);
    t.equal(errors.length, 1, 'upload error reported');
    t.match(errors[0][1].message, /BOOT/, 'error message carries the BOOT guidance');
    const stdout = emittedOf(runtime, EVENTS.PERIPHERAL_UPLOAD_STDOUT)
        .map(entry => entry[1].message)
        .join('');
    t.match(stdout, /BOOT(\uff08|\()IO0/, 'console explains the BOOT procedure');
    t.notOk(peripheral._uploading, 'uploading flag cleared');
    t.end();
});

test('chip mismatch aborts before anything is written', async t => {
    const {peripheral, runtime, calls} = makePeripheral({chipName: 'ESP32-C3'});
    global.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1]).buffer
    });

    await peripheral.uploadFirmware();

    t.equal(calls.flashOptions, null, 'writeFlash never ran');
    t.equal(calls.reclaims, 1, 'port reclaimed');
    const errors = emittedOf(runtime, EVENTS.PERIPHERAL_UPLOAD_ERROR);
    t.match(errors[0][1].message, /expects esp32/, 'mismatch explained to the user');
    t.end();
});

test('firmware download failure is reported without touching the port', async t => {
    const {peripheral, runtime, calls} = makePeripheral();
    global.fetch = async () => ({ok: false, status: 404});

    await peripheral.uploadFirmware();

    t.equal(calls.lends, 0, 'port never lent');
    const errors = emittedOf(runtime, EVENTS.PERIPHERAL_UPLOAD_ERROR);
    t.match(errors[0][1].message, /HTTP 404/, 'download failure reported');
    t.notOk(peripheral._uploading, 'uploading flag cleared');
    t.end();
});

test('helpers: sync failure detection and chip name matching', t => {
    t.ok(MicroPythonWebSerialPeripheral.isEsptoolSyncFailure(
        'Failed to connect with the device'), 'connect failure detected');
    t.ok(MicroPythonWebSerialPeripheral.isEsptoolSyncFailure(
        'Unexpected CHIP magic value 0x0. Failed to autodetect chip type.'), 'autodetect failure detected');
    t.notOk(MicroPythonWebSerialPeripheral.isEsptoolSyncFailure(
        'Could not download the firmware image (HTTP 500)'), 'unrelated errors not matched');

    t.ok(MicroPythonWebSerialPeripheral.chipMatches('esp32', 'ESP32'), 'esp32 matches');
    t.ok(MicroPythonWebSerialPeripheral.chipMatches('esp32c3', 'ESP32-C3'), 'c3 matches across separators');
    t.notOk(MicroPythonWebSerialPeripheral.chipMatches('esp32', 'ESP32-C3'), 'esp32 vs c3 mismatch');
    t.notOk(MicroPythonWebSerialPeripheral.chipMatches('esp32', ''), 'missing detection mismatches');
    t.end();
});
