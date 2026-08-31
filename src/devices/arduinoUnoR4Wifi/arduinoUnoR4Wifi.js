/**
 * Arduino Uno R4 WiFi
 *
 * @overview Compared to the Arduino Uno R4 Minima, this board uses different
 * USB pids, a different fqbn, and adds an on-board 12x8 LED matrix exposed
 * through the extra "display" block category. Everything else (pins, serial,
 * data blocks and their realtime implementations) is inherited from the
 * R4 Minima device.
 */
const formatMessage = require('format-message');

const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');

const OpenBlockArduinoUnoR4MinimaDevice = require('../arduinoUnoR4Minima/arduinoUnoR4Minima');
const ArduinoPeripheral = require('../common/arduino-peripheral');

/**
 * The list of USB device filters.
 * @readonly
 */
const PNPID_LIST = [
    // https://github.com/arduino/ArduinoCore-renesas/blob/1.4.0/boards.txt#L123-L126
    'USB\\VID_2341&PID_1002',
    'USB\\VID_2341&PID_006D'
];

/**
 * Configuration of serialport
 * @readonly
 */
const SERIAL_CONFIG = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1
};

/**
 * Configuration for arduino-cli.
 * @readonly
 */
const DIVECE_OPT = {
    type: 'arduino',
    fqbn: 'arduino:renesas_uno:unor4wifi'
};

const LedState = {
    On: '1',
    Off: '0'
};

/**
 * Manage communication with a Arduino Uno R4 WiFi peripheral over a OpenBlock Link client socket.
 */
class ArduinoUnoR4Wifi extends ArduinoPeripheral{
    /**
     * Construct a Arduino communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the extension
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoUno
     */
    constructor (runtime, deviceId, originalDeviceId) {
        super(runtime, deviceId, originalDeviceId, PNPID_LIST, SERIAL_CONFIG, DIVECE_OPT);
    }
}

/**
 * OpenBlock blocks to interact with a Arduino Uno R4 WiFi peripheral.
 */
class OpenBlockArduinoUnoR4WifiDevice extends OpenBlockArduinoUnoR4MinimaDevice{
    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'arduinoUnoR4Wifi';
    }

    get LEDSTATE_MENU () {
        return [
            {
                text: formatMessage({
                    id: 'arduinoUnoR4Wifi.ledState.on',
                    default: 'on',
                    description: 'label for led state on'
                }),
                value: LedState.On
            },
            {
                text: formatMessage({
                    id: 'arduinoUnoR4Wifi.ledState.off',
                    default: 'off',
                    description: 'label for led state off'
                }),
                value: LedState.Off
            }
        ];
    }

    /**
     * Construct a set of Arduino blocks.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoUnoR4Wifi
     */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Replace the R4 Minima peripheral registered by the parent
        // constructor with the R4 WiFi one.
        this._peripheral = new ArduinoUnoR4Wifi(this.runtime, this.DEVICE_ID, originalDeviceId);
        this._peripheral.numDigitalPins = 14;
    }

    /**
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        const info = super.getInfo();

        // Insert the on-board LED matrix category after the pins category.
        info.splice(1, 0, {
            id: 'display',
            name: formatMessage({
                id: 'arduinoUnoR4Wifi.category.display',
                default: 'Display',
                description: 'The name of the Arduino Uno R4 Wifi device display category'
            }),
            color1: '#4CBFE6',
            color2: '#2E8EB8',
            color3: '#2E8EB8',
            blocks: [
                {
                    opcode: 'showImage',
                    text: formatMessage({
                        id: 'arduinoUnoR4Wifi.display.showImage',
                        default: 'show image [VALUE]',
                        description: 'Arduino Uno R4 Wifi show image'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        VALUE: {
                            type: ArgumentType.MATRIX8X12,
                            defaultValue: '001100011000010010100100010001000100001000001000000100010000000010100000000001000000000000000000' // eslint-disable-line max-len
                        }
                    }
                },
                {
                    opcode: 'showImageUntil',
                    text: formatMessage({
                        id: 'arduinoUnoR4Wifi.display.showImageUntil',
                        default: 'show image [VALUE] for [TIME] secs',
                        description: 'Arduino Uno R4 Wifi show image for some times'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        VALUE: {
                            type: ArgumentType.MATRIX8X12,
                            defaultValue: '001100011000010010100100010001000100001000001000000100010000000010100000000001000000000000000000' // eslint-disable-line max-len
                        },
                        TIME: {
                            type: ArgumentType.NUMBER,
                            defaultValue: '1'
                        }
                    }
                },
                {
                    opcode: 'showUntilScrollDone',
                    text: formatMessage({
                        id: 'arduinoUnoR4Wifi.display.showUntilScrollDone',
                        default: 'show [TEXT] until scroll done',
                        description: 'Arduino Uno R4 Wifi show until scroll done'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: 'Hello OpenBlock'
                        }
                    }
                },
                {
                    opcode: 'clearDisplay',
                    text: formatMessage({
                        id: 'arduinoUnoR4Wifi.display.clearDisplay',
                        default: 'clear screen',
                        description: 'Arduino Uno R4 Wifi clear display'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'lightPixelAt',
                    text: formatMessage({
                        id: 'arduinoUnoR4Wifi.display.lightPixelAt',
                        default: 'light [STATE] at the x: [X] axis, y: [Y] axis',
                        description: 'Arduino Uno R4 Wifi light pixel at'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        STATE: {
                            type: ArgumentType.STRING,
                            menu: 'ledState',
                            defaultValue: LedState.On
                        },
                        X: {
                            type: ArgumentType.NUMBER,
                            defaultValue: '0'
                        },
                        Y: {
                            type: ArgumentType.NUMBER,
                            defaultValue: '0'
                        }
                    }
                }
            ],
            menus: {
                ledState: {
                    items: this.LEDSTATE_MENU
                }
            }
        });

        return info;
    }
}

module.exports = OpenBlockArduinoUnoR4WifiDevice;
