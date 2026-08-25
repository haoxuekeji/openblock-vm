const Runtime = require('../../engine/runtime');

const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const log = require('../../util/log');
const Video = require('../../io/video');

const {createSolution} = require('./solution-loader');
const {GestureType, countExtendedFingers, recognizeGesture} = require('./gesture');

/**
 * Icon svg to be displayed in the blocks category menu, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDIwIDIwIj48Y2lyY2xlIGN4PSIxMCIgY3k9IjQiIHI9IjIuNSIgZmlsbD0iI0ZGOEMxQSIvPjxwYXRoIGQ9Ik0xMCA3IEwxMCAxMyBNMTAgOC41IEw1LjUgMTEgTTEwIDguNSBMMTQuNSAxMSBNMTAgMTMgTDYuNSAxNy41IE0xMCAxMyBMMTMuNSAxNy41IiBzdHJva2U9IiNGRjhDMUEiIHN0cm9rZS13aWR0aD0iMS44IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48Y2lyY2xlIGN4PSI1LjUiIGN5PSIxMSIgcj0iMS4zIiBmaWxsPSIjMEVCRDhDIi8+PGNpcmNsZSBjeD0iMTQuNSIgY3k9IjExIiByPSIxLjMiIGZpbGw9IiMwRUJEOEMiLz48Y2lyY2xlIGN4PSI2LjUiIGN5PSIxNy41IiByPSIxLjMiIGZpbGw9IiM0Qzk3RkYiLz48Y2lyY2xlIGN4PSIxMy41IiBjeT0iMTcuNSIgcj0iMS4zIiBmaWxsPSIjNEM5N0ZGIi8+PC9zdmc+Cg==';

/**
 * Icon svg to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const blockIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48Y2lyY2xlIGN4PSIyMCIgY3k9IjgiIHI9IjUiIGZpbGw9IiNGRkZGRkYiLz48cGF0aCBkPSJNMjAgMTQgTDIwIDI2IE0yMCAxNyBMMTEgMjIgTTIwIDE3IEwyOSAyMiBNMjAgMjYgTDEzIDM1IE0yMCAyNiBMMjcgMzUiIHN0cm9rZT0iI0ZGRkZGRiIgc3Ryb2tlLXdpZHRoPSIzLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjExIiBjeT0iMjIiIHI9IjIuNiIgZmlsbD0iI0ZGRkZGRiIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMjIiIHI9IjIuNiIgZmlsbD0iI0ZGRkZGRiIvPjxjaXJjbGUgY3g9IjEzIiBjeT0iMzUiIHI9IjIuNiIgZmlsbD0iI0ZGRkZGRiIvPjxjaXJjbGUgY3g9IjI3IiBjeT0iMzUiIHI9IjIuNiIgZmlsbD0iI0ZGRkZGRiIvPjwvc3ZnPgo=';

/**
 * States the video sensing activity can be set to.
 * @readonly
 * @enum {string}
 */
const VideoState = {
    OFF: 'off',
    ON: 'on',
    ON_FLIPPED: 'on-flipped'
};

/**
 * The two detection models this extension can run.
 * @readonly
 * @enum {string}
 */
const DetectionPart = {
    HANDS: 'hands',
    POSE: 'pose'
};

/**
 * MediaPipe Hands landmark indices exposed in the keypoint menu.
 */
const HAND_KEYPOINTS = {
    wrist: 0,
    thumbTip: 4,
    indexTip: 8,
    middleTip: 12,
    ringTip: 16,
    pinkyTip: 20
};

/**
 * MediaPipe Pose landmark indices exposed in the keypoint menu.
 */
const POSE_KEYPOINTS = {
    nose: 0,
    leftEye: 2,
    rightEye: 5,
    leftEar: 7,
    rightEar: 8,
    leftShoulder: 11,
    rightShoulder: 12,
    leftElbow: 13,
    rightElbow: 14,
    leftWrist: 15,
    rightWrist: 16,
    leftHip: 23,
    rightHip: 24,
    leftKnee: 25,
    rightKnee: 26,
    leftAnkle: 27,
    rightAnkle: 28
};

/**
 * Milliseconds between frames sent to the detectors.
 * @type {number}
 */
const DETECT_INTERVAL = 100;

/**
 * Class for the body sensing blocks: hand gestures and body pose keypoints
 * powered by MediaPipe models loaded on demand.
 * @param {Runtime} runtime - the runtime instantiating this block package.
 * @constructor
 */
class Scratch3BodySensingBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * Per part detection state. `suppressed` records an explicit user
         * stop so the auto-enabling reporters/hats don't immediately restart
         * the detector (see _autoEnable).
         * @type {object}
         */
        this._detectors = {
            [DetectionPart.HANDS]: {active: false, suppressed: false, instance: null, loading: null, busy: false},
            [DetectionPart.POSE]: {active: false, suppressed: false, instance: null, loading: null, busy: false}
        };

        /**
         * Landmarks of the first detected hand, or null.
         * @type {?Array.<object>}
         */
        this._handLandmarks = null;

        /**
         * Landmarks of the detected pose, or null.
         * @type {?Array.<object>}
         */
        this._poseLandmarks = null;

        /**
         * A flag to determine if this extension has been installed in a project.
         * It is set to false the first time getInfo is run.
         * @type {boolean}
         */
        this.firstInstall = true;

        /**
         * Set once the extension is unloaded; stops the detection loop and
         * blocks any late detector setup.
         * @type {boolean}
         */
        this._disposed = false;

        /**
         * Bound PROJECT_LOADED handler, kept so dispose() can remove it.
         * @type {Function}
         */
        this._onProjectLoaded = this.updateVideoDisplay.bind(this);

        if (this.runtime.ioDevices) {
            this.runtime.on(Runtime.PROJECT_LOADED, this._onProjectLoaded);
            this._loop();
        }
    }

    /**
     * Release everything this extension holds: the detection loop, the
     * MediaPipe solution instances and the runtime listener. Called by the
     * extension manager when the extension is unloaded; without it the
     * detectors kept consuming camera frames forever after removal.
     */
    dispose () {
        this._disposed = true;
        this.runtime.removeListener(Runtime.PROJECT_LOADED, this._onProjectLoaded);
        Object.keys(this._detectors).forEach(part => {
            const detector = this._detectors[part];
            detector.active = false;
            detector.loading = null;
            const instance = detector.instance;
            detector.instance = null;
            if (instance) {
                this._closeSolution(instance);
            }
        });
        this._handLandmarks = null;
        this._poseLandmarks = null;
    }

    /**
     * Best-effort close of a MediaPipe solution instance.
     * @param {object} instance - the solution to close.
     * @private
     */
    _closeSolution (instance) {
        try {
            const closing = instance.close();
            if (closing && typeof closing.catch === 'function') {
                closing.catch(() => {});
            }
        } catch (e) {
            // Closing a half-initialized solution may throw; nothing to do.
        }
    }

    /**
     * @return {string} - the ID of this extension.
     */
    get EXTENSION_ID () {
        return 'bodySensing';
    }

    /**
     * Dimensions the video stream is analyzed at.
     * @type {Array.<number>}
     */
    static get DIMENSIONS () {
        return [480, 360];
    }

    get globalVideoTransparency () {
        const stage = this.runtime.getTargetForStage();
        if (stage) {
            return stage.videoTransparency;
        }
        return 50;
    }

    set globalVideoTransparency (transparency) {
        const stage = this.runtime.getTargetForStage();
        if (stage) {
            stage.videoTransparency = transparency;
        }
        return transparency;
    }

    get globalVideoState () {
        const stage = this.runtime.getTargetForStage();
        if (stage) {
            return stage.videoState;
        }
        return VideoState.OFF;
    }

    set globalVideoState (state) {
        const stage = this.runtime.getTargetForStage();
        if (stage) {
            stage.videoState = state;
        }
        return state;
    }

    /**
     * Get the latest values for video transparency and state,
     * and set the video device to use them.
     */
    updateVideoDisplay () {
        this.setVideoTransparency({
            TRANSPARENCY: this.globalVideoTransparency
        });
        this.videoToggle({
            VIDEO_STATE: this.globalVideoState
        });
    }

    /**
     * Lazily create the MediaPipe solution for a detection part and mark it
     * active. Loading errors deactivate the part so the next call can retry.
     * @param {string} part - one of DetectionPart.
     * @returns {Promise} resolved once the detector is ready.
     * @private
     */
    _ensureDetector (part) {
        const detector = this._detectors[part];
        if (!detector) return Promise.reject(new Error(`Unknown detection part: ${part}`));
        detector.active = true;
        if (detector.instance) return Promise.resolve(detector.instance);
        if (!detector.loading) {
            const options = part === DetectionPart.HANDS ?
                {
                    maxNumHands: 1,
                    modelComplexity: 0,
                    minDetectionConfidence: 0.6,
                    minTrackingConfidence: 0.5
                } :
                {
                    modelComplexity: 0,
                    smoothLandmarks: true,
                    minDetectionConfidence: 0.6,
                    minTrackingConfidence: 0.5
                };
            detector.loading = createSolution(part, options)
                .then(instance => {
                    if (this._disposed) {
                        // The extension was unloaded while the model was
                        // still downloading; don't resurrect the detector.
                        detector.loading = null;
                        detector.active = false;
                        this._closeSolution(instance);
                        return instance;
                    }
                    instance.onResults(results => this._onResults(part, results));
                    detector.instance = instance;
                    detector.loading = null;
                    return instance;
                })
                .catch(error => {
                    detector.loading = null;
                    detector.active = false;
                    log.warn(`bodySensing: failed to start ${part} detection: ${error.message}`);
                    throw error;
                });
        }
        return detector.loading;
    }

    /**
     * Store the newest detection results.
     * @param {string} part - one of DetectionPart.
     * @param {object} results - MediaPipe results object.
     * @private
     */
    _onResults (part, results) {
        if (part === DetectionPart.HANDS) {
            const hands = results.multiHandLandmarks;
            this._handLandmarks = hands && hands.length > 0 ? hands[0] : null;
        } else {
            this._poseLandmarks = results.poseLandmarks || null;
        }
    }

    /**
     * Occasionally step a loop that feeds camera frames to every active
     * detector.
     * @private
     */
    _loop () {
        if (this._disposed) return;
        setTimeout(this._loop.bind(this), Math.max(this.runtime.currentStepTime, DETECT_INTERVAL));

        const video = this.runtime.ioDevices && this.runtime.ioDevices.video;
        if (!video) return;

        Object.keys(this._detectors).forEach(part => {
            const detector = this._detectors[part];
            if (!detector.active || !detector.instance || detector.busy) return;
            const frame = video.getFrame({
                format: Video.FORMAT_CANVAS,
                dimensions: Scratch3BodySensingBlocks.DIMENSIONS
            });
            if (!frame) return;
            detector.busy = true;
            detector.instance.send({image: frame})
                .catch(error => {
                    log.warn(`bodySensing: ${part} detection failed: ${error.message}`);
                })
                .then(() => {
                    detector.busy = false;
                });
        });
    }

    /**
     * Convert a normalized landmark into stage coordinates. Frames handed to
     * the detectors are already mirrored by the video provider, so no extra
     * flipping is needed here.
     * @param {object} landmark - {x, y} in the 0-1 range.
     * @param {string} axis - 'x' or 'y'.
     * @returns {number} stage coordinate, rounded.
     * @private
     */
    _toStageCoord (landmark, axis) {
        if (axis === 'y') {
            return Math.round((0.5 - landmark.y) * 360);
        }
        return Math.round((landmark.x - 0.5) * 480);
    }

    /**
     * @returns {Array.<object>} metadata for this extension's categories and their blocks.
     */
    getInfo () {
        if (this.firstInstall) {
            this.globalVideoState = VideoState.ON;
            this.globalVideoTransparency = 50;
            this.updateVideoDisplay();
            this.firstInstall = false;
        }

        // This fork expects getInfo to return an array of categories.
        return [{
            id: 'bodySensing',
            name: formatMessage({
                id: 'bodySensing.categoryName',
                default: 'Body Sensing',
                description: 'Label for the body sensing extension category'
            }),
            blockIconURI: blockIconURI,
            menuIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'enableDetection',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'bodySensing.enableDetection',
                        default: 'start [PART] detection',
                        description: 'Load the model and start detecting'
                    }),
                    arguments: {
                        PART: {
                            type: ArgumentType.STRING,
                            menu: 'PART',
                            defaultValue: DetectionPart.HANDS
                        }
                    }
                },
                {
                    opcode: 'disableDetection',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'bodySensing.disableDetection',
                        default: 'stop [PART] detection',
                        description: 'Stop detecting'
                    }),
                    arguments: {
                        PART: {
                            type: ArgumentType.STRING,
                            menu: 'PART',
                            defaultValue: DetectionPart.HANDS
                        }
                    }
                },
                '---',
                {
                    opcode: 'whenGesture',
                    blockType: BlockType.HAT,
                    text: formatMessage({
                        id: 'bodySensing.whenGesture',
                        default: 'when gesture is [GESTURE]',
                        description: 'Triggers when the given hand gesture is detected'
                    }),
                    arguments: {
                        GESTURE: {
                            type: ArgumentType.STRING,
                            menu: 'GESTURE',
                            defaultValue: GestureType.PAPER
                        }
                    }
                },
                {
                    opcode: 'currentGesture',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'bodySensing.currentGesture',
                        default: 'gesture',
                        description: 'The currently detected hand gesture'
                    })
                },
                {
                    opcode: 'fingerCount',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'bodySensing.fingerCount',
                        default: 'extended finger count',
                        description: 'How many fingers are extended'
                    })
                },
                {
                    opcode: 'isHandDetected',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'bodySensing.isHandDetected',
                        default: 'hand detected?',
                        description: 'Whether a hand is currently detected'
                    })
                },
                {
                    opcode: 'handKeypoint',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'bodySensing.handKeypoint',
                        default: 'hand [KEYPOINT] [AXIS]',
                        description: 'Stage coordinate of a hand keypoint'
                    }),
                    arguments: {
                        KEYPOINT: {
                            type: ArgumentType.STRING,
                            menu: 'HAND_KEYPOINT',
                            defaultValue: 'indexTip'
                        },
                        AXIS: {
                            type: ArgumentType.STRING,
                            menu: 'AXIS',
                            defaultValue: 'x'
                        }
                    }
                },
                '---',
                {
                    opcode: 'isPoseDetected',
                    blockType: BlockType.BOOLEAN,
                    text: formatMessage({
                        id: 'bodySensing.isPoseDetected',
                        default: 'body detected?',
                        description: 'Whether a person is currently detected'
                    })
                },
                {
                    opcode: 'poseKeypoint',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'bodySensing.poseKeypoint',
                        default: 'body [KEYPOINT] [AXIS]',
                        description: 'Stage coordinate of a body keypoint'
                    }),
                    arguments: {
                        KEYPOINT: {
                            type: ArgumentType.STRING,
                            menu: 'POSE_KEYPOINT',
                            defaultValue: 'nose'
                        },
                        AXIS: {
                            type: ArgumentType.STRING,
                            menu: 'AXIS',
                            defaultValue: 'x'
                        }
                    }
                },
                '---',
                {
                    opcode: 'videoToggle',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'bodySensing.videoToggle',
                        default: 'turn video [VIDEO_STATE]',
                        description: 'Controls display of the video preview layer'
                    }),
                    arguments: {
                        VIDEO_STATE: {
                            type: ArgumentType.NUMBER,
                            menu: 'VIDEO_STATE',
                            defaultValue: VideoState.ON
                        }
                    }
                },
                {
                    opcode: 'setVideoTransparency',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'bodySensing.setVideoTransparency',
                        default: 'set video transparency to [TRANSPARENCY]',
                        description: 'Controls transparency of the video preview layer'
                    }),
                    arguments: {
                        TRANSPARENCY: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 50
                        }
                    }
                }
            ],
            menus: {
                PART: {
                    acceptReporters: false,
                    items: [
                        {
                            text: formatMessage({
                                id: 'bodySensing.partHands',
                                default: 'hand',
                                description: 'Hand detection'
                            }),
                            value: DetectionPart.HANDS
                        },
                        {
                            text: formatMessage({
                                id: 'bodySensing.partPose',
                                default: 'body',
                                description: 'Body pose detection'
                            }),
                            value: DetectionPart.POSE
                        }
                    ]
                },
                GESTURE: {
                    acceptReporters: false,
                    items: this._buildGestureMenu(false)
                },
                HAND_KEYPOINT: {
                    acceptReporters: false,
                    items: this._buildHandKeypointMenu()
                },
                POSE_KEYPOINT: {
                    acceptReporters: false,
                    items: this._buildPoseKeypointMenu()
                },
                AXIS: {
                    acceptReporters: false,
                    items: [
                        {text: 'x', value: 'x'},
                        {text: 'y', value: 'y'}
                    ]
                },
                VIDEO_STATE: {
                    acceptReporters: true,
                    items: [
                        {
                            text: formatMessage({
                                id: 'bodySensing.off',
                                default: 'off',
                                description: 'Option for the "turn video [STATE]" block'
                            }),
                            value: VideoState.OFF
                        },
                        {
                            text: formatMessage({
                                id: 'bodySensing.on',
                                default: 'on',
                                description: 'Option for the "turn video [STATE]" block'
                            }),
                            value: VideoState.ON
                        },
                        {
                            text: formatMessage({
                                id: 'bodySensing.onFlipped',
                                default: 'on flipped',
                                description: 'Option for the "turn video [STATE]" block'
                            }),
                            value: VideoState.ON_FLIPPED
                        }
                    ]
                }
            }
        }];
    }

    _gestureName (gesture) {
        switch (gesture) {
        case GestureType.ROCK:
            return formatMessage({
                id: 'bodySensing.gestureRock',
                default: 'rock',
                description: 'Fist gesture'
            });
        case GestureType.SCISSORS:
            return formatMessage({
                id: 'bodySensing.gestureScissors',
                default: 'scissors',
                description: 'Two finger gesture'
            });
        case GestureType.PAPER:
            return formatMessage({
                id: 'bodySensing.gesturePaper',
                default: 'paper',
                description: 'Open hand gesture'
            });
        case GestureType.THUMBS_UP:
            return formatMessage({
                id: 'bodySensing.gestureThumbsUp',
                default: 'thumbs up',
                description: 'Thumbs up gesture'
            });
        case GestureType.POINTING:
            return formatMessage({
                id: 'bodySensing.gesturePointing',
                default: 'pointing',
                description: 'Index finger pointing gesture'
            });
        default:
            return formatMessage({
                id: 'bodySensing.gestureNone',
                default: 'none',
                description: 'No gesture detected'
            });
        }
    }

    _buildGestureMenu (includeNone) {
        const gestures = [
            GestureType.ROCK,
            GestureType.SCISSORS,
            GestureType.PAPER,
            GestureType.THUMBS_UP,
            GestureType.POINTING
        ];
        if (includeNone) gestures.push(GestureType.NONE);
        return gestures.map(gesture => ({
            text: this._gestureName(gesture),
            value: gesture
        }));
    }

    _buildHandKeypointMenu () {
        const names = {
            wrist: formatMessage({
                id: 'bodySensing.handWrist',
                default: 'wrist',
                description: 'Hand keypoint'
            }),
            thumbTip: formatMessage({
                id: 'bodySensing.handThumbTip',
                default: 'thumb tip',
                description: 'Hand keypoint'
            }),
            indexTip: formatMessage({
                id: 'bodySensing.handIndexTip',
                default: 'index finger tip',
                description: 'Hand keypoint'
            }),
            middleTip: formatMessage({
                id: 'bodySensing.handMiddleTip',
                default: 'middle finger tip',
                description: 'Hand keypoint'
            }),
            ringTip: formatMessage({
                id: 'bodySensing.handRingTip',
                default: 'ring finger tip',
                description: 'Hand keypoint'
            }),
            pinkyTip: formatMessage({
                id: 'bodySensing.handPinkyTip',
                default: 'pinky tip',
                description: 'Hand keypoint'
            })
        };
        return Object.keys(HAND_KEYPOINTS).map(key => ({text: names[key], value: key}));
    }

    _buildPoseKeypointMenu () {
        const names = {
            nose: formatMessage({id: 'bodySensing.poseNose', default: 'nose', description: 'Pose keypoint'}),
            leftEye: formatMessage({id: 'bodySensing.poseLeftEye', default: 'left eye', description: 'Pose keypoint'}),
            rightEye: formatMessage({
                id: 'bodySensing.poseRightEye',
                default: 'right eye',
                description: 'Pose keypoint'
            }),
            leftEar: formatMessage({id: 'bodySensing.poseLeftEar', default: 'left ear', description: 'Pose keypoint'}),
            rightEar: formatMessage({
                id: 'bodySensing.poseRightEar',
                default: 'right ear',
                description: 'Pose keypoint'
            }),
            leftShoulder: formatMessage({
                id: 'bodySensing.poseLeftShoulder',
                default: 'left shoulder',
                description: 'Pose keypoint'
            }),
            rightShoulder: formatMessage({
                id: 'bodySensing.poseRightShoulder',
                default: 'right shoulder',
                description: 'Pose keypoint'
            }),
            leftElbow: formatMessage({
                id: 'bodySensing.poseLeftElbow',
                default: 'left elbow',
                description: 'Pose keypoint'
            }),
            rightElbow: formatMessage({
                id: 'bodySensing.poseRightElbow',
                default: 'right elbow',
                description: 'Pose keypoint'
            }),
            leftWrist: formatMessage({
                id: 'bodySensing.poseLeftWrist',
                default: 'left wrist',
                description: 'Pose keypoint'
            }),
            rightWrist: formatMessage({
                id: 'bodySensing.poseRightWrist',
                default: 'right wrist',
                description: 'Pose keypoint'
            }),
            leftHip: formatMessage({id: 'bodySensing.poseLeftHip', default: 'left hip', description: 'Pose keypoint'}),
            rightHip: formatMessage({
                id: 'bodySensing.poseRightHip',
                default: 'right hip',
                description: 'Pose keypoint'
            }),
            leftKnee: formatMessage({
                id: 'bodySensing.poseLeftKnee',
                default: 'left knee',
                description: 'Pose keypoint'
            }),
            rightKnee: formatMessage({
                id: 'bodySensing.poseRightKnee',
                default: 'right knee',
                description: 'Pose keypoint'
            }),
            leftAnkle: formatMessage({
                id: 'bodySensing.poseLeftAnkle',
                default: 'left ankle',
                description: 'Pose keypoint'
            }),
            rightAnkle: formatMessage({
                id: 'bodySensing.poseRightAnkle',
                default: 'right ankle',
                description: 'Pose keypoint'
            })
        };
        return Object.keys(POSE_KEYPOINTS).map(key => ({text: names[key], value: key}));
    }

    enableDetection (args) {
        const part = Cast.toString(args.PART);
        const detector = this._detectors[part];
        if (detector) {
            detector.suppressed = false;
        }
        return this._ensureDetector(part).catch(() => {
            // The warning is already logged; don't stop the script.
        });
    }

    disableDetection (args) {
        const part = Cast.toString(args.PART);
        const detector = this._detectors[part];
        if (!detector) return;
        detector.active = false;
        // Remember the explicit stop. Reporters and hats auto-start their
        // detector (_autoEnable), and edge-activated hats are polled every
        // step even while the project is stopped, so without this flag any
        // "when gesture" block in the workspace re-enabled detection right
        // after the user asked it to stop.
        detector.suppressed = true;
        if (part === DetectionPart.HANDS) {
            this._handLandmarks = null;
        } else {
            this._poseLandmarks = null;
        }
    }

    _autoEnable (part) {
        const detector = this._detectors[part];
        if (detector && !detector.active && !detector.suppressed) {
            this._ensureDetector(part).catch(() => {
                // The warning is already logged; reporters simply keep
                // returning their empty defaults.
            });
        }
    }

    whenGesture (args) {
        this._autoEnable(DetectionPart.HANDS);
        return this._handLandmarks !== null &&
            recognizeGesture(this._handLandmarks) === Cast.toString(args.GESTURE);
    }

    currentGesture () {
        this._autoEnable(DetectionPart.HANDS);
        if (!this._handLandmarks) return this._gestureName(GestureType.NONE);
        return this._gestureName(recognizeGesture(this._handLandmarks));
    }

    fingerCount () {
        this._autoEnable(DetectionPart.HANDS);
        if (!this._handLandmarks) return 0;
        return countExtendedFingers(this._handLandmarks);
    }

    isHandDetected () {
        this._autoEnable(DetectionPart.HANDS);
        return this._handLandmarks !== null;
    }

    handKeypoint (args) {
        this._autoEnable(DetectionPart.HANDS);
        if (!this._handLandmarks) return 0;
        const index = HAND_KEYPOINTS[Cast.toString(args.KEYPOINT)];
        const landmark = typeof index === 'number' ? this._handLandmarks[index] : null;
        if (!landmark) return 0;
        return this._toStageCoord(landmark, Cast.toString(args.AXIS));
    }

    isPoseDetected () {
        this._autoEnable(DetectionPart.POSE);
        return this._poseLandmarks !== null;
    }

    poseKeypoint (args) {
        this._autoEnable(DetectionPart.POSE);
        if (!this._poseLandmarks) return 0;
        const index = POSE_KEYPOINTS[Cast.toString(args.KEYPOINT)];
        const landmark = typeof index === 'number' ? this._poseLandmarks[index] : null;
        if (!landmark) return 0;
        return this._toStageCoord(landmark, Cast.toString(args.AXIS));
    }

    videoToggle (args) {
        const state = args.VIDEO_STATE;
        this.globalVideoState = state;
        if (state === VideoState.OFF) {
            this.runtime.ioDevices.video.disableVideo();
        } else {
            this.runtime.ioDevices.video.enableVideo();
            this.runtime.ioDevices.video.mirror = state === VideoState.ON;
        }
    }

    setVideoTransparency (args) {
        const transparency = Cast.toNumber(args.TRANSPARENCY);
        this.globalVideoTransparency = transparency;
        this.runtime.ioDevices.video.setPreviewGhost(transparency);
    }
}

module.exports = Scratch3BodySensingBlocks;
