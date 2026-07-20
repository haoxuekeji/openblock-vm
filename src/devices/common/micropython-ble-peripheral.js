const Buffer = require('buffer').Buffer;

const BLE = require('../../io/ble');
const Base64Util = require('../../util/base64-util');
const log = require('../../util/log');

/**
 * Nordic UART Service (NUS) UUIDs used by the OpenBlock MicroPython BLE
 * firmware (obble.py). Web Bluetooth requires lowercase 128-bit UUID strings.
 * @readonly
 */
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify

/**
 * Max payload per BLE write. 20 bytes is safe for the minimum MTU (23),
 * the link layer keeps packets ordered and reliable.
 * @readonly
 */
const BLE_CHUNK_SIZE = 20;

/**
 * Raw source bytes per raw-REPL file write command.
 * @readonly
 */
const UPLOAD_BLOCK_SIZE = 128;

/**
 * Timeout for a single raw REPL response.
 * @readonly
 */
const REPL_RESPONSE_TIMEOUT = 5000;

/**
 * Python statements executed once when entering realtime (live) mode.
 * @readonly
 */
const LIVE_PROLOGUE = 'from machine import Pin, PWM, DAC, ADC, TouchPad\nimport time';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Quote a JS string as a python single-quoted string literal.
 * @param {string} text - the text to quote.
 * @return {string} - the python literal.
 */
const pyStr = text => `'${String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")}'`;

/**
 * Manage communication with a MicroPython peripheral directly over
 * Web Bluetooth (BLE NUS), including program upload via the raw REPL
 * protocol. No OpenBlock Link service is required.
 */
class MicroPythonBlePeripheral {
    /**
     * Construct a MicroPython BLE communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the extension
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_microPythonEsp32Ble
     */
    constructor (runtime, deviceId, originalDeviceId) {
        this._runtime = runtime;
        this._deviceId = deviceId;
        this._originalDeviceId = originalDeviceId;

        this._ble = null;
        this._runtime.registerPeripheralExtension(deviceId, this);

        /**
         * Buffer of incoming REPL text while an upload is running.
         * @type {string}
         */
        this._replBuffer = '';
        this._uploading = false;
        this._abort = false;

        /**
         * Whether the board REPL is currently in raw mode ready for live
         * (realtime) command execution.
         * @type {boolean}
         */
        this._liveReady = false;

        /**
         * Serialize all live REPL commands, raw REPL can only run one at
         * a time.
         * @type {Promise}
         */
        this._liveQueue = Promise.resolve();

        /**
         * Pin numbers already initialized on the board during this live
         * session, mapped to their current mode string.
         * @type {object}
         */
        this._livePins = {};

        /**
         * Peripheral driver objects (pwm/dac/adc/touch/servo) already
         * created on the board during this live session.
         * @type {Set<string>}
         */
        this._liveObjects = new Set();

        this.reset = this.reset.bind(this);
        this._onConnect = this._onConnect.bind(this);
        this._onMessage = this._onMessage.bind(this);
        this._handleProgramModeUpdate = this._handleProgramModeUpdate.bind(this);
    }

    /**
     * Called by the runtime when user wants to scan for a peripheral.
     * Opens the browser Web Bluetooth chooser filtered on the NUS service.
     */
    scan () {
        if (this._ble) {
            this._ble.disconnect();
        }
        this._ble = new BLE(this._runtime, this._originalDeviceId, {
            filters: [
                {services: [NUS_SERVICE]},
                {namePrefix: 'OB32', services: [NUS_SERVICE]}
            ]
        }, this._onConnect, this.reset);
    }

    /**
     * Called by the runtime when user wants to connect to a certain peripheral.
     * @param {number} id - the id of the peripheral to connect to.
     */
    connect (id) {
        this._peripheralId = id;
        if (this._ble) {
            this._ble.connectPeripheral(id);
        }
    }

    /**
     * Disconnect from the peripheral.
     */
    disconnect () {
        if (this._ble) {
            this._ble.disconnect();
        }
        this.reset();
    }

    /**
     * Reset all the state.
     */
    reset () {
        this._replBuffer = '';
        this._uploading = false;
        this._abort = false;
        this._resetLiveState();
        this._runtime.removeListener(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
    }

    /**
     * Forget everything about the live REPL session (called when the board
     * reboots or the connection drops).
     * @private
     */
    _resetLiveState () {
        this._liveReady = false;
        this._livePins = {};
        this._liveObjects = new Set();
    }

    /**
     * Return true if connected to the peripheral.
     * @return {boolean} - whether the peripheral is connected.
     */
    isConnected () {
        return this._ble ? this._ble.isConnected() : false;
    }

    /**
     * BLE has no baudrate; kept for interface compatibility with the
     * serialport peripheral.
     */
    setBaudrate () {
    }

    /**
     * Write data to the peripheral BLE NUS RX characteristic.
     * @param {string} data - the data to write.
     * @return {Promise} - a promise resolved when all chunks are sent.
     */
    write (data) {
        if (!this.isConnected()) return Promise.resolve();
        return this._writeRaw(Buffer.from(data));
    }

    /**
     * Send a message to the peripheral BLE NUS RX characteristic.
     * @param {Uint8Array} message - the message to write
     * @return {Promise} - a promise resolved when all chunks are sent.
     */
    send (message) {
        if (!this.isConnected()) return Promise.resolve();
        return this._writeRaw(Buffer.from(message));
    }

    /**
     * Write a buffer in BLE sized chunks.
     * @param {Buffer} buffer - the data to write.
     * @return {Promise} - a promise resolved when all chunks are sent.
     * @private
     */
    async _writeRaw (buffer) {
        for (let i = 0; i < buffer.length; i += BLE_CHUNK_SIZE) {
            const chunk = buffer.slice(i, i + BLE_CHUNK_SIZE);
            await this._ble.write(NUS_SERVICE, NUS_RX, chunk.toString('base64'), 'base64', false);
        }
    }

    /**
     * Starts reading data from peripheral after BLE has connected to it.
     * @private
     */
    _onConnect () {
        this._ble.startNotifications(NUS_SERVICE, NUS_TX, this._onMessage);
        this._runtime.removeListener(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
        this._runtime.on(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(() => this._enterLiveMode());
        }
    }

    /**
     * Process the data from the incoming BLE characteristic.
     * @param {string} base64 - the incoming BLE data.
     * @private
     */
    _onMessage (base64) {
        const data = Buffer.from(Base64Util.base64ToUint8Array(base64));
        if (this._uploading || this._liveReady) {
            this._replBuffer += data.toString('latin1');
            return;
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_RECIVE_DATA, data);
    }

    /**
     * Handle the program mode update event: enter or leave the live raw
     * REPL depending on the new mode.
     * @private
     */
    _handleProgramModeUpdate () {
        if (!this.isConnected()) return;
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(() => this._enterLiveMode());
        } else {
            this._enqueueLive(() => this._exitLiveMode());
        }
    }

    /**
     * Emit a message to the upload progress console.
     * @param {string} message - the message.
     * @private
     */
    _sendstd (message) {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_STDOUT, {message});
    }

    /**
     * Wait until the REPL buffer contains the wanted text.
     * @param {string} want - the text to wait for.
     * @param {number} timeout - max time to wait in ms.
     * @return {Promise} - resolved when matched, rejected on timeout/abort.
     * @private
     */
    async _waitFor (want, timeout = REPL_RESPONSE_TIMEOUT) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (this._abort) {
                throw new Error('Aborted');
            }
            const index = this._replBuffer.indexOf(want);
            if (index !== -1) {
                const result = this._replBuffer.slice(0, index);
                this._replBuffer = this._replBuffer.slice(index + want.length);
                return result;
            }
            await wait(10);
        }
        throw new Error(`Timeout waiting for "${want}" from the board`);
    }

    /**
     * Execute one command in raw REPL mode and wait for completion.
     * @param {string} command - python source to execute.
     * @param {number} timeout - max time to wait for the output in ms.
     * @return {Promise} - resolved when the command finished.
     * @private
     */
    async _execRaw (command, timeout = REPL_RESPONSE_TIMEOUT) {
        this._replBuffer = '';
        await this._writeRaw(Buffer.from(command, 'latin1'));
        await this._writeRaw(Buffer.from('\x04'));
        // Raw REPL replies "OK<stdout>\x04<stderr>\x04>".
        await this._waitFor('OK');
        const output = await this._waitFor('\x04', timeout);
        const error = await this._waitFor('\x04');
        await this._waitFor('>');
        if (error.length > 0) {
            throw new Error(`Board error: ${error}`);
        }
        return output;
    }

    /**
     * Append a job to the live command queue, all raw REPL traffic is
     * serialized through it.
     * @param {Function} job - async function to run.
     * @return {Promise} - resolves with the job result, never rejects.
     * @private
     */
    _enqueueLive (job) {
        this._liveQueue = this._liveQueue
            .then(job)
            .catch(err => {
                // Board level errors must not break the queue chain. Log
                // them so block execution simply continues.
                log.warn('MicroPython live command failed:', err.message);
                return null;
            });
        return this._liveQueue;
    }

    /**
     * Interrupt the running program and switch the board REPL into raw
     * mode so blocks can be executed interactively.
     * @private
     */
    async _enterLiveMode () {
        if (this._liveReady || this._uploading || !this.isConnected()) return;
        // From here on incoming data must go to the REPL buffer. The flag
        // also blocks a second concurrent entry.
        this._liveReady = true;
        try {
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x03\x03'));
            await wait(300);
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x01'));
            await this._waitFor('raw REPL; CTRL-B to exit');
            await this._execRaw(LIVE_PROLOGUE);
        } catch (err) {
            this._liveReady = false;
            throw err;
        }
    }

    /**
     * Leave the live raw REPL and return the board to the friendly REPL,
     * console output flows to the GUI again.
     * @private
     */
    async _exitLiveMode () {
        if (!this._liveReady) return;
        this._resetLiveState();
        if (!this.isConnected()) return;
        await this._writeRaw(Buffer.from('\x02'));
    }

    /**
     * Whether live (realtime) block execution is possible right now.
     * @return {boolean} - true when connected, in realtime mode and ready.
     */
    isReady () {
        return this._runtime.isRealtimeMode() && this.isConnected() && this._liveReady && !this._uploading;
    }

    /**
     * Execute python statements on the board in live mode.
     * @param {string} command - python source to execute.
     * @param {number} timeout - max time to wait for the output in ms.
     * @return {Promise<string>} - stdout of the command, null when not ready.
     */
    execLive (command, timeout = REPL_RESPONSE_TIMEOUT) {
        if (!this.isReady()) return Promise.resolve(null);
        return this._enqueueLive(() => {
            if (!this.isReady()) return null;
            return this._execRaw(command, timeout);
        });
    }

    /**
     * Make sure a Pin object exists on the board with the wanted mode.
     * @param {string} pin - the pin number.
     * @param {string} mode - 'in', 'out' or null to keep the current mode.
     * @return {string} - the python statements needed, may be empty.
     * @private
     */
    _pinSetupCode (pin, mode) {
        let code = '';
        if (!Object.prototype.hasOwnProperty.call(this._livePins, pin)) {
            code += `p${pin} = Pin(${pin})\n`;
            this._livePins[pin] = null;
        }
        if (mode && this._livePins[pin] !== mode) {
            code += `p${pin}.init(${mode})\n`;
            this._livePins[pin] = mode;
        }
        return code;
    }

    /**
     * Set a pin mode (live mode).
     * @param {string} pin - the pin number.
     * @param {string} mode - INPUT / OUTPUT / INPUT_PULLUP / INPUT_PULLDOWN.
     * @return {Promise} - resolved when done.
     */
    setPinMode (pin, mode) {
        const modeArgs = {
            INPUT: 'Pin.IN',
            OUTPUT: 'Pin.OUT',
            INPUT_PULLUP: 'Pin.IN, Pin.PULL_UP',
            INPUT_PULLDOWN: 'Pin.IN, Pin.PULL_DOWN'
        };
        const arg = modeArgs[mode] || 'Pin.IN';
        return this.execLive(this._pinSetupCode(pin, arg) || `p${pin}.init(${arg})`);
    }

    /**
     * Write a digital level to a pin (live mode).
     * @param {string} pin - the pin number.
     * @param {string} level - '1' or '0'.
     * @return {Promise} - resolved when done.
     */
    setDigitalOutput (pin, level) {
        const value = Number(level) ? 1 : 0;
        return this.execLive(`${this._pinSetupCode(pin, 'Pin.OUT')}p${pin}.value(${value})`);
    }

    /**
     * Write a pwm duty to a pin (live mode).
     * @param {string} pin - the pin number.
     * @param {number} out - duty 0-1023.
     * @return {Promise} - resolved when done.
     */
    setPwmOutput (pin, out) {
        let code = '';
        if (!this._liveObjects.has(`pwm${pin}`)) {
            code += `pwm${pin} = PWM(Pin(${pin}), freq=1000, duty=0)\n`;
            this._liveObjects.add(`pwm${pin}`);
            delete this._livePins[pin];
        }
        code += `pwm${pin}.duty(int(${Number(out) || 0}))`;
        return this.execLive(code);
    }

    /**
     * Write a dac value to a pin (live mode).
     * @param {string} pin - the pin number (25 or 26).
     * @param {number} out - value 0-255.
     * @return {Promise} - resolved when done.
     */
    setDACOutput (pin, out) {
        let code = '';
        if (!this._liveObjects.has(`dac${pin}`)) {
            code += `dac${pin} = DAC(Pin(${pin}))\n`;
            this._liveObjects.add(`dac${pin}`);
            delete this._livePins[pin];
        }
        code += `dac${pin}.write(int(${Number(out) || 0}))`;
        return this.execLive(code);
    }

    /**
     * Drive a servo on a pin (live mode).
     * @param {string} pin - the pin number.
     * @param {number} out - angle 0-180.
     * @return {Promise} - resolved when done.
     */
    setServoOutput (pin, out) {
        let code = '';
        if (!this._liveObjects.has(`servo${pin}`)) {
            code += `servo${pin} = PWM(Pin(${pin}), freq=50)\n`;
            this._liveObjects.add(`servo${pin}`);
            delete this._livePins[pin];
        }
        const angle = Number(out) || 0;
        code += `servo${pin}.duty(int(25.6 + (${angle}) * 102.4 / 180))`;
        return this.execLive(code);
    }

    /**
     * Run init code on the board once per live session.
     * @param {string} key - identifier of the object/module.
     * @param {string} initCode - python statements creating it.
     * @return {Promise} - resolved when the object exists.
     */
    async ensureLiveObject (key, initCode) {
        if (this._liveObjects.has(key)) return;
        if (initCode) await this.execLive(initCode);
        this._liveObjects.add(key);
    }

    /**
     * Whether an object was already created during this live session.
     * @param {string} key - identifier of the object/module.
     * @return {boolean} - true when present.
     */
    hasLiveObject (key) {
        return this._liveObjects.has(key);
    }

    /**
     * Ask the board to print an expression and return the raw text.
     * @param {string} expression - python expression to print.
     * @return {Promise<string>} - trimmed output, empty string as fallback.
     */
    async readLiveString (expression) {
        const output = await this.execLive(`print(${expression})`);
        if (output === null) return '';
        return String(output).trim();
    }

    /**
     * Ask the board to print an expression and parse the output as number.
     * @param {string} expression - python expression to print.
     * @return {Promise<number>} - the parsed value, 0 as fallback.
     */
    async readLiveNumber (expression) {
        const value = Number(await this.readLiveString(expression));
        return isNaN(value) ? 0 : value;
    }

    /**
     * Ask the board to print an expression and parse the output as number.
     * @param {string} expression - python expression to print.
     * @return {Promise<number>} - the parsed value, 0 as fallback.
     * @private
     */
    _readNumber (expression) {
        return this.readLiveNumber(expression);
    }

    /**
     * Read a digital pin (live mode).
     * @param {string} pin - the pin number.
     * @return {Promise<boolean>} - the pin level.
     */
    async readDigitalPin (pin) {
        // Only force input mode if the pin was never configured, so reading
        // back an output pin keeps working.
        const setup = this._pinSetupCode(pin, this._livePins[pin] ? null : 'Pin.IN');
        if (setup) await this.execLive(setup.trim());
        return (await this._readNumber(`p${pin}.value()`)) === 1;
    }

    /**
     * Read an analog pin through the ADC (live mode).
     * @param {string} pin - the pin number.
     * @return {Promise<number>} - adc value 0-4095.
     */
    async readAnalogPin (pin) {
        if (!this._liveObjects.has(`adc${pin}`)) {
            await this.execLive(`adc${pin} = ADC(Pin(${pin}))\nadc${pin}.atten(ADC.ATTN_11DB)`);
            this._liveObjects.add(`adc${pin}`);
            delete this._livePins[pin];
        }
        return this._readNumber(`adc${pin}.read()`);
    }

    /**
     * Read a capacitive touch pin (live mode).
     * @param {string} pin - the pin number.
     * @return {Promise<number>} - raw touch value.
     */
    async readTouchPin (pin) {
        if (!this._liveObjects.has(`tp${pin}`)) {
            await this.execLive(`tp${pin} = TouchPad(Pin(${pin}))`);
            this._liveObjects.add(`tp${pin}`);
            delete this._livePins[pin];
        }
        return this._readNumber(`tp${pin}.read()`);
    }

    /**
     * Print text on the board, output is forwarded to the GUI console.
     * @param {string} text - the text to print.
     * @param {string} eol - 'warp' appends a newline, 'noWarp' does not.
     * @return {Promise} - resolved when done.
     */
    async consolePrint (text, eol) {
        const end = eol === 'noWarp' ? ", end=''" : '';
        const output = await this.execLive(`print(${pyStr(text)}${end})`);
        if (output !== null && output.length > 0) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_RECIVE_DATA,
                Buffer.from(output, 'latin1'));
        }
    }

    /**
     * Called by the runtime when user wants to upload code to the peripheral.
     * Writes boot.py (BLE bootstrap keeper) and main.py through the raw REPL,
     * then soft-reboots the board.
     * @param {string} code - the code want to upload.
     */
    async upload (code) {
        if (!this.isConnected()) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                message: 'No peripheral is connected'
            });
            return;
        }

        // Wait for pending live commands, then take over the REPL channel.
        await this._liveQueue;
        this._liveReady = false;

        this._uploading = true;
        this._abort = false;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_SET_UPLOAD_ABORT_ENABLED, true);

        try {
            this._sendstd('Entering raw REPL...\n');
            // Interrupt any running program, then enter raw REPL.
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x03\x03'));
            await wait(300);
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x01'));
            await this._waitFor('raw REPL; CTRL-B to exit');

            await this._execRaw('import ubinascii');

            // Install the library modules of the loaded device extensions
            // (fetched from the external resources) before the program.
            const libraryFiles = this._runtime.getCurrentDeviceExtensionLibraryFiles ?
                this._runtime.getCurrentDeviceExtensionLibraryFiles() : [];
            for (const fileUrl of libraryFiles) {
                const fileName = fileUrl.split('/').pop();
                try {
                    const response = await fetch(fileUrl);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const content = Buffer.from(await response.arrayBuffer());
                    await this._writeFileRaw(fileName, content);
                } catch (e) {
                    this._sendstd(`Warning: could not install library ${fileName}: ${e.message}\n`);
                }
            }

            await this._writeFileRaw('main.py', Buffer.from(code, 'utf-8'));

            this._sendstd('Reset board...\n');
            // Exit raw REPL then soft reboot so boot.py + main.py run.
            await this._writeRaw(Buffer.from('\x02'));
            await wait(100);
            await this._writeRaw(Buffer.from('\x04'));

            this._uploading = false;
            await this._handlePostUploadReboot();

            this._sendstd('Success\n');
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_SUCCESS, false);
        } catch (err) {
            const aborted = err.message === 'Aborted';
            this._uploading = false;
            if (aborted) {
                // Try to leave raw REPL so the board is usable again.
                this._writeRaw(Buffer.from('\x02'));
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_SUCCESS, true);
            } else {
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                    message: err.message
                });
            }
        }
    }

    /**
     * Write one file to the board through the raw REPL in base64 chunks.
     * Requires ubinascii to be already imported in the raw REPL session.
     * @param {string} fileName - target file name on the board.
     * @param {Buffer} data - the file content.
     * @return {Promise} - resolved when the file is written.
     * @private
     */
    async _writeFileRaw (fileName, data) {
        this._sendstd(`Writing ${fileName}...\n`);
        await this._execRaw(`f = open('${fileName}', 'wb')`);
        const total = Math.ceil(data.length / UPLOAD_BLOCK_SIZE) || 1;
        for (let i = 0; i < data.length; i += UPLOAD_BLOCK_SIZE) {
            if (this._abort) {
                throw new Error('Aborted');
            }
            const block = data.slice(i, i + UPLOAD_BLOCK_SIZE).toString('base64');
            await this._execRaw(`f.write(ubinascii.a2b_base64('${block}'))`);
            const blockNumber = Math.floor(i / UPLOAD_BLOCK_SIZE) + 1;
            this._sendstd(`Writing ${fileName} ${Math.round(blockNumber / total * 100)}%\n`);
        }
        await this._execRaw('f.close()');
    }

    /**
     * The soft reboot drops the BLE connection. Mark it as an expected
     * disconnect so no "connection lost" error pops up, then reconnect
     * automatically once the board is back. Transports that survive a
     * soft reboot (USB serial) override this with a no-op.
     * @return {Promise} - resolved when the channel is usable again.
     * @private
     */
    async _handlePostUploadReboot () {
        this._ble.disconnect();
        this._sendstd('Waiting for the board to reboot...\n');
        await this._reconnect();
    }

    /**
     * Reconnect to the board after a soft reboot. The Web Bluetooth device
     * handle stays valid, so no new device chooser is needed.
     * @return {Promise} - resolved when reconnected or retries exhausted.
     * @private
     */
    async _reconnect () {
        // Give the board time to reboot and restart advertising.
        await wait(3000);
        for (let retry = 0; retry < 3; retry++) {
            if (this._abort) return;
            this._ble.connectPeripheral(this._peripheralId);
            for (let i = 0; i < 20; i++) {
                await wait(250);
                if (this.isConnected()) return;
            }
        }
        this._sendstd('Could not reconnect automatically, please reconnect the device manually.\n');
    }

    /**
     * Called by the runtime when user wants to abort the uploading process.
     */
    abortUpload () {
        this._abort = true;
    }

    /**
     * BLE channel can not flash the MicroPython firmware itself, this
     * requires the USB serial channel.
     */
    uploadFirmware () {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
            message: 'Flashing firmware is not supported over BLE, please use the USB serial device instead'
        });
    }
}

module.exports = MicroPythonBlePeripheral;
