/**
 * Hand gesture recognition rules over MediaPipe Hands landmarks.
 * Landmarks are 21 normalized points, see
 * https://google.github.io/mediapipe/solutions/hands#hand-landmark-model
 */

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

const GestureType = {
    NONE: 'none',
    ROCK: 'rock',
    SCISSORS: 'scissors',
    PAPER: 'paper',
    THUMBS_UP: 'thumbsUp',
    POINTING: 'pointing'
};

const distance = (a, b) => Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));

/**
 * A finger counts as extended when its tip is clearly farther away from the
 * wrist than its middle joint. Works independent of hand rotation.
 * @param {Array.<object>} landmarks - the 21 hand landmarks.
 * @param {number} tip - landmark index of the finger tip.
 * @param {number} pip - landmark index of the finger middle joint.
 * @returns {boolean} true when the finger is extended.
 */
const isFingerExtended = (landmarks, tip, pip) =>
    distance(landmarks[tip], landmarks[WRIST]) > distance(landmarks[pip], landmarks[WRIST]) * 1.15;

/**
 * The thumb is judged against the pinky base: an open thumb sticks out from
 * the palm, a closed one folds across it.
 * @param {Array.<object>} landmarks - the 21 hand landmarks.
 * @returns {boolean} true when the thumb is extended.
 */
const isThumbExtended = landmarks =>
    distance(landmarks[THUMB_TIP], landmarks[PINKY_MCP]) >
    distance(landmarks[INDEX_MCP], landmarks[PINKY_MCP]) * 1.1;

/**
 * @param {Array.<object>} landmarks - the 21 hand landmarks.
 * @returns {{thumb: boolean, index: boolean, middle: boolean, ring: boolean, pinky: boolean}}
 * flags for each extended finger.
 */
const getExtendedFingers = landmarks => ({
    thumb: isThumbExtended(landmarks),
    index: isFingerExtended(landmarks, INDEX_TIP, INDEX_PIP),
    middle: isFingerExtended(landmarks, MIDDLE_TIP, MIDDLE_PIP),
    ring: isFingerExtended(landmarks, RING_TIP, RING_PIP),
    pinky: isFingerExtended(landmarks, PINKY_TIP, PINKY_PIP)
});

/**
 * @param {Array.<object>} landmarks - the 21 hand landmarks.
 * @returns {number} how many fingers (thumb included) are extended.
 */
const countExtendedFingers = landmarks => {
    const fingers = getExtendedFingers(landmarks);
    return ['thumb', 'index', 'middle', 'ring', 'pinky']
        .reduce((count, name) => {
            if (fingers[name]) return count + 1;
            return count;
        }, 0);
};

/**
 * Map extended finger combinations to a simple gesture vocabulary.
 * @param {Array.<object>} landmarks - the 21 hand landmarks.
 * @returns {string} one of GestureType.
 */
const recognizeGesture = landmarks => {
    if (!landmarks || landmarks.length < 21) return GestureType.NONE;
    const fingers = getExtendedFingers(landmarks);
    const extendedCount = ['index', 'middle', 'ring', 'pinky']
        .reduce((count, name) => {
            if (fingers[name]) return count + 1;
            return count;
        }, 0);

    if (extendedCount === 0) {
        return fingers.thumb ? GestureType.THUMBS_UP : GestureType.ROCK;
    }
    if (extendedCount === 1 && fingers.index) {
        return GestureType.POINTING;
    }
    if (extendedCount === 2 && fingers.index && fingers.middle) {
        return GestureType.SCISSORS;
    }
    if (extendedCount === 4) {
        return GestureType.PAPER;
    }
    return GestureType.NONE;
};

module.exports = {
    GestureType,
    getExtendedFingers,
    countExtendedFingers,
    recognizeGesture
};
