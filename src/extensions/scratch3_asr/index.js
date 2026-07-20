const ArgumentType = require('../../extension-support/argument-type');
const BlockType = require('../../extension-support/block-type');
const Cast = require('../../util/cast');
const formatMessage = require('format-message');
const log = require('../../util/log');

/**
 * Icon svg to be displayed in the blocks category menu, encoded as a data URI.
 * @type {string}
 */
// eslint-disable-next-line max-len
const menuIconURI = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#E64D00"/><rect x="16" y="8" width="8" height="14" rx="4" fill="#fff"/><path d="M12 18 a8 8 0 0 0 16 0" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M20 26 v4 M15 32 h10" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>')}`;

/**
 * Icon svg to be displayed at the left edge of each extension block.
 * @type {string}
 */
const blockIconURI = menuIconURI;

/**
 * Base path of the asr service deployed with the platform backend. A hosting
 * page can override it by defining `window.OpenBlockAsrEndpoint` before the
 * GUI loads (e.g. 'https://host/api/v1/asr').
 * @returns {string} - the endpoint base, no trailing slash.
 */
const getAsrEndpoint = () => {
    if (typeof window !== 'undefined' && window.OpenBlockAsrEndpoint) {
        return String(window.OpenBlockAsrEndpoint).replace(/\/$/, '');
    }
    return '/api/v1/asr';
};

/**
 * Longest allowed listening time, seconds.
 * @type {number}
 */
const MAX_LISTEN_SECONDS = 30;

/**
 * Sample rate expected by the recognition service.
 * @type {number}
 */
const TARGET_SAMPLE_RATE = 16000;

/**
 * Scratch 3.0 blocks that record from the microphone and turn speech into
 * text through the platform asr service, with the browser Web Speech API as
 * a fallback when the service is unavailable.
 */
class Scratch3AsrBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * Text of the most recent recognition.
         * @type {string}
         */
        this._lastText = '';

        /**
         * Whether a listen block is currently recording.
         * @type {boolean}
         */
        this._listening = false;

        /**
         * Cached microphone stream, kept open between listens.
         * @type {?MediaStream}
         */
        this._stream = null;

        /**
         * Whether the backend service answered the status probe, null when
         * the probe has not completed yet.
         * @type {?boolean}
         */
        this._serviceAvailable = null;

        this._probeService();
    }

    /**
     * Without this id the extension manager would register the instance as a
     * device and its category would never reach the toolbox.
     * @return {string} - the ID of this extension.
     */
    get EXTENSION_ID () {
        return 'asr';
    }

    /**
     * OpenBlock expects an array of category info objects here.
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        return [{
            id: 'asr',
            name: formatMessage({
                id: 'asr.categoryName',
                default: 'Speech Recognition',
                description: 'Name of the speech recognition extension'
            }),
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'listenAndWait',
                    text: formatMessage({
                        id: 'asr.listenAndWaitBlock',
                        default: 'listen for [SECONDS] seconds and recognize',
                        description: 'record for a duration then recognize speech'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        SECONDS: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 3
                        }
                    }
                },
                {
                    opcode: 'recognizedText',
                    text: formatMessage({
                        id: 'asr.recognizedTextBlock',
                        default: 'recognized text',
                        description: 'the text of the last recognition'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'isListening',
                    text: formatMessage({
                        id: 'asr.isListeningBlock',
                        default: 'listening?',
                        description: 'whether the microphone is recording'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                {
                    opcode: 'textContains',
                    text: formatMessage({
                        id: 'asr.textContainsBlock',
                        default: 'recognized text contains [WORD]?',
                        description: 'whether the recognized text contains a word'
                    }),
                    blockType: BlockType.BOOLEAN,
                    arguments: {
                        WORD: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'asr.defaultWord',
                                default: 'hello',
                                description: 'default word to match'
                            })
                        }
                    }
                }
            ]
        }];
    }

    /**
     * Record from the microphone for a duration, then recognize the speech.
     * @param {object} args - the block arguments.
     * @return {Promise} - resolved when the recognition finished.
     */
    listenAndWait (args) {
        if (this._listening) return Promise.resolve();

        let seconds = Cast.toNumber(args.SECONDS);
        seconds = Math.max(1, Math.min(MAX_LISTEN_SECONDS, seconds));

        if (this._serviceAvailable === false) {
            return this._listenWithWebSpeech(seconds);
        }

        this._listening = true;
        return this._record(seconds)
            .then(wav => this._recognize(wav))
            .then(text => {
                this._lastText = text;
            })
            .catch(err => {
                log.warn(`ASR failed: ${err}`);
                this._lastText = '';
            })
            .then(() => {
                this._listening = false;
            });
    }

    /**
     * @returns {string} - the text of the last recognition.
     */
    recognizedText () {
        return this._lastText;
    }

    /**
     * @returns {boolean} - true when currently recording.
     */
    isListening () {
        return this._listening;
    }

    /**
     * Case-insensitive containment test on the last recognition.
     * @param {object} args - the block arguments.
     * @returns {boolean} - true when the last text contains the word.
     */
    textContains (args) {
        const word = Cast.toString(args.WORD).trim()
            .toLowerCase();
        if (!word) return false;
        return this._lastText.toLowerCase().includes(word);
    }

    /**
     * Probe the backend service once, remembered for fallback decisions.
     * @private
     */
    _probeService () {
        fetch(`${getAsrEndpoint()}/status`)
            .then(res => {
                if (!res.ok) return {available: false};
                return res.json();
            })
            .then(data => {
                this._serviceAvailable = !!data.available;
            })
            .catch(() => {
                this._serviceAvailable = false;
            });
    }

    /**
     * Get (and cache) the microphone stream.
     * @returns {Promise.<MediaStream>} - the microphone stream.
     * @private
     */
    _getStream () {
        if (this._stream && this._stream.active) {
            return Promise.resolve(this._stream);
        }
        if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
            return Promise.reject(new Error('getUserMedia not available'));
        }
        return navigator.mediaDevices.getUserMedia({audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
        }}).then(stream => {
            this._stream = stream;
            return stream;
        });
    }

    /**
     * Record pcm from the microphone and encode a 16k mono WAV blob.
     * @param {number} seconds - how long to record.
     * @returns {Promise.<Blob>} - the recorded audio.
     * @private
     */
    _record (seconds) {
        return this._getStream().then(stream => new Promise((resolve, reject) => {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) {
                reject(new Error('AudioContext not available'));
                return;
            }
            const ctx = new AudioCtx();
            const source = ctx.createMediaStreamSource(stream);
            // ScriptProcessor is deprecated but universally supported and
            // needs no separate worklet file in the bundle.
            const processor = ctx.createScriptProcessor(4096, 1, 1);
            const chunks = [];

            processor.onaudioprocess = e => {
                chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
            };
            source.connect(processor);
            processor.connect(ctx.destination);

            setTimeout(() => {
                processor.disconnect();
                source.disconnect();
                const sampleRate = ctx.sampleRate;
                ctx.close();

                let length = 0;
                chunks.forEach(chunk => {
                    length += chunk.length;
                });
                const pcm = new Float32Array(length);
                let offset = 0;
                chunks.forEach(chunk => {
                    pcm.set(chunk, offset);
                    offset += chunk.length;
                });
                resolve(this._encodeWav(pcm, sampleRate));
            }, seconds * 1000);
        }));
    }

    /**
     * Downsample float pcm to 16k and wrap it in a WAV container.
     * @param {Float32Array} pcm - the recorded samples.
     * @param {number} sampleRate - the source sample rate.
     * @returns {Blob} - a 16bit mono WAV blob.
     * @private
     */
    _encodeWav (pcm, sampleRate) {
        let samples = pcm;
        if (sampleRate !== TARGET_SAMPLE_RATE) {
            const ratio = sampleRate / TARGET_SAMPLE_RATE;
            const outLength = Math.floor(pcm.length / ratio);
            samples = new Float32Array(outLength);
            for (let i = 0; i < outLength; i++) {
                const pos = i * ratio;
                const idx = Math.floor(pos);
                const frac = pos - idx;
                const s0 = pcm[idx];
                const s1 = pcm[Math.min(idx + 1, pcm.length - 1)];
                samples[i] = s0 + ((s1 - s0) * frac);
            }
        }

        const buffer = new ArrayBuffer(44 + (samples.length * 2));
        const view = new DataView(buffer);
        const writeString = (pos, str) => {
            for (let i = 0; i < str.length; i++) {
                view.setUint8(pos + i, str.charCodeAt(i));
            }
        };
        writeString(0, 'RIFF');
        view.setUint32(4, 36 + (samples.length * 2), true);
        writeString(8, 'WAVE');
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, TARGET_SAMPLE_RATE, true);
        view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
        view.setUint16(32, 2, true);
        view.setUint16(34, 16, true);
        writeString(36, 'data');
        view.setUint32(40, samples.length * 2, true);
        for (let i = 0; i < samples.length; i++) {
            const s = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(44 + (i * 2), s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        }
        return new Blob([buffer], {type: 'audio/wav'});
    }

    /**
     * Send a WAV blob to the recognition service.
     * @param {Blob} wav - the audio to recognize.
     * @returns {Promise.<string>} - the recognized text.
     * @private
     */
    _recognize (wav) {
        return fetch(`${getAsrEndpoint()}/recognize`, {
            method: 'POST',
            headers: {'Content-Type': 'audio/wav'},
            body: wav
        }).then(res => {
            if (!res.ok) throw new Error(`asr http ${res.status}`);
            return res.json();
        })
            .then(data => {
                if (data && data.text) return String(data.text);
                return '';
            });
    }

    /**
     * Recognize through the browser speech recognition engine.
     * @param {number} seconds - the longest time to listen.
     * @return {Promise} - resolved when recognition finished.
     * @private
     */
    _listenWithWebSpeech (seconds) {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            log.warn('No asr service and no Web Speech API, recognition skipped');
            return Promise.resolve();
        }
        this._listening = true;
        return new Promise(resolve => {
            const recognition = new Recognition();
            recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN';
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;

            const finish = text => {
                this._listening = false;
                this._lastText = text || '';
                resolve();
            };
            const timer = setTimeout(() => {
                recognition.stop();
            }, seconds * 1000);

            recognition.onresult = e => {
                clearTimeout(timer);
                finish(e.results[0] && e.results[0][0] ? e.results[0][0].transcript : '');
            };
            recognition.onerror = () => {
                clearTimeout(timer);
                finish('');
            };
            recognition.onend = () => {
                clearTimeout(timer);
                if (this._listening) finish(this._lastText);
            };
            recognition.start();
        });
    }
}

module.exports = Scratch3AsrBlocks;
