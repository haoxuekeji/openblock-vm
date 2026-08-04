const Buffer = require('buffer').Buffer;

const Serialport = require('../../io/serialport');
const Base64Util = require('../../util/base64-util');

/**
 * Manage communication with a common peripheral over a OpenBlock Link client socket.
 */
class CommonPeripheral{

    /**
     * Construct a common communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the peripheral
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoUno
     * @param {object} pnpidList - the pnp id of the peripheral
     * @param {object} serialConfig - the serial config of the peripheral
     * @param {object} diveceOpt - the device optione of the peripheral
     * @param {object} options - construction options.
     * @param {boolean} options.register - whether to register this instance in the runtime.
     */
    constructor (runtime, deviceId, originalDeviceId, pnpidList, serialConfig, diveceOpt, options = {}) {
        /**
         * The OpenBlock runtime used to trigger the green flag button.
         * @type {Runtime}
         * @private
         */
        this._runtime = runtime;

        this.pnpidList = pnpidList;
        this.serialConfig = serialConfig;
        this.diveceOpt = diveceOpt;

        /**
         * The serialport connection socket for reading/writing peripheral data.
         * @type {SERIALPORT}
         * @private
         */
        this._serialport = null;
        if (options.register !== false) {
            this._runtime.registerPeripheralExtension(deviceId, this);
        }
        this._runtime.setRealtimeBaudrate(this.serialConfig.baudRate);

        /**
         * The id of the peripheral this peripheral belongs to.
         */
        this._deviceId = deviceId;

        this._originalDeviceId = originalDeviceId;

        /**
        * Pending data list. If busy is set when send, the data will push into this array to
        * waitting to be sended.
        */
        this._pendingData = [];

        this.reset = this.reset.bind(this);
        this._onConnect = this._onConnect.bind(this);
        this._onMessage = this._onMessage.bind(this);
    }

    /**
     * Called by the runtime when user wants to upload code to a peripheral.
     * @param {string} code - the code want to upload.
     */
    upload (code) {
        const base64Str = Buffer.from(code).toString('base64');
        this._serialport.upload(base64Str, this.diveceOpt, 'base64');
    }

    /**
     * Called by the runtime when user wants to upload realtime firmware to a peripheral.
     */
    uploadFirmware () {
        this._serialport.uploadFirmware(this.diveceOpt);
    }


    /**
     * Called by the runtime when user wants to abort the uploading process.
     */
    abortUpload () {
        this._serialport.abortUpload();
    }

    /**
     * Called by the runtime when user wants to scan for a peripheral.
     * @param {Array.<string>} pnpidList - the array of pnp id list
     * @param {bool} listAll - wether list all connectable device
     */
    scan (pnpidList, listAll) {
        if (this._serialport) {
            this._serialport.disconnect();
        }
        this._serialport = new Serialport(this._runtime, this._originalDeviceId, {
            filters: {
                pnpid: listAll ? ['*'] : (pnpidList ? pnpidList : this.pnpidList)
            }
        }, this._onConnect, this.reset);
    }

    /**
     * Called by the runtime when user wants to connect to a certain peripheral.
     * @param {number} id - the id of the peripheral to connect to.
     * @param {?number} baudrate - the baudrate.
     */
    connect (id, baudrate = null) {
        const config = Object.assign({}, this.serialConfig);
        if (baudrate) {
            config.baudRate = baudrate;
        }
        if (this._serialport) {
            this._serialport.connectPeripheral(id, {config: config});
        }
    }

    /**
     * Disconnect from the peripheral.
     */
    disconnect () {
        if (this._serialport) {
            this._serialport.disconnect();
        }

        this.reset();
    }

    /**
     * Reset all the state and timeout/interval ids.
     */
    reset () {
    }

    /**
     * Return true if connected to the peripheral.
     * @return {boolean} - whether the peripheral is connected.
     */
    isConnected () {
        let connected = false;
        if (this._serialport) {
            connected = this._serialport.isConnected();
        }
        return connected;
    }

    /**
     * Set baudrate of the peripheral serialport.
     * @param {number} baudrate - the baudrate.
     */
    setBaudrate (baudrate) {
        this._serialport.setBaudrate(baudrate);
    }

    /**
     * Write data to the peripheral serialport.
     * @param {string} data - the data to write.
     */
    write (data) {
        if (!this.isConnected()) return;

        const base64Str = Buffer.from(data).toString('base64');
        this._serialport.write(base64Str, 'base64');
    }

    /**
     * Hard reset the board by pulsing the serial DTR/RTS control lines.
     * @return {Promise<boolean>} - true when the request was sent.
     */
    hardReset () {
        if (!this.isConnected()) return Promise.resolve(false);

        return Promise.resolve(this._serialport.hardReset()).then(() => true);
    }

    /**
     * Send a message to the peripheral Serialport socket.
     * @param {Uint8Array} message - the message to write
     */
    send (message) {
        if (!this.isConnected()) return;

        const data = Base64Util.uint8ArrayToBase64(message);
        this._serialport.write(data, 'base64');
    }

    /**
     * List files on the board through OpenBlock Link / obmpy.
     * @param {string} directory - board directory.
     * @return {Promise<Array>}
     */
    listBoardFiles (directory = '.') {
        if (!this.isConnected()) {
            return Promise.reject(new Error('No peripheral is connected'));
        }
        return this._serialport.listBoardFiles(directory, this.diveceOpt);
    }

    /**
     * Read a board file through OpenBlock Link / obmpy.
     * @param {string} filePath - board path.
     * @return {Promise<object>}
     */
    readBoardFile (filePath) {
        if (!this.isConnected()) {
            return Promise.reject(new Error('No peripheral is connected'));
        }
        return this._serialport.readBoardFile(filePath, this.diveceOpt);
    }

    /**
     * Remove a board file through OpenBlock Link / obmpy.
     * @param {string} filePath - board path.
     * @return {Promise<boolean>}
     */
    removeBoardFile (filePath) {
        if (!this.isConnected()) {
            return Promise.reject(new Error('No peripheral is connected'));
        }
        return this._serialport.removeBoardFile(filePath, this.diveceOpt);
    }

    /**
     * Write a board file through OpenBlock Link / obmpy.
     * @param {string} filePath - board path.
     * @param {string} contentBase64 - file content.
     * @return {Promise<boolean>}
     */
    writeBoardFile (filePath, contentBase64) {
        if (!this.isConnected()) {
            return Promise.reject(new Error('No peripheral is connected'));
        }
        return this._serialport.writeBoardFile(filePath, contentBase64, this.diveceOpt);
    }

    /**
     * Starts reading data from peripheral after serialport has connected to it.
     * @private
     */
    _onConnect () {
        this._serialport.read(this._onMessage);
    }

    /**
     * Process the sensor data from the incoming serialport characteristic.
     * @param {object} base64 - the incoming serialport data.
     * @private
     */
    _onMessage (base64) {
        const consoleData = Buffer.from(base64, 'base64');
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_RECIVE_DATA, consoleData);
    }
}

module.exports = CommonPeripheral;
