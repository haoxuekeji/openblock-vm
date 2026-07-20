/**
 * Web Serial API based serial transport, used to talk to a MicroPython
 * board directly from the browser without OpenBlock Link.
 *
 * The interface loosely mirrors the WebBLE backend in io/ble.js:
 * requestPeripheral / connectPeripheral / disconnect / isConnected / write,
 * incoming data is delivered through the onData callback.
 */
class WebSerial {
    /**
     * Construct a WebSerial transport.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} deviceId - the id of the device using this transport.
     * @param {object} options - {baudRate, filters: [{usbVendorId, usbProductId}]}.
     * @param {Function} connectCallback - called when the port is open.
     * @param {Function} resetCallback - called when the connection is lost.
     * @param {Function} onData - called with a Uint8Array for incoming data.
     */
    constructor (runtime, deviceId, options, connectCallback, resetCallback, onData) {
        this._runtime = runtime;
        this._deviceId = deviceId;
        this._options = options || {};
        this._connectCallback = connectCallback;
        this._resetCallback = resetCallback;
        this._onData = onData;

        this._port = null;
        this._reader = null;
        this._writer = null;
        this._connected = false;

        this._handleHardwareDisconnect = this._handleHardwareDisconnect.bind(this);
    }

    /**
     * Whether the browser supports the Web Serial API.
     * @return {boolean} - true when navigator.serial is available.
     */
    static isSupported () {
        return typeof navigator !== 'undefined' &&
            !!navigator.serial &&
            typeof navigator.serial.requestPort === 'function';
    }

    /**
     * Open the browser serial port chooser.
     * @param {boolean} listAll - when true, do not filter by USB vid/pid.
     * @return {Promise} - resolved after the user picked a port.
     */
    requestPeripheral (listAll = false) {
        const requestOptions = {};
        if (!listAll && this._options.filters && this._options.filters.length > 0) {
            requestOptions.filters = this._options.filters;
        }
        return navigator.serial.requestPort(requestOptions)
            .then(port => {
                this._port = port;
                // There is no stable id in Web Serial, use a fixed one, the
                // GUI connects to whatever the user picked in the chooser.
                const peripheralInfo = {
                    peripheralId: 'web-serial',
                    name: WebSerial._portName(port)
                };
                this._runtime.emit(
                    this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                    {'web-serial': peripheralInfo}
                );
            });
    }

    /**
     * Open the picked serial port and start the read loop.
     */
    connectPeripheral () {
        if (!this._port) {
            this._handleRequestError(new Error('No serial port selected'));
            return;
        }
        this._port.open({baudRate: this._options.baudRate || 115200})
            .then(() => {
                this._writer = this._port.writable.getWriter();
                this._connected = true;
                navigator.serial.addEventListener('disconnect', this._handleHardwareDisconnect);
                this._readLoop();
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                if (this._connectCallback) this._connectCallback();
            })
            .catch(e => {
                this._handleRequestError(e);
            });
    }

    /**
     * Continuously read from the port and forward the data.
     * @private
     */
    async _readLoop () {
        while (this._connected && this._port && this._port.readable) {
            this._reader = this._port.readable.getReader();
            try {
                for (;;) {
                    const {value, done} = await this._reader.read();
                    if (done) break;
                    if (value && value.length > 0 && this._onData) {
                        this._onData(value);
                    }
                }
            } catch (e) {
                // Read error: the device was probably unplugged.
                this.handleDisconnectError(e);
                return;
            } finally {
                try {
                    this._reader.releaseLock();
                } catch (e) {
                    // Lock already released.
                }
            }
        }
    }

    /**
     * Write data to the serial port.
     * @param {Uint8Array} data - the bytes to send.
     * @return {Promise} - resolved when the bytes were handed to the OS.
     */
    write (data) {
        if (!this._connected || !this._writer) return Promise.resolve();
        return this._writer.write(data);
    }

    /**
     * Toggle the DTR/RTS signals to hard-reset a typical ESP32 dev board
     * (EN wired to RTS, IO0 to DTR).
     * @return {Promise} - resolved when the reset pulse is done.
     */
    async hardReset () {
        if (!this._connected || !this._port || !this._port.setSignals) return;
        try {
            await this._port.setSignals({dataTerminalReady: false, requestToSend: true});
            await new Promise(resolve => setTimeout(resolve, 100));
            await this._port.setSignals({dataTerminalReady: false, requestToSend: false});
        } catch (e) {
            // Signals not supported by this adapter, ignore.
        }
    }

    /**
     * Close the port and release everything.
     */
    disconnect () {
        const wasConnected = this._connected;
        this._connected = false;
        navigator.serial.removeEventListener('disconnect', this._handleHardwareDisconnect);

        const cleanup = [];
        if (this._reader) {
            cleanup.push(this._reader.cancel().catch(() => null));
            this._reader = null;
        }
        if (this._writer) {
            try {
                this._writer.releaseLock();
            } catch (e) {
                // Lock already released.
            }
            this._writer = null;
        }
        Promise.all(cleanup)
            .then(() => {
                if (this._port) return this._port.close();
                return null;
            })
            .catch(() => null)
            .then(() => {
                this._port = null;
            });

        if (wasConnected) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
        }
    }

    /**
     * Whether the port is open.
     * @return {boolean} - true when connected.
     */
    isConnected () {
        return this._connected;
    }

    /**
     * Handle the browser-level unplug event for our port.
     * @param {Event} event - the navigator.serial disconnect event.
     * @private
     */
    _handleHardwareDisconnect (event) {
        if (event.target === this._port) {
            this.handleDisconnectError(new Error('Serial port unplugged'));
        }
    }

    /**
     * Handle an unexpected connection loss.
     * @param {Error} e - the error.
     */
    handleDisconnectError (e) {
        if (!this._connected) return;
        this.disconnect();
        if (this._resetCallback) this._resetCallback();
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
            message: (e && e.message) || 'Serial connection lost',
            deviceId: this._deviceId
        });
    }

    /**
     * Handle a request/open error.
     * @param {Error} e - the error.
     * @private
     */
    _handleRequestError (e) {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
            message: (e && e.message) || 'Serial request failed',
            deviceId: this._deviceId
        });
    }

    /**
     * Build a friendly name from the USB port info.
     * @param {SerialPort} port - the picked port.
     * @return {string} - a display name.
     * @private
     */
    static _portName (port) {
        try {
            const info = port.getInfo();
            if (info.usbVendorId) {
                const vid = info.usbVendorId.toString(16).padStart(4, '0')
                    .toUpperCase();
                const pid = (info.usbProductId || 0).toString(16).padStart(4, '0')
                    .toUpperCase();
                return `USB Serial (${vid}:${pid})`;
            }
        } catch (e) {
            // getInfo not available.
        }
        return 'Serial Port';
    }
}

module.exports = WebSerial;
