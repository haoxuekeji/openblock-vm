const CommonPeripheral = require('./common-peripheral');
const MicroPythonBlePeripheral = require('./micropython-ble-peripheral');
const MicroPythonWebSerialPeripheral = require('./micropython-webserial-peripheral');

const TRANSPORT_LINK = 'link';
const TRANSPORT_WEB_SERIAL = 'webserial';
const TRANSPORT_WEB_BLE = 'webble';
const SUPPORTED_TRANSPORTS = [TRANSPORT_LINK, TRANSPORT_WEB_SERIAL, TRANSPORT_WEB_BLE];

/**
 * Route one logical MicroPython device through one of several connection
 * transports. The runtime keeps a single device/peripheral id while this
 * object swaps the concrete Link, Web Serial, or Web Bluetooth implementation.
 */
class MicroPythonMultiTransportPeripheral {
    /**
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} deviceId - canonical device id, e.g. microPythonEsp32.
     * @param {string} originalDeviceId - original device id used by the connection layer.
     * @param {Array.<string>} pnpidList - USB filters for Link and Web Serial.
     * @param {object} serialConfig - Link serial configuration.
     * @param {object} deviceOpt - Link uploader/firmware configuration.
     * @param {string} defaultTransport - initial transport id.
     */
    constructor (
        runtime,
        deviceId,
        originalDeviceId,
        pnpidList,
        serialConfig,
        deviceOpt,
        defaultTransport = TRANSPORT_LINK
    ) {
        this._runtime = runtime;
        this._deviceId = deviceId;
        this._originalDeviceId = originalDeviceId;
        this._pnpidList = pnpidList;
        this._serialConfig = serialConfig;
        this._deviceOpt = deviceOpt;
        this._transport = null;
        this._peripheral = null;

        this._runtime.registerPeripheralExtension(deviceId, this);
        this.setTransport(defaultTransport);
    }

    /**
     * Select the active connection transport. Switching transport always
     * disconnects the previous channel so two raw REPL streams can not write
     * to the same board concurrently.
     * @param {string} transport - link, webserial, or webble.
     * @return {string} the selected transport id.
     */
    setTransport (transport) {
        if (SUPPORTED_TRANSPORTS.indexOf(transport) === -1) {
            throw new Error(`Unsupported MicroPython transport: ${transport}`);
        }
        if (transport === this._transport && this._peripheral) {
            return this._transport;
        }
        if (this._peripheral && typeof this._peripheral.disconnect === 'function') {
            this._peripheral.disconnect();
        }

        const noRegister = {register: false};
        switch (transport) {
        case TRANSPORT_WEB_SERIAL:
            this._peripheral = new MicroPythonWebSerialPeripheral(
                this._runtime,
                this._deviceId,
                this._originalDeviceId,
                this._pnpidList,
                // deviceOpt (chip/flashAddress/webFirmware) enables the
                // browser-side esptool-js firmware flashing on this channel.
                {register: false, deviceOpt: this._deviceOpt}
            );
            break;
        case TRANSPORT_WEB_BLE:
            // No webBluetoothOnly restriction: when the browser has no Web
            // Bluetooth (http deployment, Firefox), the BLE facade falls
            // back to the Link BLE endpoint (/scratch/ble) so the obble
            // transport still works with only openblock-link installed.
            this._peripheral = new MicroPythonBlePeripheral(
                this._runtime,
                this._deviceId,
                this._originalDeviceId,
                {register: false}
            );
            break;
        case TRANSPORT_LINK:
        default:
            this._peripheral = new CommonPeripheral(
                this._runtime,
                this._deviceId,
                this._originalDeviceId,
                this._pnpidList,
                this._serialConfig,
                this._deviceOpt,
                noRegister
            );
            break;
        }
        this._transport = transport;
        return this._transport;
    }

    getTransport () {
        return this._transport;
    }

    getSupportedTransports () {
        return SUPPORTED_TRANSPORTS.slice();
    }

    _call (method, args = [], fallback) {
        if (!this._peripheral || typeof this._peripheral[method] !== 'function') {
            return fallback;
        }
        return this._peripheral[method](...args);
    }

    scan (pnpidList, listAll) {
        return this._call('scan', [pnpidList, listAll]);
    }

    connect (id, baudrate) {
        return this._call('connect', [id, baudrate]);
    }

    disconnect () {
        return this._call('disconnect');
    }

    reset () {
        return this._call('reset');
    }

    isConnected () {
        return this._call('isConnected', [], false);
    }

    setBaudrate (baudrate) {
        return this._call('setBaudrate', [baudrate]);
    }

    write (data) {
        return this._call('write', [data]);
    }

    hardReset () {
        return this._call('hardReset', [], Promise.resolve(false));
    }

    send (message) {
        return this._call('send', [message]);
    }

    upload (code) {
        return this._call('upload', [code]);
    }

    uploadFirmware () {
        return this._call('uploadFirmware');
    }

    canUploadFirmware () {
        return this._call('canUploadFirmware', [], false);
    }

    abortUpload () {
        return this._call('abortUpload');
    }

    isReady () {
        return this._call('isReady', [], false);
    }

    execLive (command, timeout, options) {
        return this._call('execLive', [command, timeout, options], Promise.resolve(null));
    }

    ensureLiveObject (key, initCode) {
        return this._call('ensureLiveObject', [key, initCode], Promise.resolve());
    }

    hasLiveObject (key) {
        return this._call('hasLiveObject', [key], false);
    }

    readLiveString (expression) {
        return this._call('readLiveString', [expression], Promise.resolve(''));
    }

    readLiveNumber (expression) {
        return this._call('readLiveNumber', [expression], Promise.resolve(0));
    }

    setPinMode (pin, mode) {
        return this._call('setPinMode', [pin, mode], Promise.resolve());
    }

    setDigitalOutput (pin, level) {
        return this._call('setDigitalOutput', [pin, level], Promise.resolve());
    }

    setPwmOutput (pin, out) {
        return this._call('setPwmOutput', [pin, out], Promise.resolve());
    }

    setDACOutput (pin, out) {
        return this._call('setDACOutput', [pin, out], Promise.resolve());
    }

    setServoOutput (pin, out) {
        return this._call('setServoOutput', [pin, out], Promise.resolve());
    }

    releaseServo (pin) {
        return this._call('releaseServo', [pin], Promise.resolve());
    }

    readDigitalPin (pin) {
        return this._call('readDigitalPin', [pin], Promise.resolve(0));
    }

    readAnalogPin (pin) {
        return this._call('readAnalogPin', [pin], Promise.resolve(0));
    }

    readTouchPin (pin) {
        return this._call('readTouchPin', [pin], Promise.resolve(0));
    }

    consolePrint (text, eol) {
        return this._call('consolePrint', [text, eol], Promise.resolve());
    }

    setBleDeviceName (name) {
        return this._call('setBleDeviceName', [name], Promise.resolve());
    }

    listBoardFiles (directory) {
        return this._call('listBoardFiles', [directory], Promise.reject(new Error('Board files unsupported')));
    }

    readBoardFile (filePath) {
        return this._call('readBoardFile', [filePath], Promise.reject(new Error('Board files unsupported')));
    }

    removeBoardFile (filePath) {
        return this._call('removeBoardFile', [filePath], Promise.reject(new Error('Board files unsupported')));
    }

    writeBoardFile (filePath, contentBase64) {
        return this._call(
            'writeBoardFile',
            [filePath, contentBase64],
            Promise.reject(new Error('Board files unsupported'))
        );
    }
}

module.exports = MicroPythonMultiTransportPeripheral;
