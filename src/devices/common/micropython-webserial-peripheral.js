const Buffer = require('buffer').Buffer;

const WebSerial = require('../../io/webserial');
const MicroPythonBlePeripheral = require('./micropython-ble-peripheral');

// Boot time of the MicroPython firmware after a hard reset.
const HARD_RESET_BOOT_TIME = 2500;

// After flashing with --erase-all the firmware boots for the first time
// and has to create the whole filesystem; same wait as the Link uploader.
const FIRMWARE_BOOT_TIME = 10 * 1000;

// Transfer baud rate once the esptool flasher stub runs; the ROM sync
// itself always happens at 115200 (esptool-js romBaudrate default).
const ESPTOOL_FLASH_BAUD = 921600;

// Where the MicroPython image starts: the classic esp32 bootloader lives
// at 0x1000, newer chips (c3/s3/c6) are flashed from 0x0. Fallback for
// device configs that do not set flashAddress explicitly.
const CHIP_FLASH_ADDRESS = {
    esp32: '0x1000',
    esp32c3: '0x0',
    esp32s3: '0x0',
    esp32c6: '0x0'
};

// esptool cannot talk to a chip that never entered (or dropped out of)
// download mode. On boards without an auto-reset circuit (DTR/RTS not
// wired) this is the typical failure and the only fix is holding the
// BOOT button, so translate it into actionable guidance (mirrors the
// openblock-link esptool wrapper).
const ESPTOOL_SYNC_FAILURE_PATTERNS = [
    'failed to connect',
    'timed out',
    'wrong boot mode',
    'invalid head of packet',
    'failed to autodetect chip type'
];

// Single-line summary embedded in the rejection so the GUI upload dialog
// shows the fix next to the "Upload error" banner.
const ESPTOOL_SYNC_GUIDANCE =
    '未能与芯片同步:板子可能没有自动下载电路,请按住 BOOT(IO0)键插上 USB 或按一下 RST/EN 键,再重试烧录';

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
     * @param {object} options.deviceOpt - uploader options of the device
     *   (chip, flashAddress, webFirmware URL); enables firmware flashing
     *   through esptool-js when webFirmware is set.
     */
    constructor (runtime, deviceId, originalDeviceId, pnpidList = [], options = {}) {
        super(runtime, deviceId, originalDeviceId, options);
        this._pnpidList = pnpidList;
        this._deviceOpt = options.deviceOpt || null;
        // Overridable so tests do not wait out the real boot time.
        this._firmwareBootMs = FIRMWARE_BOOT_TIME;
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
        this._startLiveWatchdog();
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
     * @return {boolean} - true when a web-hosted firmware image is
     * configured for this device; flashing then runs in the browser
     * through esptool-js over the same Web Serial port.
     */
    canUploadFirmware () {
        return Boolean(this._deviceOpt && this._deviceOpt.webFirmware);
    }

    /**
     * Load the esptool-js module. A dynamic import so the flasher (an
     * untranspiled ES2017 ESM build) stays in its own lazy webpack chunk
     * instead of the ES5-minified vendor bundle, node.js environments
     * never touch it, and tests can substitute a fake flasher.
     * @return {Promise<object>} - resolves {ESPLoader, Transport}.
     * @private
     */
    _loadEsptool () {
        return import('esptool-js');
    }

    /**
     * Flash the MicroPython firmware through esptool-js directly in the
     * browser: fetch the image, borrow the serial port from the transport
     * (esptool drives DTR/RTS and the baud rate itself), sync with the
     * ROM bootloader, erase + write, hard-reset, then hand the port back
     * and rebuild the realtime session.
     * @return {Promise} - resolved when the flow finished either way.
     */
    async uploadFirmware () {
        if (this._uploading) return;
        if (!this.canUploadFirmware()) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                message: 'Flashing firmware is not supported in browser serial mode for this device, ' +
                    'please use the "ESP32 (MicroPython)" device with OpenBlock Link instead'
            });
            return;
        }
        if (!this.isConnected() || !this._serial) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                message: 'No peripheral is connected'
            });
            return;
        }

        // Wait for pending live commands, then take the channel over.
        await this._liveQueue;
        this._liveReady = false;
        this._resetLiveState();
        this._uploading = true;
        this._abort = false;
        // An interrupted flash leaves a half-erased chip, so the abort
        // button stays disabled for the whole firmware flow.
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_SET_UPLOAD_ABORT_ENABLED, false);

        try {
            const firmwareUrl = this._deviceOpt.webFirmware;
            this._sendstd(`Downloading firmware ${firmwareUrl}...\n`);
            const response = await fetch(firmwareUrl);
            if (!response.ok) {
                throw new Error(`Could not download the firmware image (HTTP ${response.status})`);
            }
            const firmware = new Uint8Array(await response.arrayBuffer());
            this._sendstd(`Firmware image size: ${firmware.length} bytes\n`);

            const port = await this._serial.lendPort();
            let flashError = null;
            try {
                await this._flashWithEsptool(port, firmware);
            } catch (e) {
                flashError = e;
            }
            // Always hand the port back exactly once; a flashing error is
            // more useful to the user than a follow-up reclaim error.
            await this._serial.reclaimPort().catch(reclaimError => {
                if (!flashError) flashError = reclaimError;
            });
            if (flashError) throw flashError;

            this._sendstd('Waiting for the board to boot and initialize the file system...\n');
            await wait(this._firmwareBootMs);

            this._uploading = false;
            this._sendstd('Success\n');
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_SUCCESS, false);
            if (this._runtime.isRealtimeMode()) {
                this._enqueueLive(() => this._enterLiveMode());
            }
        } catch (err) {
            this._uploading = false;
            const message = err && err.message ? err.message : String(err);
            if (MicroPythonWebSerialPeripheral.isEsptoolSyncFailure(message)) {
                this._sendstd('未能与芯片同步,板子可能没有自动下载电路(DTR/RTS 未接)。\n');
                this._sendstd('请按住板上的 BOOT(IO0)键不放,重新插一次 USB 线或按一下 RST/EN 键,\n');
                this._sendstd('等待窗口出现 Connecting 后松开 BOOT,然后重试烧录。\n');
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                    message: ESPTOOL_SYNC_GUIDANCE
                });
                return;
            }
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {message});
        }
    }

    /**
     * Drive one esptool-js flash cycle on a borrowed (closed) SerialPort:
     * sync at 115200, run the flasher stub, switch to the transfer baud,
     * erase-all + write the image, hard-reset the chip and close the port.
     * @param {SerialPort} port - the borrowed Web Serial port.
     * @param {Uint8Array} firmware - the firmware image.
     * @return {Promise} - resolved when the port is closed again.
     * @private
     */
    async _flashWithEsptool (port, firmware) {
        const {ESPLoader, Transport} = await this._loadEsptool();
        const transport = new Transport(port, false);
        const terminal = {
            clean: () => {},
            write: data => this._sendstd(String(data)),
            writeLine: data => this._sendstd(`${String(data)}\n`)
        };
        try {
            const loader = new ESPLoader({
                transport,
                baudrate: ESPTOOL_FLASH_BAUD,
                terminal
            });

            this._sendstd('Connecting to the chip (esptool-js)...\n');
            await loader.main();

            const expectedChip = String((this._deviceOpt && this._deviceOpt.chip) || 'esp32');
            const detectedChip = loader.chip && loader.chip.CHIP_NAME ? String(loader.chip.CHIP_NAME) : '';
            if (!MicroPythonWebSerialPeripheral.chipMatches(expectedChip, detectedChip)) {
                throw new Error(`The connected chip is ${detectedChip || 'unknown'}, ` +
                    `but this device expects ${expectedChip}. Flashing aborted.`);
            }

            const flashAddress = (this._deviceOpt && this._deviceOpt.flashAddress) ||
                CHIP_FLASH_ADDRESS[expectedChip] || '0x0';
            const address = parseInt(flashAddress, 16) || 0;
            this._sendstd(`Erasing flash and writing firmware at ${flashAddress}...\n`);
            let lastPercent = -1;
            await loader.writeFlash({
                fileArray: [{data: firmware, address}],
                // "keep" preserves the flash parameters already encoded in
                // the image header, matching the esptool CLI defaults the
                // Link uploader relies on.
                flashMode: 'keep',
                flashFreq: 'keep',
                flashSize: 'keep',
                eraseAll: true,
                compress: true,
                reportProgress: (fileIndex, written, total) => {
                    const percent = Math.round(written / total * 100);
                    if (percent !== lastPercent) {
                        lastPercent = percent;
                        this._sendstd(`Writing firmware ${percent}%\n`);
                    }
                }
            });
            this._sendstd('Flash firmware Success.\n');
            await loader.after('hard_reset');
        } finally {
            // Closes the port so reclaimPort can reopen it for the REPL.
            await transport.disconnect().catch(() => null);
        }
    }

    /**
     * Whether an esptool-js error message shows the chip never entered
     * (or dropped out of) download mode.
     * @param {string} message - the error message.
     * @return {boolean} - true when it is a sync/boot-mode failure.
     */
    static isEsptoolSyncFailure (message) {
        const text = String(message || '').toLowerCase();
        return ESPTOOL_SYNC_FAILURE_PATTERNS.some(pattern => text.includes(pattern));
    }

    /**
     * Compare the configured chip id (e.g. "esp32c3") with the chip name
     * esptool-js detected (e.g. "ESP32-C3"), ignoring case and separators.
     * @param {string} expected - configured chip id.
     * @param {string} detected - CHIP_NAME reported by esptool-js.
     * @return {boolean} - true when they denote the same chip.
     */
    static chipMatches (expected, detected) {
        const normalize = value => String(value || '').toLowerCase()
            .replace(/[^a-z0-9]/g, '');
        if (!detected) return false;
        return normalize(detected) === normalize(expected);
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
