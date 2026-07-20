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
const menuIconURI = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#7B48C8"/><rect x="9" y="11" width="22" height="16" rx="8" fill="#fff"/><circle cx="16" cy="19" r="2.4" fill="#7B48C8"/><circle cx="24" cy="19" r="2.4" fill="#7B48C8"/><path d="M17 30 l3 4 3 -4 z" fill="#fff"/><path d="M20 7 v4 M20 7 a2 2 0 1 1 0.01 0" stroke="#fff" stroke-width="2" fill="none"/></svg>')}`;

/**
 * Icon svg to be displayed at the left edge of each extension block.
 * @type {string}
 */
const blockIconURI = menuIconURI;

/**
 * Base path of the ai chat service deployed with the platform backend. A
 * hosting page can override it by defining `window.OpenBlockAiChatEndpoint`
 * before the GUI loads.
 * @returns {string} - the endpoint base, no trailing slash.
 */
const getAiChatEndpoint = () => {
    if (typeof window !== 'undefined' && window.OpenBlockAiChatEndpoint) {
        return String(window.OpenBlockAiChatEndpoint).replace(/\/$/, '');
    }
    return '/api/v1/ai-chat';
};

/**
 * How many past exchanges to send for multi turn conversations.
 * @type {number}
 */
const MAX_HISTORY_MESSAGES = 12;

/**
 * Longest accepted question / persona, characters.
 * @type {number}
 */
const MAX_QUESTION_LENGTH = 500;
const MAX_PERSONA_LENGTH = 300;

/**
 * How long to wait for the answer before giving up, milliseconds.
 * @type {number}
 */
const ASK_TIMEOUT = 30 * 1000;

/**
 * Scratch 3.0 blocks that chat with the platform LLM service, so projects
 * can hold a conversation, combine with the speak / asr extensions and build
 * voice assistants.
 */
class Scratch3AiChatBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * The answer of the last ask.
         * @type {string}
         */
        this._answer = '';

        /**
         * Persona instruction sent with every ask.
         * @type {string}
         */
        this._persona = '';

        /**
         * Recent conversation, alternating user / assistant messages.
         * @type {Array.<object>}
         */
        this._history = [];

        /**
         * Whether an ask request is currently in flight.
         * @type {boolean}
         */
        this._thinking = false;
    }

    /**
     * Without this id the extension manager would register the instance as a
     * device and its category would never reach the toolbox.
     * @return {string} - the ID of this extension.
     */
    get EXTENSION_ID () {
        return 'aiChat';
    }

    /**
     * OpenBlock expects an array of category info objects here.
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        return [{
            id: 'aiChat',
            name: formatMessage({
                id: 'aiChat.categoryName',
                default: 'AI Chat',
                description: 'Name of the ai chat extension'
            }),
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'askAndWait',
                    text: formatMessage({
                        id: 'aiChat.askAndWaitBlock',
                        default: 'ask AI [QUESTION] and wait',
                        description: 'ask the ai a question and wait for the answer'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        QUESTION: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'aiChat.defaultQuestion',
                                default: 'Tell me a fun fact',
                                description: 'default question to ask'
                            })
                        }
                    }
                },
                {
                    opcode: 'answer',
                    text: formatMessage({
                        id: 'aiChat.answerBlock',
                        default: 'AI answer',
                        description: 'the answer of the last ask'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'isThinking',
                    text: formatMessage({
                        id: 'aiChat.isThinkingBlock',
                        default: 'AI thinking?',
                        description: 'whether the ai is generating an answer'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                '---',
                {
                    opcode: 'setPersona',
                    text: formatMessage({
                        id: 'aiChat.setPersonaBlock',
                        default: 'set AI role to [PERSONA]',
                        description: 'set the persona of the ai'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        PERSONA: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'aiChat.defaultPersona',
                                default: 'a friendly robot cat',
                                description: 'default persona of the ai'
                            })
                        }
                    }
                },
                {
                    opcode: 'clearMemory',
                    text: formatMessage({
                        id: 'aiChat.clearMemoryBlock',
                        default: 'clear chat memory',
                        description: 'forget the conversation so far'
                    }),
                    blockType: BlockType.COMMAND
                }
            ]
        }];
    }

    /**
     * Ask the service and remember the answer.
     * @param {object} args - the block arguments.
     * @return {Promise} - resolved when the answer arrived or failed.
     */
    askAndWait (args) {
        const question = Cast.toString(args.QUESTION).trim()
            .slice(0, MAX_QUESTION_LENGTH);
        if (!question) return Promise.resolve();

        const controller = typeof AbortController === 'undefined' ? null : new AbortController();
        const timer = controller && setTimeout(() => controller.abort(), ASK_TIMEOUT);

        const fetchOptions = {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                question: question,
                persona: this._persona,
                history: this._history
            })
        };
        if (controller) fetchOptions.signal = controller.signal;

        this._thinking = true;
        return fetch(`${getAiChatEndpoint()}/ask`, fetchOptions)
            .then(res => {
                if (!res.ok) throw new Error(`ai chat http ${res.status}`);
                return res.json();
            })
            .then(data => {
                this._answer = (data && data.answer) ? String(data.answer) : '';
                this._history.push({role: 'user', content: question});
                this._history.push({role: 'assistant', content: this._answer.slice(0, MAX_QUESTION_LENGTH)});
                while (this._history.length > MAX_HISTORY_MESSAGES) {
                    this._history.shift();
                }
            })
            .catch(err => {
                log.warn(`AI chat failed: ${err}`);
                this._answer = '';
            })
            .then(() => {
                if (timer) clearTimeout(timer);
                this._thinking = false;
            });
    }

    /**
     * @returns {string} - the answer of the last ask.
     */
    answer () {
        return this._answer;
    }

    /**
     * @returns {boolean} - true while a request is in flight.
     */
    isThinking () {
        return this._thinking;
    }

    /**
     * Set the persona and start a fresh conversation.
     * @param {object} args - the block arguments.
     */
    setPersona (args) {
        this._persona = Cast.toString(args.PERSONA).trim()
            .slice(0, MAX_PERSONA_LENGTH);
        this._history = [];
    }

    /**
     * Forget the conversation so far, keeping the persona.
     */
    clearMemory () {
        this._history = [];
        this._answer = '';
    }
}

module.exports = Scratch3AiChatBlocks;
