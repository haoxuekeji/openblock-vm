const JSONRPC = require('../util/jsonrpc');

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
    constructor (runtime, deviceId, peripheralOptions, connectCallback, resetCallback) {
        this._availablePeripherals = {};
        this._connectCallback = connectCallback;
        this._connected = false;
        this._characteristicDidChangeCallback = null;
        this._resetCallback = resetCallback;
        this._discoverTimeoutID = null;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._runtime = runtime;

        this._device = null;
        this._server = null;
        this._services = {};
        this._characteristics = {};
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

        return navigator.bluetooth.requestDevice(requestOptions)
            .then(device => {
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

    connectPeripheral (id) {
        if (!this._device) {
            this._handleRequestError(new Error('No device selected'));
            return;
        }

        this._device.gatt.connect()
            .then(server => {
                this._server = server;
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
        if (this._device && this._device.gatt.connected) {
            this._device.gatt.disconnect();
        }
        if (this._discoverTimeoutID) {
            window.clearTimeout(this._discoverTimeoutID);
        }
        this._services = {};
        this._characteristics = {};
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_DISCONNECTED);
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
            })
            .catch(e => {
                this.handleDisconnectError(e);
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
 */
class BLE {
    constructor (runtime, deviceId, peripheralOptions, connectCallback, resetCallback = null) {
        this._runtime = runtime;
        this._deviceId = deviceId;
        this._peripheralOptions = peripheralOptions;
        this._connectCallback = connectCallback;
        this._resetCallback = resetCallback;

        this._backend = null;

        if (BLE._isWebBluetoothSupported()) {
            this._tryWebBluetooth();
        } else {
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
            this._connectCallback, this._resetCallback
        );
        webBLE.requestPeripheral()
            .then(() => {
                // User picked a device, use Web Bluetooth
                this._backend = webBLE;
            })
            .catch(() => {
                // User cancelled or permission denied, fall back to Scratch Link
                this._useScratchLink();
            });
    }

    _useScratchLink () {
        this._backend = new ScratchLinkBLE(
            this._runtime, this._deviceId, this._peripheralOptions,
            this._connectCallback, this._resetCallback
        );
    }

    requestPeripheral () {
        if (this._backend) {
            this._backend.requestPeripheral();
        }
    }

    connectPeripheral (id) {
        if (this._backend) {
            this._backend.connectPeripheral(id);
        }
    }

    disconnect () {
        if (this._backend) {
            this._backend.disconnect();
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
