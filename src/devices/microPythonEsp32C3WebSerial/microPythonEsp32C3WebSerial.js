const OpenBlockMicroPythonEsp32C3Device = require('../microPythonEsp32C3/microPythonEsp32C3');
const MicroPythonWebSerialPeripheral = require('../common/micropython-webserial-peripheral');

/**
 * OpenBlock blocks to interact with a MicroPython esp32-c3 peripheral over
 * the browser Web Serial API, no OpenBlock Link needed. Shares the block
 * set with the C3 serial device, only the transport differs.
 */
class OpenBlockMicroPythonEsp32C3WebSerialDevice extends OpenBlockMicroPythonEsp32C3Device {
    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'microPythonEsp32C3WebSerial';
    }

    /**
     * Construct a set of MicroPython esp32-c3 Web Serial blocks.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} originalDeviceId - the original id of the peripheral.
     */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Replace the serialport peripheral registered by the parent
        // constructor with the Web Serial peripheral.
        this._peripheral = new MicroPythonWebSerialPeripheral(
            runtime, this.DEVICE_ID, originalDeviceId, this.PNPID_LIST);
    }
}

module.exports = OpenBlockMicroPythonEsp32C3WebSerialDevice;
