const JSONRPC = require('../util/jsonrpc');
const log = require('../util/log');

const WEB_BLE_CONNECT_TIMEOUT = 15000;
const WEB_BLE_NOTIFICATION_SETUP_TIMEOUT = 2500;

/**
 * Scratch Link based BLE backend using WebSocket + JSON-RPC.
 * This is the original implementation that communicates through Scratch Link.
 */
class ScratchLinkBLE extends JSONRPC {
    constructor (runtime, deviceId, peripheralOptions, connectCallback, resetCallback) {
        super();

        this._socket = runtime.getScratchLinkSocket('BLE');
        this._socket.setOnOpen(this.requestPeripheral.bind(this));
        this._socket.setOnClose(this.handleDisconnectError.bind(this));
        this._socket.setOnError(this._handleRequestError.bind(this));
        this._socket.setHandleMessage(this._handleMessage.bind(this));

        this._sendMessage = this._socket.sendMessage.bind(this._socket);

        this._availablePeripherals = {};
        this._connectCallback = connectCallback;
        this._connected = false;
        this._characteristicDidChangeCallback = null;
        this._resetCallback = resetCallback;
        this._discoverTimeoutID = null;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._runtime = runtime;

        this._socket.open();
    }

    requestPeripheral () {
        this._availablePeripherals = {};
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._discoverTimeoutID = window.setTimeout(this._handleDiscoverTimeout.bind(this), 15000);
        this.sendRemoteRequest('discover', this._peripheralOptions)
            .catch(e => {
                this._handleRequestError(e);
            });
    }

    connectPeripheral (id) {
        this.sendRemoteRequest('connect', {peripheralId: id})
            .then(() => {
                this._connected = true;
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTED);
                this._connectCallback();
            })
            .catch(e => {
                this._handleRequestError(e);
            });
    }

    disconnect () {
        if (this._connected) {
            this._connected = false;
        }
        if (this._socket.isOpen()) {
            this._socket.close();
        }
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
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
            });
    }

    didReceiveCall (method, params) {
        switch (method) {
        case 'didDiscoverPeripheral':
            this._availablePeripherals[params.peripheralId] = params;
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
        this._discoverTimeoutID = null;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._runtime = runtime;

        this._device = null;
        this._server = null;
        this._services = {};
        this._characteristics = {};
        this._expectedDisconnect = false;
        this._silentConnect = false;
        this._connectAttempt = 0;
    }

    requestPeripheral () {
        this._availablePeripherals = {};
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }

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
                this._device = device;
                device.addEventListener(
                    'gattserverdisconnected', this.handleDisconnectError.bind(this));

                const peripheralInfo = {
                    peripheralId: device.id,
                    name: device.name
                };
                this._availablePeripherals[device.id] = peripheralInfo;

                this._runtime.emit(
                    this._runtime.constructor.PERIPHERAL_LIST_UPDATE,
                    this._availablePeripherals
                );
            });
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
                // long time even though notifications become usable. Start
                // notification setup and wait briefly for real failures, but
                // do not let that browser promise block the connection modal
                // until the global connection timeout.
                let notificationTimeoutId = null;
                const notificationSetup = Promise.resolve(this._connectCallback())
                    .then(() => {
                        log.info('[WebBLE] Notification setup completed');
                        return true;
                    });
                const notificationTimeout = new Promise(resolve => {
                    notificationTimeoutId = window.setTimeout(() => {
                        log.warn('[WebBLE] Notification setup still pending; continuing with GATT connection');
                        resolve(false);
                    }, WEB_BLE_NOTIFICATION_SETUP_TIMEOUT);
                });
                return Promise.race([notificationSetup, notificationTimeout])
                    .then(result => {
                        window.clearTimeout(notificationTimeoutId);
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
                if (withResponse) {
                    return characteristic.writeValueWithResponse(data);
                }
                return characteristic.writeValueWithoutResponse(data);
            })
            .catch(e => {
                this.handleDisconnectError(e);
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
            {onUnexpectedDisconnect: this._onUnexpectedDisconnect}
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
            this._connectCallback, this._resetCallback
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
