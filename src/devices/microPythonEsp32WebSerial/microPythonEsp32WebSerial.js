const OpenBlockMicroPythonEsp32Device = require('../microPythonEsp32/microPythonEsp32');
const MicroPythonWebSerialPeripheral = require('../common/micropython-webserial-peripheral');

/**
 * OpenBlock blocks to interact with a MicroPython esp32 peripheral over the
 * browser Web Serial API. Shares all block definitions with the serial
 * microPythonEsp32 device, only the transport differs: the browser talks to
 * the USB serial port directly, no OpenBlock Link is needed. Upload and
 * realtime mode both run over the raw REPL protocol.
 */
class OpenBlockMicroPythonEsp32WebSerialDevice extends OpenBlockMicroPythonEsp32Device {
    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'microPythonEsp32WebSerial';
    }

    /**
     * Construct a set of MicroPython esp32 Web Serial blocks.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_microPythonEsp32WebSerial
     */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Replace the serialport peripheral registered by the parent
        // constructor with the Web Serial peripheral.
        this._peripheral = new MicroPythonWebSerialPeripheral(
            runtime, this.DEVICE_ID, originalDeviceId, this.PNPID_LIST);
    }
}

module.exports = OpenBlockMicroPythonEsp32WebSerialDevice;
