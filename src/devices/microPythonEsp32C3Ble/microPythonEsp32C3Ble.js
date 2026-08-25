const OpenBlockMicroPythonEsp32C3Device = require('../microPythonEsp32C3/microPythonEsp32C3');
const MicroPythonBlePeripheral = require('../common/micropython-ble-peripheral');

/**
 * OpenBlock blocks to interact with a MicroPython esp32-c3 peripheral over
 * BLE (Web Bluetooth), using the OpenBlock BLE firmware (obble). Shares the
 * C3 block set (no DAC / touch, C3 pin menus) with the serial
 * microPythonEsp32C3 device, only the transport and the upload path differ:
 * programs are written through the BLE raw REPL in the browser, no OpenBlock
 * Link is needed.
 */
class OpenBlockMicroPythonEsp32C3BleDevice extends OpenBlockMicroPythonEsp32C3Device {
    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'microPythonEsp32C3Ble';
    }

    /**
     * Construct a set of MicroPython esp32-c3 BLE blocks.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_microPythonEsp32C3Ble
     */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Replace the serialport peripheral registered by the parent
        // constructor with the BLE peripheral (registerPeripheralExtension
        // simply overwrites the entry for this DEVICE_ID).
        this._peripheral = new MicroPythonBlePeripheral(runtime, this.DEVICE_ID, originalDeviceId);
    }
}

module.exports = OpenBlockMicroPythonEsp32C3BleDevice;
