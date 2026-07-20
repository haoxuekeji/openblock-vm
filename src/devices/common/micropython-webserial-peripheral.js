const Buffer = require('buffer').Buffer;

const WebSerial = require('../../io/webserial');
const MicroPythonBlePeripheral = require('./micropython-ble-peripheral');

/**
 * Manage communication with a MicroPython peripheral directly over the
 * browser Web Serial API. The whole raw REPL upload and realtime (live)
 * engine is inherited from the BLE peripheral, only the transport differs.
 * No OpenBlock Link service is required.
 */
class MicroPythonWebSerialPeripheral extends MicroPythonBlePeripheral {
    /**
     * Construct a MicroPython Web Serial communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the extension
     * @param {string} originalDeviceId - the original id of the peripheral
     * @param {Array.<string>} pnpidList - fallback USB pnp id filters for the port chooser.
     */
    constructor (runtime, deviceId, originalDeviceId, pnpidList = []) {
        super(runtime, deviceId, originalDeviceId);
        this._pnpidList = pnpidList;
    }

    /**
     * Called by the runtime when user wants to scan for a peripheral.
     * Opens the browser serial port chooser.
     * @param {Array.<string>} pnpidList - the pnp id list from the device, like 'USB\\VID_1A86&PID_7523'.
     * @param {boolean} listAll - whether to show every serial port.
     */
    scan (pnpidList, listAll = false) {
        if (!pnpidList || pnpidList.length === 0) {
            pnpidList = this._pnpidList;
        }
        if (this._serial) {
            this._serial.disconnect();
        }
        if (!WebSerial.isSupported()) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                message: 'Web Serial API is not supported in this browser, please use Chrome or Edge',
                deviceId: this._deviceId
            });
            return;
        }
        this._serial = new WebSerial(
            this._runtime,
            this._originalDeviceId,
            {
                baudRate: 115200,
                filters: MicroPythonWebSerialPeripheral._pnpidsToFilters(pnpidList)
            },
            this._onConnect,
            this.reset,
            this._onSerialData.bind(this)
        );
        this._serial.requestPeripheral(listAll)
            .catch(e => {
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                    message: (e && e.message) || 'No serial port selected',
                    deviceId: this._deviceId
                });
            });
    }

    /**
     * Called by the runtime when user wants to connect to the picked port.
     */
    connect () {
        if (this._serial) {
            this._serial.connectPeripheral();
        }
    }

    /**
     * Disconnect from the peripheral.
     */
    disconnect () {
        if (this._serial) {
            this._serial.disconnect();
        }
        this.reset();
    }

    /**
     * Return true if connected to the peripheral.
     * @return {boolean} - whether the peripheral is connected.
     */
    isConnected () {
        return this._serial ? this._serial.isConnected() : false;
    }

    /**
     * Write a buffer to the serial port, no chunking needed.
     * @param {Buffer} buffer - the data to write.
     * @return {Promise} - resolved when handed to the OS.
     * @private
     */
    _writeRaw (buffer) {
        if (!this._serial) return Promise.resolve();
        return this._serial.write(new Uint8Array(buffer));
    }

    /**
     * Starts the mode listener after the serial port has connected. Data
     * flow is already wired through _onSerialData.
     * @private
     */
    _onConnect () {
        this._runtime.removeListener(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
        this._runtime.on(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(() => this._enterLiveMode());
        }
    }

    /**
     * Route incoming serial bytes into the shared REPL/console handling.
     * @param {Uint8Array} data - the incoming data.
     * @private
     */
    _onSerialData (data) {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        if (this._uploading || this._liveReady) {
            this._replBuffer += buffer.toString('latin1');
            return;
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_RECIVE_DATA, buffer);
    }

    /**
     * USB serial survives a MicroPython soft reboot, nothing to do.
     * @return {Promise} - resolved immediately.
     * @private
     */
    _handlePostUploadReboot () {
        return Promise.resolve();
    }

    /**
     * Flashing the MicroPython firmware needs esptool, which is not
     * available in the browser. Point the user to the Link based device.
     */
    uploadFirmware () {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
            message: 'Flashing firmware is not supported in browser serial mode, ' +
                'please use the "ESP32 (MicroPython)" device with OpenBlock Link instead'
        });
    }

    /**
     * Convert PNP id strings into Web Serial USB filters.
     * @param {Array.<string>} pnpidList - like ['USB\\VID_1A86&PID_7523'].
     * @return {Array.<object>} - [{usbVendorId, usbProductId}].
     * @private
     */
    static _pnpidsToFilters (pnpidList) {
        const filters = [];
        (pnpidList || []).forEach(pnpid => {
            const match = /VID_([0-9A-Fa-f]{4})&PID_([0-9A-Fa-f]{4})/.exec(pnpid);
            if (match) {
                filters.push({
                    usbVendorId: parseInt(match[1], 16),
                    usbProductId: parseInt(match[2], 16)
                });
            }
        });
        return filters;
    }
}

module.exports = MicroPythonWebSerialPeripheral;
