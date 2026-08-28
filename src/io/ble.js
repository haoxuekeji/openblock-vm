const JSONRPC = require('../util/jsonrpc');
const log = require('../util/log');

const WEB_BLE_CONNECT_TIMEOUT = 15000;
const WEB_BLE_NOTIFICATION_SETUP_TIMEOUT = 2500;
// Silent reconnects (after an upload reboot or a connection drop) must not
// accept a half-open link: a pending notification subscription means the rx
// path may never come up, and the wedged CCCD operation can park every
// later GATT write forever. Give the subscription more time than the user
// path (a healthy Windows stack has been seen taking ~8s), then fail the
// attempt so the reconnect loop retries with a fresh GATT connection.
const WEB_BLE_SILENT_NOTIFICATION_SETUP_TIMEOUT = 8000;
// A GATT write on a silently dead link can stay pending forever on
// Windows (no resolve, no reject, no gattserverdisconnected). Bound every
// write so the callers' await chains always terminate.
const WEB_BLE_GATT_WRITE_TIMEOUT = 10000;

/**
 * localStorage key prefix remembering the last connected Web Bluetooth
 * device per OpenBlock device id, for chooser-free reconnects.
 * @readonly
 */
const WEB_BLE_MEMORY_PREFIX = 'openblock.webble.last.';

/**
 * Chooser-free reconnects that failed during this page session, keyed by
 * the storage key. A granted device that cannot be connected (powered
 * off, out of range) must not trap the user in an endless silent-retry
 * loop: the next scan falls back to the system chooser instead. Cleared
 * by the next successful connection.
 * @type {object}
 */
const autoReconnectBlocked = {};

/**
 * How long a silent reconnect waits for the board to advertise again
 * after the Link session was reopened and a new discovery started.
 * The obble firmware advertises fast for ~30s after a disconnect, and
 * the owner retries the whole attempt several times.
 * @readonly
 */
const SCRATCH_LINK_REDISCOVER_TIMEOUT = 10000;

/**
 * How long a silent reconnect waits for the notification setup in the
 * connect callback before failing the attempt (mirrors the WebBLE
 * silent notification setup bound: a half-open rx path must fail the
 * attempt so the reconnect loop retries from a clean connection).
 * @readonly
 */
const SCRATCH_LINK_NOTIFICATION_SETUP_TIMEOUT = 8000;

/**
 * Sentinel message used when rejecting requests stranded by a closed
 * Link socket, so downstream handlers can tell this apart from a real
 * request error reported by the server.
 * @readonly
 */
const SCRATCH_LINK_SOCKET_CLOSED = 'OpenBlock Link socket closed';

/**
 * Scratch Link based BLE backend using WebSocket + JSON-RPC, served by
 * openblock-link's /scratch/ble endpoint (or the official Scratch Link).
 *
 * Supports the same session semantics as the WebBLE backend so the
 * MicroPython BLE peripheral works over it: connectPeripheral resolves a
 * boolean and accepts {silent} for chooser-free reconnects (including
 * reopening the websocket and rediscovering the board after a reboot),
 * expectDisconnect() suppresses the connection-lost report of a planned
 * board reboot, and an options.onUnexpectedDisconnect callback lets the
 * owner drive automatic reconnects instead of surfacing the loss.
 */
class ScratchLinkBLE extends JSONRPC {
    constructor (runtime, deviceId, peripheralOptions, connectCallback, resetCallback, options = {}) {
        super();

        this._availablePeripherals = {};
        this._connectCallback = connectCallback;
        this._connected = false;
        this._characteristicDidChangeCallback = null;
        this._resetCallback = resetCallback;
        this._onUnexpectedDisconnect = options.onUnexpectedDisconnect || null;
        this._discoverTimeoutID = null;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._runtime = runtime;

        this._expectedDisconnect = false;
        this._silentConnect = false;

        /**
         * Pending silent rediscovery, set while a silent reconnect waits
         * for the target board to advertise again:
         * {peripheralId, resolve, reject} (settling clears the field).
         * Discovery events are not forwarded to the GUI while this is set.
         * @type {?object}
         */
        this._pendingRediscover = null;

        /**
         * Pending socket reopen of a silent reconnect: {resolve, reject},
         * settled by the shared socket handlers (cleared when settled).
         * @type {?object}
         */
        this._pendingSocketOpen = null;

        // Timeouts are injectable for unit tests only.
        this._rediscoverTimeout = options.rediscoverTimeout || SCRATCH_LINK_REDISCOVER_TIMEOUT;
        this._notificationSetupTimeout =
            options.notificationSetupTimeout || SCRATCH_LINK_NOTIFICATION_SETUP_TIMEOUT;

        this._socket = null;
        this._attachSocket(runtime.getScratchLinkSocket('BLE'), this.requestPeripheral.bind(this));
        this._socket.open();
    }

    /**
     * Wire a (new) Link socket to this session. Used for the initial
     * connection and again when a silent reconnect replaces a socket the
     * server closed after the board rebooted.
     * @param {object} socket - a ScratchLinkSocket.
     * @param {Function} onOpen - open handler for this socket.
     * @private
     */
    _attachSocket (socket, onOpen) {
        this._socket = socket;
        this._sendMessage = socket.sendMessage.bind(socket);
        socket.setOnOpen(onOpen);
        socket.setOnClose(this._handleSocketClose.bind(this));
        socket.setOnError(this._handleSocketError.bind(this));
        socket.setHandleMessage(this._handleMessage.bind(this));
    }

    /**
     * The Link socket closed: requests still on the wire will never be
     * answered, so fail them, then treat the close like a connection loss.
     * @private
     */
    _handleSocketClose () {
        this._settlePendingSocketOpen(new Error(SCRATCH_LINK_SOCKET_CLOSED));
        this._rejectOpenRequests(new Error(SCRATCH_LINK_SOCKET_CLOSED));
        if (this._pendingRediscover) {
            this._pendingRediscover.reject(new Error(SCRATCH_LINK_SOCKET_CLOSED));
        }
        this.handleDisconnectError();
    }

    _handleSocketError (e) {
        if (this._pendingSocketOpen || this._pendingRediscover) {
            // A silent reconnect attempt failed to reach the Link server;
            // the owner's retry loop decides whether to report anything.
            this._settlePendingSocketOpen(new Error(SCRATCH_LINK_SOCKET_CLOSED));
            if (this._pendingRediscover) {
                this._pendingRediscover.reject(new Error(SCRATCH_LINK_SOCKET_CLOSED));
            }
            return;
        }
        if (!this._silentConnect) {
            this._handleRequestError(e);
        }
    }

    /**
     * Settle the pending socket reopen of a silent reconnect, if any.
     * @param {?Error} error - reject with this error, or resolve when null.
     * @private
     */
    _settlePendingSocketOpen (error) {
        if (!this._pendingSocketOpen) return;
        const pending = this._pendingSocketOpen;
        this._pendingSocketOpen = null;
        if (error) {
            pending.reject(error);
        } else {
            pending.resolve();
        }
    }

    /**
     * Reject every JSON-RPC request that is still waiting for an answer.
     * @param {Error} error - the rejection reason.
     * @private
     */
    _rejectOpenRequests (error) {
        const requests = this._openRequests;
        this._openRequests = {};
        Object.keys(requests).forEach(id => {
            requests[id].reject(error);
        });
    }

    requestPeripheral () {
        this._availablePeripherals = {};
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._discoverTimeoutID = window.setTimeout(this._handleDiscoverTimeout.bind(this), 15000);
        this.sendRemoteRequest('discover', this._peripheralOptions)
            .catch(e => {
                // The socket error handler already reported unreachable
                // Link servers; do not report the stranded request again.
                if (e && e.message === SCRATCH_LINK_SOCKET_CLOSED) return;
                this._handleRequestError(e);
            });
    }

    /**
     * Connect to a discovered peripheral.
     *
     * A silent connect (options.silent) is a chooser-free reconnect run by
     * the owning peripheral after a board reboot or connection drop: no
     * error events are emitted, failures reject so the caller's retry loop
     * can count them, and a closed Link session is reopened (new socket +
     * rediscovery) transparently.
     * @param {string} id - the peripheral id from didDiscoverPeripheral.
     * @param {object} options - {silent} see above.
     * @return {Promise<boolean>} - true when connected and, for silent
     *   connects, the notification setup completed.
     */
    connectPeripheral (id, options = {}) {
        const silent = options.silent === true;
        this._silentConnect = silent;

        let flow;
        if (silent) {
            flow = this._silentConnectFlow(id);
        } else {
            flow = this.sendRemoteRequest('connect', {peripheralId: id})
                .then(() => {
                    this._connected = true;
                    this._expectedDisconnect = false;
                    this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                    this._connectCallback();
                    return true;
                });
        }

        return flow
            .then(result => {
                this._silentConnect = false;
                return result;
            })
            .catch(e => {
                this._silentConnect = false;
                if (silent) {
                    this._connected = false;
                    throw e;
                }
                this._handleRequestError(e);
                return false;
            });
    }

    /**
     * The silent reconnect flow: make sure a Link session exists and the
     * board has been discovered in it, connect, then wait (bounded) for
     * the notification setup so a half-open rx path fails the attempt.
     * @param {string} id - the peripheral id.
     * @return {Promise<boolean>} - resolves true when the channel is usable.
     * @private
     */
    _silentConnectFlow (id) {
        let ready;
        if (this._socket.isOpen()) {
            ready = Promise.resolve();
        } else {
            // The server closes the session socket when the peripheral
            // drops (e.g. the board rebooted after an upload): open a
            // fresh session and wait for the board to advertise again.
            ready = this._reopenSocket().then(() => this._discoverTarget(id));
        }
        return ready
            .then(() => this.sendRemoteRequest('connect', {peripheralId: id})
                .catch(e => {
                    // The session is fresh or scanning stopped meanwhile:
                    // "invalid peripheral ID" just means the board has to
                    // be discovered (again) before connecting to it.
                    if (e && /invalid peripheral/i.test(`${e.message}`)) {
                        return this._discoverTarget(id)
                            .then(() => this.sendRemoteRequest('connect', {peripheralId: id}));
                    }
                    throw e;
                }))
            .then(() => {
                this._connected = true;
                this._expectedDisconnect = false;
                return this._runBoundedConnectCallback();
            })
            .then(() => {
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                return true;
            });
    }

    /**
     * Open a new Link socket for this session, wired to the same shared
     * handlers as the initial one.
     * @return {Promise} - resolved once the socket is open.
     * @private
     */
    _reopenSocket () {
        return new Promise((resolve, reject) => {
            this._pendingSocketOpen = {resolve, reject};
            const socket = this._runtime.getScratchLinkSocket('BLE');
            this._attachSocket(socket, () => {
                this._settlePendingSocketOpen(null);
            });
            socket.open();
        });
    }

    /**
     * Start a discovery and wait for the target board to advertise.
     * Discovery events are held back from the GUI while this runs (the
     * GUI is showing the reconnecting state, not the scan list).
     * @param {string} peripheralId - the board to wait for.
     * @return {Promise} - resolved when the board was discovered.
     * @private
     */
    _discoverTarget (peripheralId) {
        return new Promise((resolve, reject) => {
            let timer = null;
            const pending = {peripheralId};
            const settle = err => {
                if (this._pendingRediscover === pending) {
                    this._pendingRediscover = null;
                }
                window.clearTimeout(timer);
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };
            pending.resolve = () => settle(null);
            pending.reject = err => settle(err);
            this._pendingRediscover = pending;
            timer = window.setTimeout(() => {
                settle(new Error('Bluetooth device did not advertise again'));
            }, this._rediscoverTimeout);

            this.sendRemoteRequest('discover', this._peripheralOptions)
                .catch(e => settle(e));
        });
    }

    /**
     * Run the connect callback (notification setup) with a time bound.
     * @return {Promise} - resolved when the callback finished in time.
     * @private
     */
    _runBoundedConnectCallback () {
        return new Promise((resolve, reject) => {
            let timer = window.setTimeout(() => {
                timer = null;
                reject(new Error('Bluetooth notification setup timed out'));
            }, this._notificationSetupTimeout);
            Promise.resolve()
                .then(() => this._connectCallback())
                .then(() => {
                    if (timer === null) return;
                    window.clearTimeout(timer);
                    resolve();
                }, e => {
                    if (timer === null) return;
                    window.clearTimeout(timer);
                    reject(e);
                });
        });
    }

    /**
     * Mark the next socket close as part of an intentional board reboot.
     * This suppresses the normal connection-lost event while auto
     * reconnect is in progress.
     */
    expectDisconnect () {
        this._expectedDisconnect = true;
    }

    disconnect (options = {}) {
        const silent = options === true || options.silent === true;
        this._connected = false;
        this._expectedDisconnect = false;
        this._silentConnect = false;
        if (this._socket.isOpen()) {
            this._socket.close();
        }
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        if (!silent) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
        }
    }

    isConnected () {
        return this._connected;
    }

    startNotifications (serviceId, characteristicId, onCharacteristicChanged = null) {
        const params = {serviceId, characteristicId};
        this._characteristicDidChangeCallback = onCharacteristicChanged;
        return this.sendRemoteRequest('startNotifications', params)
            .catch(e => {
                this.handleDisconnectError(e);
            });
    }

    read (serviceId, characteristicId, optStartNotifications = false, onCharacteristicChanged = null) {
        const params = {serviceId, characteristicId};
        if (optStartNotifications) {
            params.startNotifications = true;
        }
        if (onCharacteristicChanged) {
            this._characteristicDidChangeCallback = onCharacteristicChanged;
        }
        return this.sendRemoteRequest('read', params)
            .catch(e => {
                this.handleDisconnectError(e);
            });
    }

    write (serviceId, characteristicId, message, encoding = null, withResponse = null) {
        const params = {serviceId, characteristicId, message};
        if (encoding) {
            params.encoding = encoding;
        }
        if (withResponse !== null) {
            params.withResponse = withResponse;
        }
        return this.sendRemoteRequest('write', params)
            .catch(e => {
                this.handleDisconnectError(e);
                // Callers await their writes: propagate the failure so
                // REPL flows fail fast instead of waiting for an answer
                // to bytes that never reached the board.
                throw e;
            });
    }

    didReceiveCall (method, params) {
        switch (method) {
        case 'didDiscoverPeripheral':
            this._availablePeripherals[params.peripheralId] = params;
            if (this._pendingRediscover) {
                // Silent reconnect in progress: wait for the target board,
                // no scan list updates while the GUI shows "reconnecting".
                if (params.peripheralId === this._pendingRediscover.peripheralId) {
                    this._pendingRediscover.resolve();
                }
                break;
            }
            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                this._availablePeripherals
            );
            if (this._discoverTimeoutID) {
                window.clearTimeout(this._discoverTimeoutID);
            }
            break;
        case 'userDidPickPeripheral':
            this._availablePeripherals[params.peripheralId] = params;
            this._runtime.emit(
                this._runtime.constructor.USER_PICKED_PERIPHERAL,
                this._availablePeripherals
            );
            if (this._discoverTimeoutID) {
                window.clearTimeout(this._discoverTimeoutID);
            }
            break;
        case 'userDidNotPickPeripheral':
            this._runtime.emit(
                this._runtime.constructor.PERIPHERAL_SCAN_TIMEOUT
            );
            if (this._discoverTimeoutID) {
                window.clearTimeout(this._discoverTimeoutID);
            }
            break;
        case 'characteristicDidChange':
            if (this._characteristicDidChangeCallback) {
                this._characteristicDidChangeCallback(params.message);
            }
            break;
        case 'ping':
            return 42;
        }
    }

    handleDisconnectError (/* e */) {
        if (!this._connected) return;
        this._connected = false;
        if (this._expectedDisconnect || this._silentConnect) {
            // A planned board reboot (upload, hard reset) drops the link
            // on purpose; the owner reconnects silently and reports the
            // outcome itself.
            this._expectedDisconnect = false;
            return;
        }
        if (this._onUnexpectedDisconnect) {
            // Hand the loss to the owner, which drives an automatic
            // reconnect and reports it only when that fails.
            this._onUnexpectedDisconnect();
            return;
        }
        this.disconnect();
        if (this._resetCallback) {
            this._resetCallback();
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
            message: `Scratch lost connection to`,
            deviceId: this._deviceId
        });
    }

    _handleRequestError (/* e */) {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
            message: `Scratch lost connection to`,
            deviceId: this._deviceId
        });
    }

    _handleDiscoverTimeout () {
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_SCAN_TIMEOUT);
    }
}

/**
 * Web Bluetooth API based BLE backend.
 * Uses browser native BLE support directly without Scratch Link.
 */
class WebBLE {
    constructor (runtime, deviceId, peripheralOptions, connectCallback, resetCallback, options = {}) {
        this._availablePeripherals = {};
        this._connectCallback = connectCallback;
        this._connected = false;
        this._characteristicDidChangeCallback = null;
        this._resetCallback = resetCallback;
        this._onUnexpectedDisconnect = options.onUnexpectedDisconnect || null;
        this._forceChooser = options.forceChooser === true;
        this._discoverTimeoutID = null;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._runtime = runtime;
        this._storageKey = WEB_BLE_MEMORY_PREFIX + deviceId;

        this._device = null;
        this._server = null;
        this._services = {};
        this._characteristics = {};
        this._expectedDisconnect = false;
        this._silentConnect = false;
        this._connectAttempt = 0;

        // Timeouts are injectable for unit tests only.
        this._notificationSetupTimeout =
            options.notificationSetupTimeout || WEB_BLE_NOTIFICATION_SETUP_TIMEOUT;
        this._silentNotificationSetupTimeout =
            options.silentNotificationSetupTimeout || WEB_BLE_SILENT_NOTIFICATION_SETUP_TIMEOUT;
        this._gattWriteTimeout = options.gattWriteTimeout || WEB_BLE_GATT_WRITE_TIMEOUT;

        /**
         * Whether the current device handle came from the chooser-free
         * remembered-device path; a failed connect then blocks that path
         * for the rest of the page session instead of looping.
         * @type {boolean}
         */
        this._adoptedFromMemory = false;
    }

    requestPeripheral () {
        this._availablePeripherals = {};
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }

        return this._requestRememberedDevice().then(device => {
            if (device) {
                log.info('[WebBLE] Reusing granted device without chooser:', device.name, device.id);
                this._adoptDevice(device, true);
                return;
            }
            return this._requestDeviceViaChooser();
        });
    }

    /**
     * Look up the device of the last successful connection among the
     * already granted devices (navigator.bluetooth.getDevices, persisted
     * permission). Returns null when the chooser must be shown instead:
     * chooser explicitly requested, API unavailable, nothing remembered,
     * a failed silent attempt this session, or a lookup error.
     * @return {Promise<?BluetoothDevice>} - the remembered device or null.
     * @private
     */
    _requestRememberedDevice () {
        if (this._forceChooser || autoReconnectBlocked[this._storageKey]) {
            return Promise.resolve(null);
        }
        if (typeof navigator === 'undefined' || !navigator.bluetooth ||
            typeof navigator.bluetooth.getDevices !== 'function') {
            return Promise.resolve(null);
        }
        const rememberedId = this._recallDeviceId();
        if (!rememberedId) {
            return Promise.resolve(null);
        }
        return navigator.bluetooth.getDevices()
            .then(devices => devices.find(device => device.id === rememberedId) || null)
            .catch(e => {
                log.warn('[WebBLE] getDevices failed, falling back to chooser:', e);
                return null;
            });
    }

    /**
     * Open the system device chooser.
     * @return {Promise} - resolved once the user picked a device.
     * @private
     */
    _requestDeviceViaChooser () {
        const requestOptions = {};
        if (this._peripheralOptions.filters) {
            requestOptions.filters = this._peripheralOptions.filters;
        }
        if (this._peripheralOptions.optionalServices) {
            requestOptions.optionalServices = this._peripheralOptions.optionalServices;
        }

        log.info('[WebBLE] requestDevice with options:', JSON.stringify(requestOptions));

        return navigator.bluetooth.requestDevice(requestOptions)
            .then(device => {
                log.info('[WebBLE] User selected device:', device.name, device.id);
                this._adoptDevice(device, false);
            });
    }

    /**
     * Take a device handle (from the chooser or from the remembered
     * granted devices) and publish it to the peripheral list. A device
     * from memory is flagged so the GUI can skip the click and connect
     * right away.
     * @param {BluetoothDevice} device - the Web Bluetooth device handle.
     * @param {boolean} fromMemory - true for the chooser-free path.
     * @private
     */
    _adoptDevice (device, fromMemory) {
        this._device = device;
        this._adoptedFromMemory = fromMemory;
        device.addEventListener(
            'gattserverdisconnected', this.handleDisconnectError.bind(this));

        const peripheralInfo = {
            peripheralId: device.id,
            name: device.name
        };
        if (fromMemory) {
            peripheralInfo.rememberedDevice = true;
        }
        this._availablePeripherals[device.id] = peripheralInfo;

        this._runtime.emit(
            this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
            this._availablePeripherals
        );
    }

    /**
     * Read the remembered device id of the last successful connection.
     * @return {?string} - the device id or null.
     * @private
     */
    _recallDeviceId () {
        try {
            return window.localStorage.getItem(this._storageKey);
        } catch (e) {
            return null;
        }
    }

    /**
     * Persist the device id after a successful connection.
     * @param {string} id - the Web Bluetooth device id.
     * @private
     */
    _rememberDeviceId (id) {
        try {
            window.localStorage.setItem(this._storageKey, id);
        } catch (e) {
            // Storage unavailable (privacy mode); reconnects keep asking.
        }
    }

    connectPeripheral (id, options = {}) {
        const silent = options.silent === true;
        log.info('[WebBLE] connectPeripheral called, id:', id, 'device:', this._device ? this._device.name : 'null');
        if (!this._device) {
            const error = new Error('No device selected');
            log.warn('[WebBLE] connectPeripheral failed: no device');
            if (!silent) {
                this._handleRequestError(error);
                return Promise.resolve(false);
            }
            return Promise.reject(error);
        }

        // A soft reboot invalidates all GATT service/characteristic handles.
        // Never reuse the cache from the previous connection.
        this._connectAttempt += 1;
        const connectAttempt = this._connectAttempt;
        this._silentConnect = silent;
        this._server = null;
        this._services = {};
        this._characteristics = {};

        let timeoutId = null;
        const connectPromise = this._device.gatt.connect()
            .then(server => {
                if (connectAttempt !== this._connectAttempt) {
                    throw new Error('Bluetooth connection cancelled');
                }
                log.info('[WebBLE] GATT connected successfully');
                this._server = server;
                this._connected = true;
                this._expectedDisconnect = false;

                // Some Chrome/Web Bluetooth combinations establish GATT
                // immediately but leave startNotifications() pending for a
                // long time even though notifications become usable. On a
                // user-initiated connect, start notification setup and wait
                // briefly for real failures, but do not let that browser
                // promise block the connection modal until the global
                // connection timeout. On a silent reconnect however a
                // pending subscription is how the post-upload zombie session
                // is born (rx dead, next GATT write pending forever), so
                // there the attempt fails instead and the reconnect loop
                // retries from a clean GATT connection.
                let notificationTimeoutId = null;
                const notificationSetup = Promise.resolve(this._connectCallback())
                    .then(() => {
                        log.info('[WebBLE] Notification setup completed');
                        return true;
                    });
                const notificationTimeout = new Promise(resolve => {
                    notificationTimeoutId = window.setTimeout(() => {
                        resolve(false);
                    }, silent ? this._silentNotificationSetupTimeout : this._notificationSetupTimeout);
                });
                return Promise.race([notificationSetup, notificationTimeout])
                    .then(result => {
                        window.clearTimeout(notificationTimeoutId);
                        if (result === false) {
                            if (silent) {
                                throw new Error('Bluetooth notification setup timed out');
                            }
                            log.warn('[WebBLE] Notification setup still pending; continuing with GATT connection');
                        }
                        return result;
                    });
            })
            .then(() => {
                if (connectAttempt !== this._connectAttempt) {
                    throw new Error('Bluetooth connection cancelled');
                }
                // The transport is only usable after notification setup in
                // the peripheral connect callback has completed.
                if (!this._connected) {
                    throw new Error('Bluetooth notifications could not be started');
                }
                // Remember the device for future chooser-free reconnects
                // and unblock the silent path after an earlier failure.
                this._rememberDeviceId(this._device.id);
                delete autoReconnectBlocked[this._storageKey];
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                this._silentConnect = false;
                return true;
            });

        const timeoutPromise = new Promise((resolve, reject) => {
            timeoutId = window.setTimeout(() => {
                if (connectAttempt === this._connectAttempt) {
                    this._connectAttempt += 1;
                }
                reject(new Error('Bluetooth connection timed out'));
            }, WEB_BLE_CONNECT_TIMEOUT);
        });

        return Promise.race([connectPromise, timeoutPromise])
            .then(result => {
                window.clearTimeout(timeoutId);
                return result;
            })
            .catch(e => {
                window.clearTimeout(timeoutId);
                log.error('[WebBLE] GATT connect error:', e);
                const suppressError = this._silentConnect || silent;
                if (connectAttempt === this._connectAttempt) {
                    this._connectAttempt += 1;
                }
                if (this._adoptedFromMemory) {
                    // The remembered device could not be connected (powered
                    // off, out of range): the next scan must fall back to
                    // the chooser instead of silently retrying forever.
                    autoReconnectBlocked[this._storageKey] = true;
                }
                this._connected = false;
                this._silentConnect = false;
                if (this._device && this._device.gatt.connected) {
                    this._device.gatt.disconnect();
                }
                this._server = null;
                this._services = {};
                this._characteristics = {};
                if (!suppressError) {
                    this._handleRequestError(e);
                    return false;
                }
                throw e;
            });
    }

    /**
     * Mark the next GATT disconnect as part of an intentional board reboot.
     * This suppresses the normal connection-lost event while auto reconnect
     * is in progress.
     */
    expectDisconnect () {
        this._expectedDisconnect = true;
    }

    disconnect (options = {}) {
        const silent = options === true || options.silent === true;
        log.info('[WebBLE] disconnect called');
        this._connectAttempt += 1;
        this._connected = false;
        this._expectedDisconnect = false;
        this._silentConnect = false;
        if (this._device && this._device.gatt.connected) {
            this._device.gatt.disconnect();
        }
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._server = null;
        this._services = {};
        this._characteristics = {};
        if (!silent) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
        }
    }

    isConnected () {
        return this._connected;
    }

    _getCharacteristic (serviceId, characteristicId) {
        const cacheKey = `${serviceId}__${characteristicId}`;
        if (this._characteristics[cacheKey]) {
            return Promise.resolve(this._characteristics[cacheKey]);
        }

        let servicePromise;
        if (this._services[serviceId]) {
            servicePromise = Promise.resolve(this._services[serviceId]);
        } else {
            servicePromise = this._server.getPrimaryService(serviceId)
                .then(service => {
                    this._services[serviceId] = service;
                    return service;
                });
        }

        return servicePromise
            .then(service => service.getCharacteristic(characteristicId))
            .then(characteristic => {
                this._characteristics[cacheKey] = characteristic;
                return characteristic;
            });
    }

    startNotifications (serviceId, characteristicId, onCharacteristicChanged = null) {
        this._characteristicDidChangeCallback = onCharacteristicChanged;
        return this._getCharacteristic(serviceId, characteristicId)
            .then(characteristic => {
                characteristic.addEventListener('characteristicvaluechanged', event => {
                    if (this._characteristicDidChangeCallback) {
                        this._characteristicDidChangeCallback(
                            WebBLE._dataViewToBase64(event.target.value)
                        );
                    }
                });
                return characteristic.startNotifications();
            });
    }

    read (serviceId, characteristicId, optStartNotifications = false, onCharacteristicChanged = null) {
        if (onCharacteristicChanged) {
            this._characteristicDidChangeCallback = onCharacteristicChanged;
        }
        return this._getCharacteristic(serviceId, characteristicId)
            .then(characteristic => {
                if (optStartNotifications) {
                    characteristic.addEventListener('characteristicvaluechanged', event => {
                        if (this._characteristicDidChangeCallback) {
                            this._characteristicDidChangeCallback(
                                WebBLE._dataViewToBase64(event.target.value)
                            );
                        }
                    });
                    return characteristic.startNotifications()
                        .then(() => characteristic.readValue());
                }
                return characteristic.readValue();
            })
            .then(dataView => ({
                message: WebBLE._dataViewToBase64(dataView),
                encoding: 'base64'
            }))
            .catch(e => {
                this.handleDisconnectError(e);
            });
    }

    write (serviceId, characteristicId, message, encoding = null, withResponse = null) {
        return this._getCharacteristic(serviceId, characteristicId)
            .then(characteristic => {
                let data;
                if (encoding === 'base64') {
                    data = WebBLE._base64ToUint8Array(message);
                } else {
                    data = new TextEncoder().encode(message);
                }
                const writePromise = withResponse ?
                    characteristic.writeValueWithResponse(data) :
                    characteristic.writeValueWithoutResponse(data);
                // Seen live on Windows: after a flapping reconnect the
                // write promise on the dead link never settles and no
                // disconnect event ever fires, parking the awaiting upload
                // flow forever (stuck at "Entering raw REPL..."). Bound the
                // write and treat a timeout like a dropped connection.
                return new Promise((resolve, reject) => {
                    const timer = window.setTimeout(() => {
                        reject(new Error('GATT write timed out'));
                    }, this._gattWriteTimeout);
                    writePromise.then(value => {
                        window.clearTimeout(timer);
                        resolve(value);
                    }, error => {
                        window.clearTimeout(timer);
                        reject(error);
                    });
                });
            })
            .catch(e => {
                this.handleDisconnectError(e);
                // Callers await their writes: propagate the failure so
                // REPL flows fail fast instead of waiting for an answer
                // to bytes that never left the browser.
                throw e;
            });
    }

    handleDisconnectError (e) {
        log.warn('[WebBLE] handleDisconnectError:', e);
        if (!this._connected) return;
        if (this._expectedDisconnect || this._silentConnect) {
            this.disconnect({silent: true});
            return;
        }
        if (this._onUnexpectedDisconnect) {
            // Tear the GATT state down silently and hand over to the
            // owner, which drives an automatic reconnect using the still
            // granted device handle and reports the loss itself only
            // when that fails.
            this.disconnect({silent: true});
            this._onUnexpectedDisconnect();
            return;
        }
        this.disconnect();
        if (this._resetCallback) {
            this._resetCallback();
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
            message: `Scratch lost connection to`,
            deviceId: this._deviceId
        });
    }

    _handleRequestError (e) {
        log.error('[WebBLE] _handleRequestError:', e);
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
            message: (e && e.message) || 'Bluetooth connection failed',
            deviceId: this._deviceId
        });
    }

    static _base64ToUint8Array (base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    static _dataViewToBase64 (dataView) {
        const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }
}

/**
 * BLE facade that first tries the browser's Web Bluetooth API.
 * If the browser doesn't support it, permissions are denied, or the user cancels
 * the device picker, it automatically falls back to the Scratch Link backend.
 *
 * @param {Runtime} runtime - the Runtime for sending/receiving GUI update events.
 * @param {string} deviceId - the id of the extension using this object.
 * @param {object} peripheralOptions - the list of options for peripheral discovery.
 * @param {object} connectCallback - a callback for connection.
 * @param {object} resetCallback - a callback for resetting extension state.
 * @param {object} options - backend selection options.
 * @param {boolean} options.webOnly - do not fall back to Scratch Link.
 * @param {Function} options.onUnexpectedDisconnect - when set, an unexpected
 *   GATT disconnect is handed to this callback (after a silent teardown)
 *   instead of emitting the connection-lost error, so the owner can try an
 *   automatic reconnect first. Web Bluetooth backend only.
 * @param {boolean} options.forceChooser - always show the system device
 *   chooser instead of silently reusing the remembered granted device
 *   (user explicitly rescans to switch boards). Web Bluetooth backend only.
 */
class BLE {
    constructor (runtime, deviceId, peripheralOptions, connectCallback, resetCallback = null, options = {}) {
        this._runtime = runtime;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._connectCallback = connectCallback;
        this._resetCallback = resetCallback;
        this._webOnly = options.webOnly === true;
        this._onUnexpectedDisconnect = options.onUnexpectedDisconnect || null;
        this._forceChooser = options.forceChooser === true;

        this._backend = null;

        if (BLE._isWebBluetoothSupported()) {
            log.info('[BLE] Web Bluetooth API is supported, trying browser picker');
            this._tryWebBluetooth();
        } else if (this._webOnly) {
            Promise.resolve().then(() => {
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                    message: 'Web Bluetooth API is not supported in this browser',
                    deviceId: this._deviceId
                });
            });
        } else {
            log.info('[BLE] Web Bluetooth API not supported, using Scratch Link');
            this._useScratchLink();
        }
    }

    static _isWebBluetoothSupported () {
        return typeof navigator !== 'undefined' &&
            navigator.bluetooth &&
            typeof navigator.bluetooth.requestDevice === 'function';
    }

    _tryWebBluetooth () {
        const webBLE = new WebBLE(
            this._runtime, this._deviceId, this._peripheralOptions,
            this._connectCallback, this._resetCallback,
            {
                onUnexpectedDisconnect: this._onUnexpectedDisconnect,
                forceChooser: this._forceChooser
            }
        );
        // Set backend immediately so connectPeripheral can find it
        // after PERIPHERAL_LIST_UPDATE is emitted
        this._backend = webBLE;

        webBLE.requestPeripheral()
            .then(() => {
                log.info('[BLE] Web Bluetooth device selected, backend ready');
            })
            .catch(e => {
                if (this._webOnly) {
                    this._backend = null;
                    this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
                        message: (e && e.message) || 'No Bluetooth device selected',
                        deviceId: this._deviceId
                    });
                    return;
                }
                log.info('[BLE] Web Bluetooth cancelled or denied:', e, ', falling back to Scratch Link');
                // User cancelled or permission denied, fall back to Scratch Link
                this._useScratchLink();
            });
    }

    _useScratchLink () {
        log.info('[BLE] Initializing Scratch Link backend');
        this._backend = new ScratchLinkBLE(
            this._runtime, this._deviceId, this._peripheralOptions,
            this._connectCallback, this._resetCallback,
            {onUnexpectedDisconnect: this._onUnexpectedDisconnect}
        );
    }

    requestPeripheral () {
        log.info('[BLE] requestPeripheral, backend:', this._backend ? this._backend.constructor.name : 'null');
        if (this._backend) {
            this._backend.requestPeripheral();
        }
    }

    connectPeripheral (id, options = {}) {
        const backendName = this._backend ? this._backend.constructor.name : 'null';
        log.info('[BLE] connectPeripheral, id:', id, ', backend:', backendName);
        if (this._backend) {
            return this._backend.connectPeripheral(id, options);
        }
        log.error('[BLE] connectPeripheral called but no backend available');
        return options.silent ? Promise.reject(new Error('No BLE backend')) : Promise.resolve(false);
    }

    expectDisconnect () {
        if (this._backend && typeof this._backend.expectDisconnect === 'function') {
            this._backend.expectDisconnect();
        }
    }

    disconnect (options = {}) {
        if (this._backend) {
            this._backend.disconnect(options);
        }
    }

    isConnected () {
        return this._backend ? this._backend.isConnected() : false;
    }

    startNotifications (serviceId, characteristicId, onCharacteristicChanged = null) {
        if (this._backend) {
            return this._backend.startNotifications(serviceId, characteristicId, onCharacteristicChanged);
        }
        return Promise.reject(new Error('No BLE backend'));
    }

    read (serviceId, characteristicId, optStartNotifications = false, onCharacteristicChanged = null) {
        if (this._backend) {
            return this._backend.read(serviceId, characteristicId, optStartNotifications, onCharacteristicChanged);
        }
        return Promise.reject(new Error('No BLE backend'));
    }

    write (serviceId, characteristicId, message, encoding = null, withResponse = null) {
        if (this._backend) {
            return this._backend.write(serviceId, characteristicId, message, encoding, withResponse);
        }
        return Promise.reject(new Error('No BLE backend'));
    }

    handleDisconnectError (e) {
        if (this._backend) {
            this._backend.handleDisconnectError(e);
        }
    }
}

module.exports = BLE;
// Exposed for unit tests of the chooser-free reconnect logic.
module.exports.WebBLE = WebBLE;
module.exports.ScratchLinkBLE = ScratchLinkBLE;
