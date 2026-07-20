const mqtt = require('mqtt');

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
const menuIconURI = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#660066"/><path d="M8 32a24 24 0 0 1 24-24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M8 24a16 16 0 0 1 16-16" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.75"/><path d="M8 16a8 8 0 0 1 8-8" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" opacity="0.5"/><circle cx="10" cy="30" r="3" fill="#fff"/></svg>')}`;

/**
 * Icon svg to be displayed at the left edge of each extension block.
 * @type {string}
 */
const blockIconURI = menuIconURI;

/**
 * Default MQTT broker, a public sandbox reachable from the browser over
 * secure websockets.
 * @type {string}
 */
const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';

/**
 * Default topic used in the block examples.
 * @type {string}
 */
const DEFAULT_TOPIC = 'openblock/demo';

/**
 * How long to wait for the broker connection before letting the block
 * continue anyway, in milliseconds.
 * @type {number}
 */
const CONNECT_TIMEOUT = 10 * 1000;

/**
 * Maximum stored payload size, characters. Longer messages are truncated so
 * a rogue publisher can not exhaust the browser memory.
 * @type {number}
 */
const MAX_PAYLOAD_LENGTH = 10 * 1024;

/**
 * Scratch 3.0 blocks to interact with an MQTT broker over websockets, so
 * projects can talk to each other and to IoT hardware through the network.
 */
class Scratch3MqttBlocks {
    constructor (runtime) {
        /**
         * The runtime instantiating this block package.
         * @type {Runtime}
         */
        this.runtime = runtime;

        /**
         * The mqtt.js client, null when never connected.
         * @type {?MqttClient}
         */
        this._client = null;

        /**
         * The url of the broker the client is/was connected to.
         * @type {string}
         */
        this._brokerUrl = '';

        /**
         * Topic of the last received message.
         * @type {string}
         */
        this._lastTopic = '';

        /**
         * Payload of the last received message.
         * @type {string}
         */
        this._lastMessage = '';

        this._onMessage = this._onMessage.bind(this);
    }

    /**
     * Without this id the extension manager would register the instance as a
     * device and its category would never reach the toolbox.
     * @return {string} - the ID of this extension.
     */
    get EXTENSION_ID () {
        return 'mqtt';
    }

    /**
     * OpenBlock expects an array of category info objects here (unlike
     * upstream scratch-vm which takes a single object).
     * @returns {Array.<object>} metadata for this extension and its blocks.
     */
    getInfo () {
        return [{
            id: 'mqtt',
            name: 'MQTT',
            menuIconURI: menuIconURI,
            blockIconURI: blockIconURI,
            blocks: [
                {
                    opcode: 'connect',
                    text: formatMessage({
                        id: 'mqtt.connectBlock',
                        default: 'connect to MQTT broker [BROKER]',
                        description: 'connect to an mqtt broker'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        BROKER: {
                            type: ArgumentType.STRING,
                            defaultValue: DEFAULT_BROKER
                        }
                    }
                },
                {
                    opcode: 'disconnect',
                    text: formatMessage({
                        id: 'mqtt.disconnectBlock',
                        default: 'disconnect from MQTT broker',
                        description: 'disconnect from the mqtt broker'
                    }),
                    blockType: BlockType.COMMAND
                },
                {
                    opcode: 'isConnected',
                    text: formatMessage({
                        id: 'mqtt.isConnectedBlock',
                        default: 'MQTT connected?',
                        description: 'whether the mqtt broker is connected'
                    }),
                    blockType: BlockType.BOOLEAN
                },
                '---',
                {
                    opcode: 'subscribe',
                    text: formatMessage({
                        id: 'mqtt.subscribeBlock',
                        default: 'subscribe to topic [TOPIC]',
                        description: 'subscribe to an mqtt topic'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TOPIC: {
                            type: ArgumentType.STRING,
                            defaultValue: DEFAULT_TOPIC
                        }
                    }
                },
                {
                    opcode: 'unsubscribe',
                    text: formatMessage({
                        id: 'mqtt.unsubscribeBlock',
                        default: 'unsubscribe from topic [TOPIC]',
                        description: 'unsubscribe from an mqtt topic'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TOPIC: {
                            type: ArgumentType.STRING,
                            defaultValue: DEFAULT_TOPIC
                        }
                    }
                },
                {
                    opcode: 'publish',
                    text: formatMessage({
                        id: 'mqtt.publishBlock',
                        default: 'publish [MESSAGE] to topic [TOPIC]',
                        description: 'publish a message to an mqtt topic'
                    }),
                    blockType: BlockType.COMMAND,
                    arguments: {
                        TOPIC: {
                            type: ArgumentType.STRING,
                            defaultValue: DEFAULT_TOPIC
                        },
                        MESSAGE: {
                            type: ArgumentType.STRING,
                            defaultValue: formatMessage({
                                id: 'mqtt.defaultMessage',
                                default: 'hello',
                                description: 'default message to publish'
                            })
                        }
                    }
                },
                '---',
                {
                    opcode: 'whenMessageReceived',
                    text: formatMessage({
                        id: 'mqtt.whenMessageReceivedBlock',
                        default: 'when MQTT message received',
                        description: 'event fired when an mqtt message arrives'
                    }),
                    blockType: BlockType.EVENT,
                    isEdgeActivated: false,
                    shouldRestartExistingThreads: true
                },
                {
                    opcode: 'getLastTopic',
                    text: formatMessage({
                        id: 'mqtt.lastTopicBlock',
                        default: 'MQTT topic',
                        description: 'topic of the last received mqtt message'
                    }),
                    blockType: BlockType.REPORTER
                },
                {
                    opcode: 'getLastMessage',
                    text: formatMessage({
                        id: 'mqtt.lastMessageBlock',
                        default: 'MQTT message',
                        description: 'payload of the last received mqtt message'
                    }),
                    blockType: BlockType.REPORTER
                }
            ]
        }];
    }

    /**
     * Handle an incoming message: remember it and start the event hats.
     * @param {string} topic - the topic the message was published on.
     * @param {Uint8Array} payload - the raw message payload.
     * @private
     */
    _onMessage (topic, payload) {
        this._lastTopic = topic;
        this._lastMessage = payload.toString()
            .slice(0, MAX_PAYLOAD_LENGTH);
        this.runtime.startHats('mqtt_whenMessageReceived');
    }

    /**
     * Connect to a broker. Resolves when connected, on error, or after a
     * timeout so the thread can not hang forever on an unreachable broker.
     * @param {object} args - the block arguments.
     * @property {string} BROKER - the broker websocket url.
     * @return {Promise} - resolved when the connection attempt settled.
     */
    connect (args) {
        const brokerUrl = Cast.toString(args.BROKER).trim();

        if (this._client && this._client.connected && this._brokerUrl === brokerUrl) {
            return Promise.resolve();
        }
        this._teardownClient();

        this._brokerUrl = brokerUrl;
        return new Promise(resolve => {
            let settled = false;
            const settle = () => {
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            let client;
            try {
                const clientId = `openblock_${Math.random()
                    .toString(16)
                    .slice(2, 10)}`;
                client = mqtt.connect(brokerUrl, {
                    clientId: clientId,
                    connectTimeout: CONNECT_TIMEOUT,
                    reconnectPeriod: 2000,
                    resubscribe: true
                });
            } catch (e) {
                log.warn(`MQTT connect failed: ${e}`);
                settle();
                return;
            }

            this._client = client;
            client.on('message', this._onMessage);
            client.on('connect', settle);
            client.on('error', err => {
                log.warn(`MQTT error: ${err}`);
                settle();
            });
            setTimeout(settle, CONNECT_TIMEOUT);
        });
    }

    /**
     * Disconnect from the broker.
     */
    disconnect () {
        this._teardownClient();
    }

    /**
     * Close and drop the current client, if any.
     * @private
     */
    _teardownClient () {
        if (this._client) {
            this._client.removeListener('message', this._onMessage);
            this._client.end(true);
            this._client = null;
        }
    }

    /**
     * @return {boolean} - true when connected to the broker.
     */
    isConnected () {
        return Boolean(this._client && this._client.connected);
    }

    /**
     * Subscribe to a topic (supports the usual + and # wildcards).
     * @param {object} args - the block arguments.
     * @property {string} TOPIC - the topic filter.
     */
    subscribe (args) {
        if (!this._client) return;
        this._client.subscribe(Cast.toString(args.TOPIC).trim(), err => {
            if (err) {
                log.warn(`MQTT subscribe failed: ${err}`);
            }
        });
    }

    /**
     * Unsubscribe from a topic.
     * @param {object} args - the block arguments.
     * @property {string} TOPIC - the topic filter.
     */
    unsubscribe (args) {
        if (!this._client) return;
        this._client.unsubscribe(Cast.toString(args.TOPIC).trim());
    }

    /**
     * Publish a message to a topic.
     * @param {object} args - the block arguments.
     * @property {string} TOPIC - the topic.
     * @property {string} MESSAGE - the payload.
     */
    publish (args) {
        if (!this._client || !this._client.connected) return;
        this._client.publish(
            Cast.toString(args.TOPIC).trim(),
            Cast.toString(args.MESSAGE)
        );
    }

    /**
     * @return {string} - the topic of the last received message.
     */
    getLastTopic () {
        return this._lastTopic;
    }

    /**
     * @return {string} - the payload of the last received message.
     */
    getLastMessage () {
        return this._lastMessage;
    }
}

module.exports = Scratch3MqttBlocks;
