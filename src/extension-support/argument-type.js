/**
 * Block argument types
 * @enum {string}
 */
const ArgumentType = {
    /**
     * Numeric value with angle picker
     */
    ANGLE: 'angle',

    /**
     * Boolean value with hexagonal placeholder
     */
    BOOLEAN: 'Boolean',

    /**
     * Numeric value with color picker
     */
    COLOR: 'color',

    /**
     * Numeric value with angle picker, value from 0 ~ 180
     */
    HALF_ANGLE: 'half_angle',

    /**
     * Inline image on block (as part of the label)
     */
    IMAGE: 'image',

    /**
     * Numeric value with text field
     */
    NUMBER: 'number',

    /**
     * String value with text field
     */
    STRING: 'string',

    /**
     * String value with matrix field
     */
    MATRIX: 'matrix',

    /**
     * MIDI note number with note picker (piano) field
     */
    NOTE: 'note',

    /**
     * Numeric value with slider field. from 0 to 100 value
     */
    OTO100_NUMBER: '0to100_number',

    /**
     * Numeric value with slider field. from 0 to 255 integer value
     */
    UINT8_NUMBER: 'uint8_number',

    /**
     * Numeric value with slider field. from 0 to 1023 integer value
     */
    UINT10_NUMBER: 'uint10_number'
};

module.exports = ArgumentType;
