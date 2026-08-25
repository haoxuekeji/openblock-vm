const OpenBlockMicroPythonEsp32Device = require('../microPythonEsp32/microPythonEsp32');

/**
 * The list of USB device filters for ESP32-C3 boards.
 * @readonly
 */
const PNPID_LIST = [
    // CH340
    'USB\\VID_1A86&PID_7523',
    // CH9102
    'USB\\VID_1A86&PID_55D4',
    // CP2102
    'USB\\VID_10C4&PID_EA60',
    // Espressif built-in USB serial/JTAG
    'USB\\VID_303A&PID_1001'
];

/**
 * Configuration for the micropython uploader in OpenBlock Link.
 * The esp32-c3 firmware is flashed to 0x0 (the classic esp32 uses 0x1000).
 * @readonly
 */
const DIVECE_OPT = {
    type: 'microPython',
    chip: 'esp32c3',
    firmwarePrefix: 'esp32c3-ble-openblock',
    flashAddress: '0x0',
    // Firmware image served by the GUI, flashed in the browser through
    // esptool-js when the board is connected over Web Serial.
    webFirmware: 'static/firmwares/esp32c3-ble-openblock.bin'
};

/**
 * ESP32-C3 usable GPIO pins. GPIO11-17 are used by the internal flash,
 * GPIO18/19 are the USB D-/D+ pins, GPIO20/21 are UART0 RX/TX.
 */
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
    IO20: '20',
    IO21: '21'
};

const PIN_MENU_ITEMS = Object.keys(Pins).map(key => ({
    text: key,
    value: Pins[key]
}));

/**
 * OpenBlock blocks to interact with a MicroPython esp32-c3 peripheral over
 * a OpenBlock Link client socket. Shares the block set with the esp32
 * device, minus DAC and touch (the C3 has neither), with C3 pin menus.
 */
class OpenBlockMicroPythonEsp32C3Device extends OpenBlockMicroPythonEsp32Device {
    /**
     * @return {string} - the ID of this extension.
     */
    get DEVICE_ID () {
        return 'microPythonEsp32C3';
    }

    get HAS_DAC () {
        return false;
    }

    get HAS_TOUCH () {
        return false;
    }

    get DEFAULT_TRIG_PIN () {
        return Pins.IO5;
    }

    get DEFAULT_ECHO_PIN () {
        return Pins.IO6;
    }

    get PINS_MENU () {
        return PIN_MENU_ITEMS;
    }

    get OUT_PINS_MENU () {
        return PIN_MENU_ITEMS;
    }

    get ANALOG_PINS_MENU () {
        // ADC1 channels 0-4 on GPIO0-4. ADC2 (GPIO5) conflicts with Wi-Fi.
        return PIN_MENU_ITEMS.filter(item => Number(item.value) <= 4);
    }

    /**
     * USB pnp id list of the C3, used by the peripheral constructor of the
     * parent class.
     * @return {Array.<string>} - the pnp id list.
     */
    get PNPID_LIST () {
        return PNPID_LIST;
    }

    /**
     * Uploader options of the C3, used by the peripheral constructor of
     * the parent class.
     * @return {object} - the device options.
     */
    get DIVECE_OPT () {
        return DIVECE_OPT;
    }
}

module.exports = OpenBlockMicroPythonEsp32C3Device;
