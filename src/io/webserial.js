/**
 * Web Serial API based serial transport, used to talk to a MicroPython
 * board directly from the browser without OpenBlock Link.
 *
 * The interface loosely mirrors the WebBLE backend in io/ble.js:
 * requestPeripheral / connectPeripheral / disconnect / isConnected / write,
 * incoming data is delivered through the onData callback.
 */

/**
 * Device ids whose silently reused granted port failed to open in this
 * page session; they fall back to the chooser until a connect succeeds.
 * @type {object}
 */
const autoConnectBlocked = {};

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

        /**
         * Whether the underlying SerialPort is currently lent out to an
         * external protocol driver (e.g. esptool-js flashing firmware).
         * While lent, the read loop is stopped, writes are dropped and the
         * port is closed so the borrower can (re)open it itself.
         * @type {boolean}
         */
        this._lent = false;

        /**
         * Promise of the running read loop, awaited on lend so the reader
         * lock is guaranteed released before the port is handed over.
         * @type {?Promise}
         */
        this._readLoopPromise = null;

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
     * Find the serial port to use. Chooser-free when exactly one port the
     * user granted earlier (navigator.serial.getPorts: permission persists
     * per origin, only attached ports are listed) matches the device's
     * USB filters: that is the board plugged in right now, picking it
     * again in the system dialog is a wasted click. Otherwise, or when
     * the caller insists (refresh / "show all"), the chooser opens.
     *
     * Either way the port is published as the only entry of the
     * peripheral list, flagged so the GUI connects without a tile click:
     * `autoConnect` after the chooser (the user just picked it) and
     * `rememberedDevice` on the silent path (the GUI applies its
     * once-per-page guard so a user who wants a different board is not
     * trapped in an auto reconnect loop).
     * @param {boolean} listAll - when true, do not filter by USB vid/pid.
     * @param {object} options - {forceChooser}: skip the granted-port path.
     * @return {Promise} - resolved after a port was published.
     */
    requestPeripheral (listAll = false, options = {}) {
        const filters = (!listAll && this._options.filters && this._options.filters.length > 0) ?
            this._options.filters : null;
        const silent = !options.forceChooser && !listAll &&
            !autoConnectBlocked[this._deviceId];
        const granted = silent ? this._findGrantedPort(filters) : Promise.resolve(null);
        return granted.then(port => {
            if (port) {
                this._publishPort(port, {rememberedDevice: true});
                return;
            }
            const requestOptions = {};
            if (filters) requestOptions.filters = filters;
            return navigator.serial.requestPort(requestOptions)
                .then(picked => this._publishPort(picked, {autoConnect: true}));
        });
    }

    /**
     * The single granted + attached port matching the filters, or null
     * (none, several, API missing or lookup error -> chooser).
     * @param {?Array.<object>} filters - [{usbVendorId, usbProductId}] or null.
     * @return {Promise<?SerialPort>} - the port to reuse or null.
     * @private
     */
    _findGrantedPort (filters) {
        if (typeof navigator === 'undefined' || !navigator.serial ||
            typeof navigator.serial.getPorts !== 'function') {
            return Promise.resolve(null);
        }
        return navigator.serial.getPorts()
            .then(ports => {
                const matching = (ports || []).filter(port => WebSerial._matchesFilters(port, filters));
                return matching.length === 1 ? matching[0] : null;
            })
            .catch(() => null);
    }

    /**
     * Whether a port's USB ids satisfy one of the Web Serial filters.
     * @param {SerialPort} port - the granted port.
     * @param {?Array.<object>} filters - [{usbVendorId, usbProductId}] or null = any.
     * @return {boolean} - true when the port may be reused.
     * @private
     */
    static _matchesFilters (port, filters) {
        if (!filters || filters.length === 0) return true;
        let info = {};
        try {
            info = port.getInfo() || {};
        } catch (e) {
            return false;
        }
        return filters.some(filter =>
            (typeof filter.usbVendorId === 'undefined' || filter.usbVendorId === info.usbVendorId) &&
            (typeof filter.usbProductId === 'undefined' || filter.usbProductId === info.usbProductId)
        );
    }

    /**
     * Adopt a port and publish it as the peripheral list.
     * @param {SerialPort} port - the port to use.
     * @param {object} flags - extra peripheral flags for the GUI.
     * @private
     */
    _publishPort (port, flags) {
        this._port = port;
        // There is no stable id in Web Serial, use a fixed one, the GUI
        // connects to whatever was picked / found.
        const peripheralInfo = Object.assign({
            peripheralId: 'web-serial',
            name: WebSerial._portName(port)
        }, flags);
        this._runtime.emit(
            this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
            {'web-serial': peripheralInfo}
        );
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
                delete autoConnectBlocked[this._deviceId];
                navigator.serial.addEventListener('disconnect', this._handleHardwareDisconnect);
                this._readLoopPromise = this._readLoop();
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                if (this._connectCallback) this._connectCallback();
            })
            .catch(e => {
                // A granted port that will not open (busy in another tab /
                // program, stale handle): stop reusing it silently for the
                // rest of the page session so the next scan shows the chooser.
                autoConnectBlocked[this._deviceId] = true;
                this._handleRequestError(e);
            });
    }

    /**
     * Continuously read from the port and forward the data.
     * @private
     */
    async _readLoop () {
        while (this._connected && !this._lent && this._port && this._port.readable) {
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
        if (!this._connected || this._lent || !this._writer) return Promise.resolve();
        return this._writer.write(data);
    }

    /**
     * Hand the closed SerialPort over to an external protocol driver
     * (esptool-js opens and drives the port itself). The read loop is
     * stopped and all locks are released first; the logical connection
     * state stays "connected" so the GUI does not flicker.
     * @return {Promise<SerialPort>} - the closed port, ready to be opened.
     */
    async lendPort () {
        if (!this._connected || !this._port) {
            throw new Error('No serial port to lend');
        }
        if (this._lent) {
            throw new Error('The serial port is already lent out');
        }
        this._lent = true;
        if (this._reader) {
            await this._reader.cancel().catch(() => null);
        }
        if (this._readLoopPromise) {
            // The loop sees _lent and exits after releasing the reader lock.
            await this._readLoopPromise.catch(() => null);
            this._readLoopPromise = null;
        }
        if (this._writer) {
            try {
                this._writer.releaseLock();
            } catch (e) {
                // Lock already released.
            }
            this._writer = null;
        }
        await this._port.close();
        return this._port;
    }

    /**
     * Take the port back after lendPort: reopen it at the configured baud
     * rate and restart the read loop. Tolerates a borrower that left the
     * port open (close + reopen once).
     * @return {Promise} - resolved when the port is usable again.
     */
    async reclaimPort () {
        if (!this._lent) return;
        this._lent = false;
        if (!this._port || !this._connected) {
            throw new Error('The serial port was lost while lent out');
        }
        const openOptions = {baudRate: this._options.baudRate || 115200};
        try {
            await this._port.open(openOptions);
        } catch (e) {
            await this._port.close().catch(() => null);
            await this._port.open(openOptions);
        }
        this._writer = this._port.writable.getWriter();
        this._readLoopPromise = this._readLoop();
    }

    /**
     * Toggle the DTR/RTS signals to hard-reset a typical ESP32 dev board
     * (EN wired to RTS, IO0 to DTR).
     * @return {Promise} - resolved when the reset pulse is done.
     */
    async hardReset () {
        if (!this._connected || this._lent || !this._port || !this._port.setSignals) return;
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
        this._lent = false;
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
     * USB identity of the picked port, when the browser exposes it.
     * @return {{usbVendorId: ?number, usbProductId: ?number}} - the ids,
     *   undefined fields for non-USB ports.
     */
    getPortInfo () {
        try {
            return (this._port && this._port.getInfo()) || {};
        } catch (e) {
            return {};
        }
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
