const Runtime = require('../../engine/runtime');

const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const Video = require('../../io/video');

/**
 * Icon svg to be displayed in the blocks category menu, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const menuIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMCIgaGVpZ2h0PSIyMCIgdmlld0JveD0iMCAwIDIwIDIwIj48Y2lyY2xlIGN4PSI1IiBjeT0iNSIgcj0iMi40IiBmaWxsPSIjRkY2NjgwIi8+PGNpcmNsZSBjeD0iMTUiIGN5PSI1IiByPSIyLjQiIGZpbGw9IiM0Qzk3RkYiLz48Y2lyY2xlIGN4PSI1IiBjeT0iMTUiIHI9IjIuNCIgZmlsbD0iI0ZGNjY4MCIvPjxjaXJjbGUgY3g9IjE1IiBjeT0iMTUiIHI9IjIuNCIgZmlsbD0iIzRDOTdGRiIvPjxjaXJjbGUgY3g9IjEwIiBjeT0iMTAiIHI9IjMiIGZpbGw9IiMwRUJEOEMiLz48cGF0aCBkPSJNNy45IDcuOSA2LjcgNi43IE0xMi4xIDcuOSAxMy4zIDYuNyBNNy45IDEyLjEgNi43IDEzLjMgTTEyLjEgMTIuMSAxMy4zIDEzLjMiIHN0cm9rZT0iIzU3NUU3NSIgc3Ryb2tlLXdpZHRoPSIxLjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjwvc3ZnPgo=';

/**
 * Icon svg to be displayed at the left edge of each extension block, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const blockIconURI = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgdmlld0JveD0iMCAwIDQwIDQwIj48Y2lyY2xlIGN4PSIxMCIgY3k9IjEwIiByPSI0LjUiIGZpbGw9IiNGRkZGRkYiIG9wYWNpdHk9IjAuOSIvPjxjaXJjbGUgY3g9IjMwIiBjeT0iMTAiIHI9IjQuNSIgZmlsbD0iI0ZGRkZGRiIgb3BhY2l0eT0iMC42Ii8+PGNpcmNsZSBjeD0iMTAiIGN5PSIzMCIgcj0iNC41IiBmaWxsPSIjRkZGRkZGIiBvcGFjaXR5PSIwLjYiLz48Y2lyY2xlIGN4PSIzMCIgY3k9IjMwIiByPSI0LjUiIGZpbGw9IiNGRkZGRkYiIG9wYWNpdHk9IjAuOSIvPjxjaXJjbGUgY3g9IjIwIiBjeT0iMjAiIHI9IjUuNSIgZmlsbD0iI0ZGRkZGRiIvPjxwYXRoIGQ9Ik0xNS45IDE1LjkgMTMuMyAxMy4zIE0yNC4xIDE1LjkgMjYuNyAxMy4zIE0xNS45IDI0LjEgMTMuMyAyNi43IE0yNC4xIDI0LjEgMjYuNyAyNi43IiBzdHJva2U9IiNGRkZGRkYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+Cg==';

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
 * Side length of the square the camera frame is downsampled to before it is
 * used as a KNN feature vector.
 * @type {number}
 */
const FEATURE_SIZE = 32;

/**
 * Number of neighbours consulted by the KNN classifier.
 * @type {number}
 */
const KNN_K = 3;

/**
 * Result reported before any classification has happened or when there are
 * no trained samples yet.
 * @type {string}
 */
const RESULT_NONE = '';

/**
 * A tiny KNN classifier over mean/std normalized downsampled pixels. It keeps
 * every sample in memory, which is fine for classroom scale training sets.
 */
class KnnClassifier {
    constructor () {
        this.clearAll();
    }

    clearAll () {
        /** @type {Array.<{label: string, feature: Float32Array}>} */
        this.samples = [];
    }

    clearLabel (label) {
        this.samples = this.samples.filter(sample => sample.label !== label);
    }

    addSample (label, feature) {
        this.samples.push({label, feature});
    }

    countLabel (label) {
        return this.samples.reduce((count, sample) => {
            if (sample.label === label) return count + 1;
            return count;
        }, 0);
    }

    /**
     * Classify a feature vector against the trained samples.
     * @param {Float32Array} feature - the feature vector to classify.
     * @returns {{label: string, confidence: number}} the winning label and the
     * share of votes it received among the K nearest neighbours.
     */
    classify (feature) {
        if (this.samples.length === 0) {
            return {label: RESULT_NONE, confidence: 0};
        }
        const distances = this.samples.map(sample => ({
            label: sample.label,
            distance: KnnClassifier._distance(sample.feature, feature)
        }));
        distances.sort((a, b) => a.distance - b.distance);
        const neighbours = distances.slice(0, Math.min(KNN_K, distances.length));
        const votes = {};
        neighbours.forEach(neighbour => {
            votes[neighbour.label] = (votes[neighbour.label] || 0) + 1;
        });
        let bestLabel = RESULT_NONE;
        let bestVotes = 0;
        Object.keys(votes).forEach(label => {
            if (votes[label] > bestVotes) {
                bestVotes = votes[label];
                bestLabel = label;
            }
        });
        return {label: bestLabel, confidence: bestVotes / neighbours.length};
    }

    static _distance (a, b) {
        let sum = 0;
        for (let i = 0; i < a.length; i++) {
            const diff = a[i] - b[i];
            sum += diff * diff;
        }
        return Math.sqrt(sum);
    }
}

/**
 * Class for the machine learning classifier blocks. Implements a "teachable
 * machine" style workflow: collect camera samples per label, then classify
 * live frames, entirely offline.
 * @param {Runtime} runtime - the runtime instantiating this block package.
 * @constructor
 */
class Scratch3MlClassifierBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * The KNN classifier holding all trained samples.
         * @type {KnnClassifier}
         */
        this.classifier = new KnnClassifier();

        /**
         * Label reported by the most recent classification.
         * @type {string}
         */
        this._currentResult = RESULT_NONE;

        /**
         * Confidence (0-1) of the most recent classification.
         * @type {number}
         */
        this._currentConfidence = 0;

        /**
         * Whether the continuous classification loop is running.
         * @type {boolean}
         */
        this._continuous = false;

        /**
         * Milliseconds between continuous classifications.
         * @type {number}
         */
        this._continuousInterval = 500;

        /**
         * Timestamp of the last continuous classification.
         * @type {number}
         */
        this._lastClassifyTime = 0;

        /**
         * Reusable canvas for feature extraction.
         * @type {?HTMLCanvasElement}
         */
        this._sampleCanvas = null;

        /**
         * A flag to determine if this extension has been installed in a project.
         * It is set to false the first time getInfo is run.
         * @type {boolean}
         */
        this.firstInstall = true;

        if (this.runtime.ioDevices) {
            this.runtime.on(Runtime.PROJECT_LOADED, this.updateVideoDisplay.bind(this));
            this._loop();
        }
    }

    /**
     * @return {string} - the ID of this extension.
     */
    get EXTENSION_ID () {
        return 'mlClassifier';
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
     * Occasionally step a loop that classifies the current frame while
     * continuous mode is enabled.
     * @private
     */
    _loop () {
        setTimeout(this._loop.bind(this), Math.max(this.runtime.currentStepTime, 50));

        if (!this._continuous) return;
        const time = Date.now();
        if (time - this._lastClassifyTime < this._continuousInterval) return;
        if (this._classifyCurrentFrame()) {
            this._lastClassifyTime = time;
        }
    }

    /**
     * Extract the normalized feature vector from the current camera frame.
     * @returns {?Float32Array} the feature vector, or null when no frame is
     * available (camera off or not ready).
     * @private
     */
    _extractFeature () {
        const video = this.runtime.ioDevices && this.runtime.ioDevices.video;
        if (!video) return null;
        const frame = video.getFrame({
            format: Video.FORMAT_CANVAS,
            dimensions: Scratch3MlClassifierBlocks.DIMENSIONS
        });
        if (!frame) return null;

        if (!this._sampleCanvas) {
            if (typeof document === 'undefined') return null;
            this._sampleCanvas = document.createElement('canvas');
            this._sampleCanvas.width = FEATURE_SIZE;
            this._sampleCanvas.height = FEATURE_SIZE;
        }
        const context = this._sampleCanvas.getContext('2d');
        context.drawImage(frame, 0, 0, FEATURE_SIZE, FEATURE_SIZE);
        const pixels = context.getImageData(0, 0, FEATURE_SIZE, FEATURE_SIZE).data;

        const feature = new Float32Array(FEATURE_SIZE * FEATURE_SIZE * 3);
        for (let i = 0; i < FEATURE_SIZE * FEATURE_SIZE; i++) {
            feature[i * 3] = pixels[i * 4];
            feature[(i * 3) + 1] = pixels[(i * 4) + 1];
            feature[(i * 3) + 2] = pixels[(i * 4) + 2];
        }

        // Mean/std normalization makes the match more robust to lighting changes.
        let mean = 0;
        for (let i = 0; i < feature.length; i++) mean += feature[i];
        mean /= feature.length;
        let variance = 0;
        for (let i = 0; i < feature.length; i++) {
            const diff = feature[i] - mean;
            variance += diff * diff;
        }
        const std = Math.sqrt(variance / feature.length) || 1;
        for (let i = 0; i < feature.length; i++) {
            feature[i] = (feature[i] - mean) / std;
        }
        return feature;
    }

    /**
     * Classify the current frame and store the result.
     * @returns {boolean} true when a frame was available and classified.
     * @private
     */
    _classifyCurrentFrame () {
        const feature = this._extractFeature();
        if (!feature) return false;
        const result = this.classifier.classify(feature);
        this._currentResult = result.label;
        this._currentConfidence = result.confidence;
        return true;
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
            id: 'mlClassifier',
            name: formatMessage({
                id: 'mlClassifier.categoryName',
                default: 'ML Classifier',
                description: 'Label for the machine learning classifier extension category'
            }),
            blockIconURI: blockIconURI,
            menuIconURI: menuIconURI,
            blocks: [
                {
                    opcode: 'trainWithLabel',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.trainWithLabel',
                        default: 'add current frame to class [LABEL]',
                        description: 'Add a camera sample to the given class'
                    }),
                    arguments: {
                        LABEL: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'mlClassifier.defaultLabel',
                                default: 'class 1',
                                description: 'Default class label'
                            })
                        }
                    }
                },
                {
                    opcode: 'classify',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.classify',
                        default: 'classify current frame',
                        description: 'Classify the current camera frame once'
                    })
                },
                {
                    opcode: 'startContinuous',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.startContinuous',
                        default: 'start classifying every [INTERVAL] seconds',
                        description: 'Start continuous classification'
                    }),
                    arguments: {
                        INTERVAL: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0.5
                        }
                    }
                },
                {
                    opcode: 'stopContinuous',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.stopContinuous',
                        default: 'stop classifying',
                        description: 'Stop continuous classification'
                    })
                },
                '---',
                {
                    opcode: 'whenResultIs',
                    blockType: BlockType.HAT,
                    text: formatMessage({
                        id: 'mlClassifier.whenResultIs',
                        default: 'when result is [LABEL]',
                        description: 'Triggers when the classification result becomes the given label'
                    }),
                    arguments: {
                        LABEL: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'mlClassifier.defaultLabel',
                                default: 'class 1',
                                description: 'Default class label'
                            })
                        }
                    }
                },
                {
                    opcode: 'getResult',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'mlClassifier.getResult',
                        default: 'result',
                        description: 'The label of the most recent classification'
                    })
                },
                {
                    opcode: 'getConfidence',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'mlClassifier.getConfidence',
                        default: 'confidence',
                        description: 'The confidence of the most recent classification'
                    })
                },
                '---',
                {
                    opcode: 'sampleCount',
                    blockType: BlockType.REPORTER,
                    text: formatMessage({
                        id: 'mlClassifier.sampleCount',
                        default: 'sample count of class [LABEL]',
                        description: 'How many samples are trained for the given class'
                    }),
                    arguments: {
                        LABEL: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'mlClassifier.defaultLabel',
                                default: 'class 1',
                                description: 'Default class label'
                            })
                        }
                    }
                },
                {
                    opcode: 'clearLabel',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.clearLabel',
                        default: 'clear class [LABEL]',
                        description: 'Remove all samples of the given class'
                    }),
                    arguments: {
                        LABEL: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'mlClassifier.defaultLabel',
                                default: 'class 1',
                                description: 'Default class label'
                            })
                        }
                    }
                },
                {
                    opcode: 'clearAll',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.clearAll',
                        default: 'clear all classes',
                        description: 'Remove all trained samples'
                    })
                },
                '---',
                {
                    opcode: 'videoToggle',
                    blockType: BlockType.COMMAND,
                    text: formatMessage({
                        id: 'mlClassifier.videoToggle',
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
                        id: 'mlClassifier.setVideoTransparency',
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
                VIDEO_STATE: {
                    acceptReporters: true,
                    items: this._buildVideoStateMenu()
                }
            }
        }];
    }

    _buildVideoStateMenu () {
        return [
            {
                text: formatMessage({
                    id: 'mlClassifier.off',
                    default: 'off',
                    description: 'Option for the "turn video [STATE]" block'
                }),
                value: VideoState.OFF
            },
            {
                text: formatMessage({
                    id: 'mlClassifier.on',
                    default: 'on',
                    description: 'Option for the "turn video [STATE]" block'
                }),
                value: VideoState.ON
            },
            {
                text: formatMessage({
                    id: 'mlClassifier.onFlipped',
                    default: 'on flipped',
                    description: 'Option for the "turn video [STATE]" block'
                }),
                value: VideoState.ON_FLIPPED
            }
        ];
    }

    trainWithLabel (args) {
        const label = Cast.toString(args.LABEL).trim();
        if (!label) return;
        const feature = this._extractFeature();
        if (!feature) return;
        this.classifier.addSample(label, feature);
    }

    classify () {
        this._classifyCurrentFrame();
    }

    startContinuous (args) {
        const seconds = Math.max(0.1, Cast.toNumber(args.INTERVAL));
        this._continuousInterval = seconds * 1000;
        this._continuous = true;
    }

    stopContinuous () {
        this._continuous = false;
    }

    whenResultIs (args) {
        const label = Cast.toString(args.LABEL).trim();
        return label !== '' && this._currentResult === label;
    }

    getResult () {
        return this._currentResult;
    }

    getConfidence () {
        return Math.round(this._currentConfidence * 100);
    }

    sampleCount (args) {
        const label = Cast.toString(args.LABEL).trim();
        return this.classifier.countLabel(label);
    }

    clearLabel (args) {
        const label = Cast.toString(args.LABEL).trim();
        this.classifier.clearLabel(label);
        if (this._currentResult === label) {
            this._currentResult = RESULT_NONE;
            this._currentConfidence = 0;
        }
    }

    clearAll () {
        this.classifier.clearAll();
        this._currentResult = RESULT_NONE;
        this._currentConfidence = 0;
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

module.exports = Scratch3MlClassifierBlocks;
