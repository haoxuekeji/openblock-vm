const Buffer = require('buffer').Buffer;

const WebSerial = require('../../io/webserial');
const MicroPythonBlePeripheral = require('./micropython-ble-peripheral');

// Boot time of the MicroPython firmware after a hard reset.
const HARD_RESET_BOOT_TIME = 2500;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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
     * @param {object} options - construction options passed to the shared raw REPL peripheral.
     */
    constructor (runtime, deviceId, originalDeviceId, pnpidList = [], options = {}) {
        super(runtime, deviceId, originalDeviceId, options);
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
            // Opening the port pulses DTR/RTS which hard-resets boards with
            // an auto-reset circuit. Give the firmware time to boot before
            // the live handshake, control characters sent while the chip is
            // still booting are silently dropped and the handshake would
            // time out, leaving the live session unusable until the next
            // program mode toggle.
            this._enqueueLive(async () => {
                await wait(HARD_RESET_BOOT_TIME);
                return this._enterLiveMode();
            });
        }
    }

    /**
     * Route incoming serial bytes into the shared REPL/console handling.
     * @param {Uint8Array} data - the incoming data.
     * @private
     */
    _onSerialData (data) {
        this._routeIncoming(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
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
     * Hard reset the board by pulsing the DTR/RTS control lines.
     * @return {Promise<boolean>} - true when the reset pulse was sent.
     */
    async hardReset () {
        if (!this.isConnected() || !this._serial) return false;
        this._resetLiveState();
        await this._serial.hardReset();
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(async () => {
                await wait(HARD_RESET_BOOT_TIME);
                return this._enterLiveMode();
            });
        }
        return true;
    }

    /**
     * Whether firmware flashing is actually supported on this channel.
     * @return {boolean} - false, esptool is not available in the browser.
     */
    canUploadFirmware () {
        return false;
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
