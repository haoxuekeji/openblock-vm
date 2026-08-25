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
const menuIconURI = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#0F9D58"/><path d="M10 16 h5 l6 -5 v18 l-6 -5 h-5 z" fill="#fff"/><path d="M25 15 a7 7 0 0 1 0 10" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/><path d="M28.5 12 a12 12 0 0 1 0 16" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity="0.7"/></svg>')}`;

/**
 * Icon svg to be displayed at the left edge of each extension block.
 * @type {string}
 */
const blockIconURI = menuIconURI;

/**
 * Base path of the tts service deployed with the platform backend. A hosting
 * page can override it by defining `window.OpenBlockTtsEndpoint` before the
 * GUI loads (e.g. 'https://host/api/v1/tts').
 * @returns {string} - the endpoint base, no trailing slash.
 */
const getTtsEndpoint = () => {
    if (typeof window !== 'undefined' && window.OpenBlockTtsEndpoint) {
        return String(window.OpenBlockTtsEndpoint).replace(/\/$/, '');
    }
    return '/api/v1/tts';
};

/**
 * Longest text accepted by a single speak block, characters.
 * @type {number}
 */
const MAX_TEXT_LENGTH = 500;

/**
 * Voices offered in the voice menu. Ids are edge-tts voice names; lang is
 * used to pick a matching system voice for the Web Speech fallback.
 * @type {Array.<object>}
 */
const VOICE_INFO = [
    {id: 'zh-CN-XiaoxiaoNeural', lang: 'zh-CN', msg: 'speak.voiceXiaoxiao', def: 'Xiaoxiao (female)'},
    {id: 'zh-CN-YunxiNeural', lang: 'zh-CN', msg: 'speak.voiceYunxi', def: 'Yunxi (male)'},
    {id: 'zh-CN-XiaoyiNeural', lang: 'zh-CN', msg: 'speak.voiceXiaoyi', def: 'Xiaoyi (lively)'},
    {id: 'en-US-AriaNeural', lang: 'en-US', msg: 'speak.voiceAria', def: 'Aria (English)'},
    {id: 'en-US-AnaNeural', lang: 'en-US', msg: 'speak.voiceAna', def: 'Ana (English kid)'},
    {id: 'ja-JP-NanamiNeural', lang: 'ja-JP', msg: 'speak.voiceNanami', def: 'Nanami (Japanese)'},
    {id: 'ru-RU-SvetlanaNeural', lang: 'ru-RU', msg: 'speak.voiceSvetlana', def: 'Svetlana (Russian)'}
];

/**
 * Scratch 3.0 blocks that read text aloud through the platform Edge TTS
 * service, falling back to the browser Web Speech API when the service is
 * unreachable. A drop-in replacement for the official text2speech extension
 * whose synthesis service is blocked on some networks.
 */
class Scratch3SpeakBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * The currently selected voice id.
         * @type {string}
         */
        this._voice = VOICE_INFO[0].id;

        /**
         * Speech rate percentage offset, -50..100.
         * @type {number}
         */
        this._rate = 0;

        /**
         * Audio elements currently playing, so they can be stopped.
         * @type {Set.<HTMLAudioElement>}
         */
        this._playing = new Set();

        if (this.runtime) {
            this.runtime.on('PROJECT_STOP_ALL', this.stopSpeaking.bind(this));
        }
    }

    /**
     * Without this id the extension manager would register the instance as a
     * device and its category would never reach the toolbox.
     * @return {string} - the ID of this extension.
     */
    get EXTENSION_ID () {
        return 'speak';
    }

    /**
     * OpenBlock expects an array of category info objects here.
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        return [{
            id: 'speak',
            name: formatMessage({
                id: 'speak.categoryName',
                default: 'Text Speaker',
                description: 'Name of the text speaker extension'
            }),
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'speakAndWait',
                    text: formatMessage({
                        id: 'speak.speakAndWaitBlock',
                        default: 'speak [TEXT] until done',
                        description: 'speak text and wait for it to finish'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'speak.defaultText',
                                default: 'hello',
                                description: 'default text to speak'
                            })
                        }
                    }
                },
                {
                    opcode: 'speakNoWait',
                    text: formatMessage({
                        id: 'speak.speakBlock',
                        default: 'start speaking [TEXT]',
                        description: 'speak text without waiting'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TEXT: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'speak.defaultText',
                                default: 'hello',
                                description: 'default text to speak'
                            })
                        }
                    }
                },
                {
                    opcode: 'stopSpeaking',
                    text: formatMessage({
                        id: 'speak.stopBlock',
                        default: 'stop speaking',
                        description: 'stop all speech'
                    }),
                    blockType: BlockType.COMMAND
                },
                '---',
                {
                    opcode: 'setVoice',
                    text: formatMessage({
                        id: 'speak.setVoiceBlock',
                        default: 'set voice to [VOICE]',
                        description: 'set the speaking voice'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        VOICE: {
                            type: ArgumentType.STRING,
                            menu: 'voices',
                            defaultValue: VOICE_INFO[0].id
                        }
                    }
                },
                {
                    opcode: 'setRate',
                    text: formatMessage({
                        id: 'speak.setRateBlock',
                        default: 'set speaking speed to [RATE] %',
                        description: 'set the speaking speed offset percentage'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        RATE: {
                            type: ArgumentType.NUMBER,
                            defaultValue: 0
                        }
                    }
                }
            ],
            menus: {
                voices: {
                    acceptReporters: true,
                    items: VOICE_INFO.map(voice => ({
                        text: formatMessage({
                            id: voice.msg,
                            default: voice.def,
                            description: 'voice name in the voice menu'
                        }),
                        value: voice.id
                    }))
                }
            }
        }];
    }

    /**
     * Speak some text and resolve when playback finished.
     * @param {object} args - the block arguments.
     * @return {Promise} - resolved when the speech finished.
     */
    speakAndWait (args) {
        return this._speak(Cast.toString(args.TEXT));
    }

    /**
     * Start speaking without blocking the thread.
     * @param {object} args - the block arguments.
     */
    speakNoWait (args) {
        this._speak(Cast.toString(args.TEXT));
    }

    /**
     * Stop every ongoing playback, both audio elements and Web Speech.
     */
    stopSpeaking () {
        this._playing.forEach(audio => {
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            if (audio.src && audio.src.startsWith('blob:')) {
                URL.revokeObjectURL(audio.src);
            }
        });
        this._playing.clear();
        if (typeof speechSynthesis !== 'undefined') {
            speechSynthesis.cancel();
        }
    }

    /**
     * Select the voice used by following speak blocks.
     * @param {object} args - the block arguments.
     */
    setVoice (args) {
        const voice = Cast.toString(args.VOICE);
        if (VOICE_INFO.some(info => info.id === voice)) {
            this._voice = voice;
        }
    }

    /**
     * Set the speaking speed offset.
     * @param {object} args - the block arguments.
     */
    setRate (args) {
        const rate = Cast.toNumber(args.RATE);
        this._rate = Math.max(-50, Math.min(100, Math.round(rate)));
    }

    /**
     * Speak text through the tts service, falling back to Web Speech.
     * @param {string} text - the text to speak.
     * @return {Promise} - resolved when playback finished or failed.
     * @private
     */
    _speak (text) {
        text = (text || '').trim().slice(0, MAX_TEXT_LENGTH);
        if (!text) return Promise.resolve();

        const rate = `${this._rate >= 0 ? '+' : ''}${this._rate}%`;
        const url = `${getTtsEndpoint()}/speak?text=${encodeURIComponent(text)}` +
            `&voice=${encodeURIComponent(this._voice)}&rate=${encodeURIComponent(rate)}`;

        return fetch(url)
            .then(res => {
                if (!res.ok) throw new Error(`tts http ${res.status}`);
                return res.blob();
            })
            .then(blob => {
                if (!blob || blob.size === 0) throw new Error('tts empty audio');
                return this._playBlob(blob);
            })
            .catch(err => {
                log.warn(`TTS service failed, falling back to Web Speech: ${err}`);
                return this._speakWithWebSpeech(text);
            });
    }

    /**
     * Play an audio blob and resolve when it ends.
     * @param {Blob} blob - the mp3 audio.
     * @return {Promise} - resolved when playback finished.
     * @private
     */
    _playBlob (blob) {
        return new Promise(resolve => {
            const audio = new Audio(URL.createObjectURL(blob));
            this._playing.add(audio);
            const done = () => {
                this._playing.delete(audio);
                if (audio.src && audio.src.startsWith('blob:')) {
                    URL.revokeObjectURL(audio.src);
                }
                resolve();
            };
            audio.onended = done;
            audio.onerror = done;
            audio.play().catch(done);
        });
    }

    /**
     * Speak through the browser speech synthesis engine.
     * @param {string} text - the text to speak.
     * @return {Promise} - resolved when the speech finished.
     * @private
     */
    _speakWithWebSpeech (text) {
        if (typeof speechSynthesis === 'undefined') {
            log.warn('Web Speech API not available, speech skipped');
            return Promise.resolve();
        }
        return new Promise(resolve => {
            const utterance = new SpeechSynthesisUtterance(text);
            const info = VOICE_INFO.find(voice => voice.id === this._voice);
            const lang = info ? info.lang : 'zh-CN';
            utterance.lang = lang;
            const systemVoice = speechSynthesis.getVoices()
                .find(voice => voice.lang && voice.lang.replace('_', '-').startsWith(lang));
            if (systemVoice) utterance.voice = systemVoice;
            utterance.rate = Math.max(0.5, Math.min(2, 1 + (this._rate / 100)));
            utterance.onend = resolve;
            utterance.onerror = resolve;
            speechSynthesis.speak(utterance);
        });
    }
}

module.exports = Scratch3SpeakBlocks;
