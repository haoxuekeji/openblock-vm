/**
 * Arduino ESP32-S3
 *
 * @overview Compared to the classic Arduino ESP32, this board uses different
 * USB pids, a different fqbn, and a different GPIO set (IO0-IO21 and
 * IO38-IO44, all output capable, ADC on IO1-IO20, touch on IO1-IO15) and has
 * no DAC. Everything else (block set, menus, realtime implementations) is
 * inherited from the ESP32 device.
 */
const OpenBlockArduinoEsp32Device = require('../arduinoEsp32/arduinoEsp32');
const CommonPeripheral = require('../common/common-peripheral');

/**
 * The list of USB device filters.
 * @readonly
 */
const PNPID_LIST = [
    // CH340
    'USB\\VID_1A86&PID_7523',
    // CH343
    'USB\\VID_1A86&PID_55D3',
    // CH9102
    'USB\\VID_1A86&PID_55D4',
    // CP2102
    'USB\\VID_10C4&PID_EA60'
];

/**
 * Configuration of serialport
 * @readonly
 */
const SERIAL_CONFIG = {
    baudRate: 57600,
    dataBits: 8,
    stopBits: 1
};

/**
 * Configuration for arduino-cli.
 * @readonly
 */
const DIVECE_OPT = {
    type: 'arduino',
    // Upload Speed: "921600" for windows, "460800" for mac and linux
    // USB Mode: "Hardware CDC and JTAG"
    // USB CDC On Boot: "Disabled'
    // USB Firmware MSC On Boot: "Disabled
    // USB DFU On Boot: "Disabled
    // Upload Mode: "UART0 / Hardware CDC
    // CPU Frequency: "240MHz (WiFì)"
    // Flash Mode: "QIO 80MHz'
    // Flash Size: "4MB (32Mb)"
    // Partition Scheme: "Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)"
    // Core Debug Level: "None"
    // PSRAM: "Disabled"
    // Arduino Runs On: "Core 1"
    // Events Run On: "Core 1"
    // Erase All Flash Before Sketch Upload: "Disabled"
    // JTAG Adapter: "Disabled"
    // Zigbee Mode: "Disabled"
    fqbn: {
        darwin: 'esp32:esp32:esp32s3:JTAGAdapter=default,PSRAM=disabled,FlashMode=qio,FlashSize=4M,LoopCore=1,EventsCore=1,USBMode=hwcdc,CDCOnBoot=default,MSCOnBoot=default,DFUOnBoot=default,UploadMode=default,PartitionScheme=default,CPUFreq=240,UploadSpeed=460800,DebugLevel=none,EraseFlash=none,ZigbeeMode=default', // eslint-disable-line max-len
        linux: 'esp32:esp32:esp32s3:JTAGAdapter=default,PSRAM=disabled,FlashMode=qio,FlashSize=4M,LoopCore=1,EventsCore=1,USBMode=hwcdc,CDCOnBoot=default,MSCOnBoot=default,DFUOnBoot=default,UploadMode=default,PartitionScheme=default,CPUFreq=240,UploadSpeed=460800,DebugLevel=none,EraseFlash=none,ZigbeeMode=default', // eslint-disable-line max-len
        win32: 'esp32:esp32:esp32s3:JTAGAdapter=default,PSRAM=disabled,FlashMode=qio,FlashSize=4M,LoopCore=1,EventsCore=1,USBMode=hwcdc,CDCOnBoot=default,MSCOnBoot=default,DFUOnBoot=default,UploadMode=default,PartitionScheme=default,CPUFreq=240,UploadSpeed=921600,DebugLevel=none,EraseFlash=none,ZigbeeMode=default' // eslint-disable-line max-len
    }
};

const Pins = {
    IO0: '0',
    IO1: '1',
    IO2: '2',
    IO3: '3',
    IO4: '4',
    IO5: '5',
    IO6: '6',
    IO7: '7',
    IO8: '8',
    IO9: '9',
    IO10: '10',
    IO11: '11',
    IO12: '12',
    IO13: '13',
    IO14: '14',
    IO15: '15',
    IO16: '16',
    IO17: '17',
    IO18: '18',
    IO19: '19',
    IO20: '20',
    IO21: '21',
    IO35: '35',
    IO36: '36',
    IO37: '37',
    IO38: '38',
    IO39: '39',
    IO40: '40',
    IO41: '41',
    IO42: '42',
    IO43: '43',
    IO44: '44'
};

/**
 * Manage communication with a Arduino esp32-S3 peripheral over a OpenBlock Link client socket.
 */
class ArduinoEsp32S3 extends CommonPeripheral{
    /**
     * Construct a Arduino communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the extension
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoEsp32S3
     */
    constructor (runtime, deviceId, originalDeviceId) {
        super(runtime, deviceId, originalDeviceId, PNPID_LIST, SERIAL_CONFIG, DIVECE_OPT);
    }
}

/**
 * OpenBlock blocks to interact with a Arduino esp32-S3 peripheral.
 */
class OpenBlockArduinoEsp32S3Device extends OpenBlockArduinoEsp32Device{
    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'arduinoEsp32S3';
    }

    get PINS_MENU () {
        return [
            {
                text: 'IO0',
                value: Pins.IO0
            },
            {
                text: 'IO1',
                value: Pins.IO1
            },
            {
                text: 'IO2',
                value: Pins.IO2
            },
            {
                text: 'IO3',
                value: Pins.IO3
            },
            {
                text: 'IO4',
                value: Pins.IO4
            },
            {
                text: 'IO5',
                value: Pins.IO5
            },
            {
                text: 'IO6',
                value: Pins.IO6
            },
            {
                text: 'IO7',
                value: Pins.IO7
            },
            {
                text: 'IO8',
                value: Pins.IO8
            },
            {
                text: 'IO9',
                value: Pins.IO9
            },
            {
                text: 'IO10',
                value: Pins.IO10
            },
            {
                text: 'IO11',
                value: Pins.IO11
            },
            {
                text: 'IO12',
                value: Pins.IO12
            },
            {
                text: 'IO13',
                value: Pins.IO13
            },
            {
                text: 'IO14',
                value: Pins.IO14
            },
            {
                text: 'IO15',
                value: Pins.IO15
            },
            {
                text: 'IO16',
                value: Pins.IO16
            },
            {
                text: 'IO17',
                value: Pins.IO17
            },
            {
                text: 'IO18',
                value: Pins.IO18
            },
            {
                text: 'IO19',
                value: Pins.IO19
            },
            {
                text: 'IO20',
                value: Pins.IO20
            },
            {
                text: 'IO21',
                value: Pins.IO21
            },
            // IO35-37 are used by octal flash, not recommended for general use.
            // {
            //     text: 'IO35',
            //     value: Pins.IO35
            // },
            // {
            //     text: 'IO36',
            //     value: Pins.IO36
            // },
            // {
            //     text: 'IO37',
            //     value: Pins.IO37
            // },
            {
                text: 'IO38',
                value: Pins.IO38
            },
            {
                text: 'IO39',
                value: Pins.IO39
            },
            {
                text: 'IO40',
                value: Pins.IO40
            },
            {
                text: 'IO41',
                value: Pins.IO41
            },
            {
                text: 'IO42',
                value: Pins.IO42
            },
            {
                text: 'IO43',
                value: Pins.IO43
            },
            {
                text: 'IO44',
                value: Pins.IO44
            }
        ];
    }

    /**
     * Unlike the classic ESP32 whose IO34-IO39 are input only, every usable
     * S3 GPIO is output capable, so the out pins menu equals the pins menu.
     * @return {Array.<object>} - the out pins menu items.
     */
    get OUT_PINS_MENU () {
        return this.PINS_MENU;
    }

    get ANALOG_PINS_MENU () {
        return [
            {
                text: 'IO1',
                value: Pins.IO1
            },
            {
                text: 'IO2',
                value: Pins.IO2
            },
            {
                text: 'IO3',
                value: Pins.IO3
            },
            {
                text: 'IO4',
                value: Pins.IO4
            },
            {
                text: 'IO5',
                value: Pins.IO5
            },
            {
                text: 'IO6',
                value: Pins.IO6
            },
            {
                text: 'IO7',
                value: Pins.IO7
            },
            {
                text: 'IO8',
                value: Pins.IO8
            },
            {
                text: 'IO9',
                value: Pins.IO9
            },
            {
                text: 'IO10',
                value: Pins.IO10
            },
            {
                text: 'IO11',
                value: Pins.IO11
            },
            {
                text: 'IO12',
                value: Pins.IO12
            },
            {
                text: 'IO13',
                value: Pins.IO13
            },
            {
                text: 'IO14',
                value: Pins.IO14
            },
            {
                text: 'IO15',
                value: Pins.IO15
            },
            {
                text: 'IO16',
                value: Pins.IO16
            },
            {
                text: 'IO17',
                value: Pins.IO17
            },
            {
                text: 'IO18',
                value: Pins.IO18
            },
            {
                text: 'IO19',
                value: Pins.IO19
            },
            {
                text: 'IO20',
                value: Pins.IO20
            }
        ];
    }

    get TOUCH_PINS_MENU () {
        return [
            {
                text: 'IO1',
                value: Pins.IO1
            },
            {
                text: 'IO2',
                value: Pins.IO2
            },
            {
                text: 'IO3',
                value: Pins.IO3
            },
            {
                text: 'IO4',
                value: Pins.IO4
            },
            {
                text: 'IO5',
                value: Pins.IO5
            },
            {
                text: 'IO6',
                value: Pins.IO6
            },
            {
                text: 'IO7',
                value: Pins.IO7
            },
            {
                text: 'IO8',
                value: Pins.IO8
            },
            {
                text: 'IO9',
                value: Pins.IO9
            },
            {
                text: 'IO10',
                value: Pins.IO10
            },
            {
                text: 'IO11',
                value: Pins.IO11
            },
            {
                text: 'IO12',
                value: Pins.IO12
            },
            {
                text: 'IO13',
                value: Pins.IO13
            },
            {
                text: 'IO14',
                value: Pins.IO14
            },
            {
                text: 'IO15',
                value: Pins.IO15
            }
        ];
    }

    /**
     * Construct a set of Arduino blocks.
     * @param {Runtime} runtime - the OpenBlock runtime.
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_arduinoEsp32S3
     */
    constructor (runtime, originalDeviceId) {
        super(runtime, originalDeviceId);

        // Replace the ESP32 peripheral registered by the parent constructor
        // with the ESP32-S3 one.
        this._peripheral = new ArduinoEsp32S3(this.runtime, this.DEVICE_ID, originalDeviceId);
    }

    /**
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        const info = super.getInfo();

        // The S3 has no DAC, drop the DAC block and its pins menu.
        const pinCategory = info.find(category => category.id === 'pin');
        pinCategory.blocks = pinCategory.blocks.filter(block => block.opcode !== 'esp32SetDACOutput');
        delete pinCategory.menus.dacPins;

        return info;
    }
}

module.exports = OpenBlockArduinoEsp32S3Device;
