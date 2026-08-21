const Buffer = require('buffer').Buffer;

const BLE = require('../../io/ble');
const Base64Util = require('../../util/base64-util');
const log = require('../../util/log');

/**
 * Nordic UART Service (NUS) UUIDs used by the OpenBlock MicroPython BLE
 * firmware (obble.py). Web Bluetooth requires lowercase 128-bit UUID strings.
 * @readonly
 */
const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // write
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify

/**
 * Max payload per BLE write. 20 bytes is safe for the minimum MTU (23),
 * the link layer keeps packets ordered and reliable. Used until the real
 * negotiated MTU has been read back from the board.
 * @readonly
 */
const BLE_CHUNK_SIZE = 20;

/**
 * Upper bound for one Web Bluetooth characteristic write.
 * @readonly
 */
const BLE_MAX_CHUNK_SIZE = 512;

/**
 * Python snippet printing the ATT MTU the board negotiated with us.
 * Works on any obble.py firmware version, old ones answer 23.
 * @readonly
 */
const BLE_MTU_QUERY = 'import obble\nprint(obble._uart._mtu if obble._uart else 23)';

/**
 * Raw source bytes per raw-REPL file write command.
 * @readonly
 */
const UPLOAD_BLOCK_SIZE = 128;

/**
 * Raw source bytes per file write command when the flow-controlled
 * raw-paste mode (MicroPython >= 1.13) is available. Kept moderate so the
 * temporary base64 string of one command stays small on the board.
 * @readonly
 */
const RAW_PASTE_BLOCK_SIZE = 4096;

/**
 * Timeout for a single raw REPL response.
 * @readonly
 */
const REPL_RESPONSE_TIMEOUT = 5000;

/**
 * Timeout for the "OK" acknowledgement of a live raw REPL command. The
 * board sends it right after receiving the end-of-input byte, before it
 * even starts executing, so a missing OK means the REPL state machines
 * are out of sync; waiting the full response timeout (sized for slow
 * command execution) would stretch the worst case to 5s. One BLE round
 * trip on a congested link stays well below this.
 * @readonly
 */
const LIVE_ACK_TIMEOUT = 1000;

/**
 * Max GATT connection attempts of one automatic reconnect run.
 * @readonly
 */
const RECONNECT_ATTEMPTS = 8;

/**
 * Wait before the first reconnect attempt after an upload soft reboot:
 * the board needs to reboot and bring BLE advertising back up (the
 * firmware advertises fast for 30s after boot, so this is enough for
 * the common case and the retry loop covers slow boards).
 * @readonly
 */
const POST_UPLOAD_RECONNECT_DELAY = 1500;

/**
 * Wait before the first reconnect attempt after an unexpected
 * connection drop; gives the browser stack a moment to settle.
 * @readonly
 */
const DROP_RECONNECT_DELAY = 300;

/**
 * How often the live-session watchdog samples the session state.
 * @readonly
 */
const LIVE_WATCHDOG_INTERVAL = 1000;

/**
 * How long "connected + realtime mode, but no live session and nothing
 * building one" may persist before the watchdog re-runs the live
 * handshake. Larger than the Web Serial post-reset boot wait (2500ms),
 * so a pending legitimate handshake normally flips _liveReady before
 * the watchdog would fire; even a duplicate entry is harmless because
 * _enterLiveMode no-ops once the session is up.
 * @readonly
 */
const LIVE_WATCHDOG_STALL_TIME = 3000;

/**
 * Minimum spacing between two PERIPHERAL_LIVE_UNAVAILABLE emissions.
 * Blocks in a forever loop hit the not-ready path many times per second,
 * the GUI only needs to learn about the state once in a while.
 * @readonly
 */
const LIVE_UNAVAILABLE_EMIT_THROTTLE = 1000;

/**
 * Live commands up to this many bytes go through the plain raw REPL:
 * a single direction change instead of the three the raw-paste
 * handshake needs, which matters a lot on high-latency links (each BLE
 * direction change costs a connection interval). The limit stays well
 * below every stdin buffer involved (UART RX 256, BLE rxbuf 1024), so
 * the missing input flow control of the plain raw REPL is safe here;
 * larger commands (device extension drivers) keep using raw-paste.
 * @readonly
 */
const RAW_REPL_MAX_COMMAND = 256;

/**
 * Python statements executed once when entering realtime (live) mode.
 * The generation reset kills a push sampler thread left over from a
 * previous live session (its loop exits once the generation no longer
 * matches), at zero extra round trips.
 * @readonly
 */
const LIVE_PROLOGUE = 'from machine import Pin, PWM, DAC, ADC, TouchPad\nimport time\n_ob_push_g=-1';

/**
 * How long one live sensor reading stays valid. Blocks polling the same
 * expression within this window share a single REPL round-trip instead
 * of queueing one each.
 * @readonly
 */
const LIVE_READ_CACHE_TTL = 50;

/**
 * How long incoming live read requests are collected before they are
 * flushed to the board as a single batched command. Scratch steps all
 * threads of one tick within a few milliseconds, so a short window
 * gathers the read blocks of every running loop into one REPL round
 * trip; on BLE (350-600ms RTT) this multiplies the read throughput by
 * the number of loops.
 * @readonly
 */
const LIVE_READ_BATCH_WINDOW = 10;

/**
 * Max expressions per batched read command, keeping the command small
 * enough to execute instantly on the board and the reply well below the
 * notification backlog limits.
 * @readonly
 */
const LIVE_READ_BATCH_LIMIT = 24;

/**
 * How long an expression stays "hot" after its last read request. Hot
 * expressions ride along in every batched read round trip even when no
 * block is waiting for them right now, keeping their cache fresh: a
 * program polling several sensors sequentially (await X, then await Y)
 * never has both reads pending at once, so without the ride-along each
 * axis would cost its own full round trip on a high-RTT link.
 * The resident read pump lives on the same window: it keeps refreshing
 * hot expressions in the background and stops by itself once none has
 * been read for this long. While the pump covers an expression its
 * cached value also stays servable for this long (instead of the plain
 * read cache TTL): the refresh chain bounds the real staleness to about
 * one round trip, and the window only acts as the dead-channel cutoff.
 * @readonly
 */
const LIVE_READ_HOT_WINDOW = 2000;

/**
 * Rest between a settled read round trip and the next resident pump
 * batch. One display frame: refreshing faster than the screen cannot be
 * seen, and the pause keeps a near-zero-RTT transport (Web Serial) from
 * saturating the line with back-to-back polls; on BLE the round trip
 * time dominates and the pause is negligible. The serialized queue
 * (at most one pump batch in flight) throttles everything else.
 * @readonly
 */
const LIVE_READ_PUMP_INTERVAL = 16;

/**
 * Separator between the values of one batched read reply: the ASCII
 * record separator, which can not appear in sensor readings.
 * @readonly
 */
const LIVE_READ_SEPARATOR = '\x1e';

/**
 * Board-side sampling period of the live push sampler in ms. The
 * sampler is a background thread injected through the raw REPL: it
 * evaluates the hot expressions at this rate and notifies one frame per
 * pass, so readings refresh at the sampling rate instead of the polling
 * round trip rate (the whole point of BLE-E). 25ms rounds to 30-40ms
 * on the 100Hz FreeRTOS tick, i.e. ~30Hz frames, about one per BLE
 * connection event at the negotiated 22-30ms interval.
 * @readonly
 */
const LIVE_PUSH_INTERVAL = 25;

/**
 * No valid frame for this long while the sampler should be running
 * means it is dead (killed by a session rebuild, thread crashed, or a
 * firmware without _thread never started it): fall back to the
 * resident read pump.
 * @readonly
 */
const LIVE_PUSH_STALL_TIMEOUT = 1000;

/**
 * Failed sampler starts/stalls per live session before push is given
 * up and the resident pump serves the whole session.
 * @readonly
 */
const LIVE_PUSH_MAX_FAILURES = 2;

/**
 * How long after a state-changing command settles that push frames are
 * still ignored: a frame emitted right after the write's reply may
 * have been sampled just before the write executed (the sampler thread
 * can be preempted mid-pass), and a pre-write value must never survive
 * a write. Slightly above one sampling period, so at most one frame is
 * sacrificed.
 * @readonly
 */
const LIVE_PUSH_WRITE_MUTE = 40;

/**
 * Frame markers of the push sampler: ASCII file/group separators,
 * which never occur in REPL protocol traffic or sensor readings.
 * A frame is FS 'P' <generation> ';' <values joined by \x1e> GS,
 * interleaved anywhere in the notification stream.
 * @readonly
 */
const LIVE_PUSH_FRAME_START = '\x1c';
const LIVE_PUSH_FRAME_END = '\x1d';

/**
 * A partial frame longer than this cannot be a real frame (the board
 * caps emitted frames at 512 bytes): the withheld bytes are released
 * back into the normal stream, bounding the damage of a stray frame
 * start byte in user program output.
 * @readonly
 */
const LIVE_PUSH_MAX_FRAME = 1024;

/**
 * Marker printed by a successfully started push sampler; its absence
 * in the command output means the board could not start it.
 * @readonly
 */
const LIVE_PUSH_ACK = 'OBPUSH1';

/**
 * How long incoming console bytes are collected before one
 * PERIPHERAL_RECIVE_DATA emission. A full-speed print flood arrives as
 * thousands of tiny transport packets per second; the GUI console only
 * needs frame-rate granularity. Chosen within one display frame so
 * interactive echo stays imperceptible.
 * @readonly
 */
const RECEIVE_FLUSH_INTERVAL = 24;

/**
 * Collected console bytes that force an immediate flush ahead of the
 * timer, bounding both memory and latency under extreme floods.
 * @readonly
 */
const RECEIVE_FLUSH_LIMIT = 4096;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Quote a JS string as a python single-quoted string literal.
 * @param {string} text - the text to quote.
 * @return {string} - the python literal.
 */
const pyStr = text => `'${String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")}'`;

/**
 * Manage communication with a MicroPython peripheral directly over
 * Web Bluetooth (BLE NUS), including program upload via the raw REPL
 * protocol. No OpenBlock Link service is required.
 */
class MicroPythonBlePeripheral {
    /**
     * Convert an extension library URL into a safe file name for the board.
     * Cache-busting query strings and URL fragments must not become part of
     * the MicroPython module name.
     * @param {string} fileUrl - library resource URL.
     * @return {string} - target file name on the board.
     */
    static libraryFileNameFromUrl (fileUrl) {
        const cleanUrl = String(fileUrl).split('#')[0].split('?')[0];
        const encodedName = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1);
        let fileName = encodedName;
        try {
            fileName = decodeURIComponent(encodedName);
        } catch (e) {
            // Keep the original segment if it is not valid percent encoding.
        }
        if (!fileName || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName)) {
            throw new Error(`Invalid library file URL: ${fileUrl}`);
        }
        return fileName;
    }
    /**
     * Construct a MicroPython BLE communication object.
     * @param {Runtime} runtime - the OpenBlock runtime
     * @param {string} deviceId - the id of the extension
     * @param {string} originalDeviceId - the original id of the peripheral, like xxx_microPythonEsp32Ble
     * @param {object} options - construction options.
     * @param {boolean} options.register - whether to register this instance in the runtime.
     */
    constructor (runtime, deviceId, originalDeviceId, options = {}) {
        this._runtime = runtime;
        this._deviceId = deviceId;
        this._originalDeviceId = originalDeviceId;
        this._webBluetoothOnly = options.webBluetoothOnly === true;

        this._ble = null;
        if (options.register !== false) {
            this._runtime.registerPeripheralExtension(deviceId, this);
        }

        /**
         * Buffer of incoming REPL text while an upload is running.
         * @type {string}
         */
        this._replBuffer = '';

        /**
         * Monotonic count of received bytes, used to detect a quiet line
         * (`_replBuffer` is cleared and sliced all the time, its length
         * cannot tell whether new data is still arriving).
         * @type {number}
         */
        this._rxTotal = 0;

        /**
         * Wakeup callbacks of pending _waitFor* calls, notified whenever
         * new REPL data arrives or the upload is aborted.
         * @type {Array.<Function>}
         */
        this._replWaiters = [];
        this._uploading = false;
        this._abort = false;

        /**
         * Whether an automatic reconnect run after an unexpected
         * connection drop is currently in progress.
         * @type {boolean}
         */
        this._reconnecting = false;

        /**
         * True from an unexpected connection drop until the channel is
         * usable again (or given up); makes in-flight REPL exchanges
         * fail fast instead of running into their timeout.
         * @type {boolean}
         */
        this._connectionDropped = false;

        /**
         * Last error seen by the reconnect loop, for the failure report.
         * @type {?Error}
         */
        this._lastReconnectError = null;

        /**
         * How many raw REPL exchanges are currently in flight. Incoming
         * data is captured into _replBuffer only while this is > 0 (or an
         * upload is running); everything else, e.g. asynchronous prints
         * from timers between live commands, flows to the GUI console.
         * @type {number}
         */
        this._replCaptureDepth = 0;

        /**
         * Whether the board REPL is currently in raw mode ready for live
         * (realtime) command execution.
         * @type {boolean}
         */
        this._liveReady = false;

        /**
         * Whether the board firmware supports the flow-controlled
         * raw-paste mode. null = not probed yet.
         * @type {?boolean}
         */
        this._rawPasteSupported = null;

        /**
         * Bytes per BLE write, grown after the negotiated MTU has been
         * read back from the board.
         * @type {number}
         */
        this._bleChunkSize = BLE_CHUNK_SIZE;
        this._bleMtuProbed = false;

        /**
         * Serialize all live REPL commands, raw REPL can only run one at
         * a time.
         * @type {Promise}
         */
        this._liveQueue = Promise.resolve();

        /**
         * How many live commands are queued or on the wire right now.
         * While this is nonzero an expired read batch window holds its
         * batch back instead of flushing: on a high-RTT link every read
         * arriving during the in-flight round trip then merges into one
         * command, so the merge degree scales with the RTT by itself.
         * @type {number}
         */
        this._liveInFlight = 0;

        /**
         * Pin numbers already initialized on the board during this live
         * session, mapped to their current mode string.
         * @type {object}
         */
        this._livePins = {};

        /**
         * Peripheral driver objects (pwm/dac/adc/touch/servo) already
         * created on the board during this live session.
         * @type {Set<string>}
         */
        this._liveObjects = new Set();

        /**
         * Short lived cache of sensor readings, expression -> entry with
         * an in-flight promise, a {value, time} pair, or both (a
         * ride-along refresh keeps the previous still-fresh value
         * readable while the new one is on the wire).
         * @type {object}
         */
        this._liveReadCache = {};

        /**
         * When each expression was last requested by a read block,
         * expression -> timestamp. Expressions read within
         * LIVE_READ_HOT_WINDOW ride along in batched read commands and
         * are kept fresh by the resident read pump.
         * @type {object}
         */
        this._liveReadLastSeen = {};

        /**
         * Pending timer of the resident read pump (null = none). The
         * pump re-arms itself after every settled live command and from
         * every read request, and falls silent on its own when no hot
         * expression is left, the channel is busy (upload/board-fs) or
         * the connection is gone.
         * @type {?object}
         */
        this._liveReadPumpTimer = null;

        /**
         * Board push sampler state (BLE-E). A background thread injected
         * through the raw REPL samples the hot expressions at a fixed
         * rate and notifies value frames; the vm feeds them into the
         * read cache, so readLiveString answers at the sampling rate
         * instead of the polling round trip rate. The resident pump is
         * the automatic fallback whenever push is off, failed or
         * unsupported. Transports where polling is already free (Web
         * Serial) disable it wholesale via _livePushEnabled.
         * gen is bumped on every (re)start, stop and session reset so
         * stale frames can never match; lastFrame tracks sampler
         * liveness; muteUntil/writesInFlight implement the post-write
         * frame grace (a frame may have been sampled before the write
         * executed and must not survive it); carry holds a partial
         * frame split across notification packets.
         * @type {boolean} / @type {boolean} / @type {boolean} /
         * @type {Array.<string>} / @type {number} / @type {number} /
         * @type {number} / @type {boolean} / @type {number} /
         * @type {number} / @type {string}
         */
        this._livePushEnabled = true;
        this._livePushActive = false;
        this._livePushStarting = false;
        this._livePushExprs = [];
        this._livePushGen = 0;
        this._livePushLastFrame = 0;
        this._livePushFailures = 0;
        this._livePushUnsupported = false;
        this._livePushMuteUntil = 0;
        this._liveWritesInFlight = 0;
        this._livePushCarry = '';
        // Instance copies so tests can shrink the timing.
        this._livePushStallMs = LIVE_PUSH_STALL_TIMEOUT;
        this._livePushWriteMuteMs = LIVE_PUSH_WRITE_MUTE;

        /**
         * Live-session watchdog state: the sampling timer, since when the
         * session has been observed stalled (null = not stalled), and
         * whether a watchdog-triggered recovery is still pending in the
         * live queue. Sampling/stall thresholds live on the instance so
         * tests can shrink them.
         * @type {?object} / @type {?number} / @type {boolean}
         */
        this._liveWatchdogTimer = null;
        this._liveStalledSince = null;
        this._liveWatchdogRecovering = false;
        this._liveWatchdogIntervalMs = LIVE_WATCHDOG_INTERVAL;
        this._liveWatchdogStallMs = LIVE_WATCHDOG_STALL_TIME;

        /**
         * Live-channel availability reporting: when the last
         * PERIPHERAL_LIVE_UNAVAILABLE was emitted (throttle) and whether
         * one is outstanding (an AVAILABLE event is owed on recovery).
         * @type {number} / @type {boolean}
         */
        this._lastLiveUnavailableEmit = 0;
        this._liveUnavailableAnnounced = false;

        /**
         * Read requests collected for the next batched flush, in arrival
         * order: {expression, resolvers} entries (identical expressions
         * within one window share an entry), plus the flush timer.
         * @type {Array.<object>} / @type {?object}
         */
        this._pendingLiveReads = [];
        this._liveReadFlushTimer = null;

        /**
         * Console bytes collected for the next aggregated
         * PERIPHERAL_RECIVE_DATA emission, their total size and the
         * pending flush timer.
         * @type {Array.<Buffer>} / @type {number} / @type {?object}
         */
        this._receiveChunks = [];
        this._receiveChunkBytes = 0;
        this._receiveFlushTimer = null;

        this.reset = this.reset.bind(this);
        this._onConnect = this._onConnect.bind(this);
        this._onMessage = this._onMessage.bind(this);
        this._handleProgramModeUpdate = this._handleProgramModeUpdate.bind(this);
        this._handleConnectionDrop = this._handleConnectionDrop.bind(this);
    }

    /**
     * Called by the runtime when user wants to scan for a peripheral.
     * Reuses the remembered granted device without a chooser when
     * possible, otherwise opens the browser Web Bluetooth chooser
     * filtered on the NUS service.
     * @param {Array.<string>} pnpidList - unused on the BLE transport.
     * @param {boolean} listAll - the GUI rescan flag; a user explicitly
     *   refreshing the list wants to pick a (different) device, so the
     *   chooser is forced instead of the silent remembered-device path.
     */
    scan (pnpidList, listAll = false) {
        if (this._ble) {
            // Replacing an old scan/connection object is internal cleanup, not
            // a user-visible disconnect. Emitting PERIPHERAL_DISCONNECTED here
            // can make the connection modal leave the scanning phase.
            this._ble.disconnect({silent: true});
        }
        // The user is picking a (possibly different) device: a pending
        // automatic reconnect run must stop touching this._ble.
        this._connectionDropped = false;
        this._ble = new BLE(this._runtime, this._originalDeviceId, {
            filters: [
                {services: [NUS_SERVICE]},
                {namePrefix: 'OB32', services: [NUS_SERVICE]}
            ]
        }, this._onConnect, this.reset, {
            webOnly: this._webBluetoothOnly,
            onUnexpectedDisconnect: this._handleConnectionDrop,
            forceChooser: listAll === true
        });
    }

    /**
     * Called by the runtime when user wants to connect to a certain peripheral.
     * @param {number} id - the id of the peripheral to connect to.
     */
    connect (id) {
        this._peripheralId = id;
        if (this._ble) {
            this._ble.connectPeripheral(id);
        }
    }

    /**
     * Disconnect from the peripheral.
     */
    disconnect () {
        if (this._ble) {
            this._ble.disconnect();
        }
        this.reset();
    }

    /**
     * Reset all the state.
     */
    reset () {
        this._stopLiveWatchdog();
        this._stopLiveReadPump();
        // Hand the tail of the console stream to the GUI instead of
        // dropping it with the connection.
        this._flushConsoleData();
        // No PERIPHERAL_LIVE_AVAILABLE here: the connection is gone and the
        // GUI clears the hint on PERIPHERAL_DISCONNECTED itself.
        this._liveUnavailableAnnounced = false;
        this._lastLiveUnavailableEmit = 0;
        this._replBuffer = '';
        this._uploading = false;
        this._abort = false;
        this._connectionDropped = false;
        this._replCaptureDepth = 0;
        // The next connection may be a different board/firmware.
        this._rawPasteSupported = null;
        this._bleChunkSize = BLE_CHUNK_SIZE;
        this._bleMtuProbed = false;
        this._resetLiveState();
        this._runtime.removeListener(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
    }

    /**
     * Forget everything about the live REPL session (called when the board
     * reboots or the connection drops).
     * @private
     */
    _resetLiveState () {
        this._liveReady = false;
        this._livePins = {};
        this._liveObjects = new Set();
        this._liveReadCache = {};
        // Board-side objects are gone after a reboot/session rebuild;
        // stale hot expressions would only ride along into NameErrors.
        this._liveReadLastSeen = {};
        // The push sampler belongs to the session: forget it and bump
        // the generation so frames from a not-yet-dead old sampler are
        // dropped. Support is re-probed per session (the next session
        // may run on different firmware after a reflash).
        this._livePushActive = false;
        this._livePushStarting = false;
        this._livePushExprs = [];
        this._livePushGen++;
        this._livePushLastFrame = 0;
        this._livePushFailures = 0;
        this._livePushUnsupported = false;
        this._livePushMuteUntil = 0;
        this._livePushCarry = '';
        // _liveWritesInFlight is intentionally kept: it mirrors
        // unsettled promises which will still settle and decrement.
    }

    /**
     * Return true if connected to the peripheral.
     * @return {boolean} - whether the peripheral is connected.
     */
    isConnected () {
        return this._ble ? this._ble.isConnected() : false;
    }

    /**
     * BLE has no baudrate; kept for interface compatibility with the
     * serialport peripheral.
     */
    setBaudrate () {
    }

    /**
     * Write data to the peripheral BLE NUS RX characteristic.
     * @param {string} data - the data to write.
     * @return {Promise} - a promise resolved when all chunks are sent.
     */
    write (data) {
        if (!this.isConnected()) return Promise.resolve();
        return this._writeRaw(Buffer.from(data));
    }

    /**
     * Send a message to the peripheral BLE NUS RX characteristic.
     * @param {Uint8Array} message - the message to write
     * @return {Promise} - a promise resolved when all chunks are sent.
     */
    send (message) {
        if (!this.isConnected()) return Promise.resolve();
        return this._writeRaw(Buffer.from(message));
    }

    /**
     * Write a buffer in BLE sized chunks.
     * @param {Buffer} buffer - the data to write.
     * @return {Promise} - a promise resolved when all chunks are sent.
     * @private
     */
    async _writeRaw (buffer) {
        const chunkSize = this._bleChunkSize;
        for (let i = 0; i < buffer.length; i += chunkSize) {
            const chunk = buffer.slice(i, i + chunkSize);
            await this._ble.write(NUS_SERVICE, NUS_RX, chunk.toString('base64'), 'base64', false);
        }
    }

    /**
     * Read back the ATT MTU the board negotiated and grow the write chunk
     * size accordingly. Runs once per connection, from inside the raw
     * REPL. Old firmware answers 23 and the safe 20 byte chunk is kept.
     * @return {Promise} - resolved when the probe finished.
     * @private
     */
    async _probeBleMtu () {
        // Only meaningful for the BLE transport; the Web Serial subclass
        // writes whole buffers and has no _ble socket.
        if (this._bleMtuProbed || !this._ble) return;
        this._bleMtuProbed = true;
        try {
            const output = await this._execRaw(BLE_MTU_QUERY);
            const mtu = parseInt(String(output).trim(), 10);
            if (!isNaN(mtu) && mtu > 23) {
                this._bleChunkSize = Math.min(mtu - 3, BLE_MAX_CHUNK_SIZE);
            }
        } catch (err) {
            // Unexpected firmware, keep the safe default chunk size.
        }
    }

    /**
     * Starts reading data from peripheral after BLE has connected to it.
     * @return {Promise} resolves when notification setup completes.
     * @private
     */
    _onConnect () {
        // The channel is usable again, pending exchanges may run.
        this._connectionDropped = false;
        // Every GATT session negotiates its own ATT MTU; a reconnected
        // link may have a smaller one than the last session, and writes
        // sized to a stale larger MTU would fail. Use the safe minimum
        // until the probe has read the fresh value back from the board.
        this._bleMtuProbed = false;
        this._bleChunkSize = BLE_CHUNK_SIZE;

        const notificationSetup = this._ble.startNotifications(NUS_SERVICE, NUS_TX, this._onMessage);

        // Initialize runtime state as soon as GATT is connected. Chrome can
        // keep the startNotifications() promise pending even after the
        // characteristic is already usable, so these listeners must not wait
        // for that promise to settle.
        this._runtime.removeListener(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
        this._runtime.on(this._runtime.constructor.PROGRAM_MODE_UPDATE, this._handleProgramModeUpdate);
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(() => this._enterLiveMode());
        }
        this._startLiveWatchdog();

        return notificationSetup.then(() => {
            if (!this.isConnected()) {
                throw new Error('Bluetooth notifications could not be started');
            }
            return true;
        });
    }

    /**
     * Process the data from the incoming BLE characteristic.
     * @param {string} base64 - the incoming BLE data.
     * @private
     */
    _onMessage (base64) {
        this._routeIncoming(Buffer.from(Base64Util.base64ToUint8Array(base64)));
    }

    /**
     * Route incoming peripheral data either into the raw REPL capture
     * buffer (while uploading or while a raw REPL exchange is in flight)
     * or to the GUI console. Asynchronous output produced by the board
     * between live commands is therefore visible to the user instead of
     * being discarded.
     * @param {Buffer} data - the incoming data.
     * @private
     */
    _routeIncoming (data) {
        let text = data.toString('latin1');
        if (this._livePushEnabled) {
            // Push frames may interleave with anything (the sampler is
            // a background thread); strip them before any protocol or
            // console handling sees the stream. Frames do not count as
            // line activity either: a still-running sampler must not
            // keep _interruptAndDrain waiting for a quiet line forever.
            text = this._extractPushFrames(text);
        }
        this._rxTotal += text.length;
        if (text.length === 0) return;
        if (this._uploading || this._replCaptureDepth > 0) {
            this._replBuffer += text;
            this._notifyReplWaiters();
            return;
        }
        this._bufferConsoleData(Buffer.from(text, 'latin1'));
    }

    /**
     * Remove complete push sampler frames from an incoming chunk and
     * hand them to _handlePushFrame; everything else (including a
     * malformed frame body, byte for byte) flows on unchanged. A frame
     * split across packets is carried until its end marker arrives; a
     * carry that outgrows any real frame is released back into the
     * stream, so a stray frame-start byte in user output can only
     * delay, never eat, the data.
     * @param {string} text - incoming chunk (latin1).
     * @return {string} - the chunk with complete frames removed.
     * @private
     */
    _extractPushFrames (text) {
        let data = this._livePushCarry + text;
        this._livePushCarry = '';
        let out = '';
        for (;;) {
            const start = data.indexOf(LIVE_PUSH_FRAME_START);
            if (start === -1) {
                out += data;
                break;
            }
            out += data.slice(0, start);
            const end = data.indexOf(LIVE_PUSH_FRAME_END, start + 1);
            if (end === -1) {
                const partial = data.slice(start);
                if (partial.length > LIVE_PUSH_MAX_FRAME) {
                    // Not a frame: release the start byte and rescan the
                    // rest, real frames further in are still recovered.
                    out += LIVE_PUSH_FRAME_START;
                    data = partial.slice(1);
                    continue;
                }
                this._livePushCarry = partial;
                break;
            }
            if (this._handlePushFrame(data.slice(start + 1, end))) {
                data = data.slice(end + 1);
                continue;
            }
            // Well-delimited but not a frame of ours: keep the bytes.
            out += LIVE_PUSH_FRAME_START;
            data = data.slice(start + 1);
        }
        return out;
    }

    /**
     * Consume one push sampler frame body: 'P' <generation> ';'
     * <values>. A well-formed frame is always consumed; it updates the
     * read cache only when it is current: right generation (config the
     * vm believes running), no state-changing command unsettled and out
     * of the post-write grace, and the value count matching the
     * expression list. Every current-generation frame refreshes the
     * sampler liveness clock even when its values are not used.
     * @param {string} body - the bytes between the frame markers.
     * @return {boolean} - true when consumed as a frame.
     * @private
     */
    _handlePushFrame (body) {
        if (body.charAt(0) !== 'P') return false;
        const sep = body.indexOf(';');
        if (sep <= 1) return false;
        const gen = Number(body.slice(1, sep));
        if (!Number.isInteger(gen)) return false;
        if (gen !== this._livePushGen || !this._livePushActive) return true;
        this._livePushLastFrame = Date.now();
        if (this._liveWritesInFlight > 0 || Date.now() < this._livePushMuteUntil) return true;
        const values = body.slice(sep + 1).split(LIVE_READ_SEPARATOR);
        if (values.length !== this._livePushExprs.length) return true;
        const time = Date.now();
        this._livePushExprs.forEach((expression, index) => {
            const entry = this._liveReadCache[expression];
            // An in-flight real read owns the slot; its reply is on the
            // same ordered stream and lands right after anyway.
            if (entry && entry.promise) return;
            this._liveReadCache[expression] = {value: values[index].trim(), time};
        });
        return true;
    }

    /**
     * Collect console bytes and emit them aggregated: a full-speed print
     * flood otherwise fires thousands of tiny PERIPHERAL_RECIVE_DATA
     * events per second at the GUI. Bytes are never dropped or reordered,
     * only concatenated; control sequences stay intact because splitting
     * points between transport packets were arbitrary anyway.
     * @param {Buffer} data - the console bytes.
     * @private
     */
    _bufferConsoleData (data) {
        this._receiveChunks.push(data);
        this._receiveChunkBytes += data.length;
        if (this._receiveChunkBytes >= RECEIVE_FLUSH_LIMIT) {
            this._flushConsoleData();
            return;
        }
        if (!this._receiveFlushTimer) {
            this._receiveFlushTimer = setTimeout(() => this._flushConsoleData(), RECEIVE_FLUSH_INTERVAL);
        }
    }

    /**
     * Emit all collected console bytes as one PERIPHERAL_RECIVE_DATA.
     * @private
     */
    _flushConsoleData () {
        if (this._receiveFlushTimer) {
            clearTimeout(this._receiveFlushTimer);
            this._receiveFlushTimer = null;
        }
        if (this._receiveChunks.length === 0) return;
        const chunks = this._receiveChunks;
        this._receiveChunks = [];
        this._receiveChunkBytes = 0;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_RECIVE_DATA,
            chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    }

    /**
     * Wake up all pending _waitFor* calls so they can re-check the REPL
     * buffer (or notice an abort).
     * @private
     */
    _notifyReplWaiters () {
        if (this._replWaiters.length === 0) return;
        const waiters = this._replWaiters;
        // A woken waiter may synchronously register itself again.
        this._replWaiters = [];
        for (const wake of waiters) {
            wake();
        }
    }

    /**
     * Handle the program mode update event: enter or leave the live raw
     * REPL depending on the new mode.
     * @private
     */
    _handleProgramModeUpdate () {
        if (!this.isConnected()) return;
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(() => this._enterLiveMode());
        } else {
            this._enqueueLive(() => this._exitLiveMode());
        }
    }

    /**
     * Emit a message to the upload progress console.
     * @param {string} message - the message.
     * @private
     */
    _sendstd (message) {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_STDOUT, {message});
    }

    /**
     * Wait, event driven (no polling), until data satisfying tryTake has
     * arrived in the REPL buffer. tryTake must consume and return the
     * data, or return null when the buffer does not satisfy it yet.
     * @param {Function} tryTake - () => (string|null).
     * @param {number} timeout - max time to wait in ms.
     * @param {string} what - description used in the timeout error.
     * @return {Promise<string>} - whatever tryTake returned.
     * @private
     */
    _waitForBuffer (tryTake, timeout, what) {
        return new Promise((resolve, reject) => {
            let timer = null;
            const attempt = () => {
                if (this._abort) {
                    clearTimeout(timer);
                    reject(new Error('Aborted'));
                    return;
                }
                if (this._connectionDropped) {
                    // The link is gone, the awaited bytes can never
                    // arrive; fail now instead of running into the
                    // timeout while the automatic reconnect runs.
                    clearTimeout(timer);
                    reject(new Error('Connection lost'));
                    return;
                }
                const taken = tryTake();
                if (taken !== null) {
                    clearTimeout(timer);
                    resolve(taken);
                    return;
                }
                this._replWaiters.push(attempt);
            };
            timer = setTimeout(() => {
                this._replWaiters = this._replWaiters.filter(wake => wake !== attempt);
                reject(new Error(`Timeout waiting for ${what} from the board`));
            }, timeout);
            attempt();
        });
    }

    /**
     * Wait until the REPL buffer contains the wanted text.
     * @param {string} want - the text to wait for.
     * @param {number} timeout - max time to wait in ms.
     * @return {Promise} - resolved when matched, rejected on timeout/abort.
     * @private
     */
    _waitFor (want, timeout = REPL_RESPONSE_TIMEOUT) {
        return this._waitForBuffer(() => {
            const index = this._replBuffer.indexOf(want);
            if (index === -1) return null;
            const result = this._replBuffer.slice(0, index);
            this._replBuffer = this._replBuffer.slice(index + want.length);
            return result;
        }, timeout, `"${want}"`);
    }

    /**
     * Execute one command in raw REPL mode and wait for completion.
     * @param {string} command - python source to execute.
     * @param {number} timeout - max time to wait for the output in ms.
     * @param {object} options - execution options.
     * @param {number} options.ackTimeout - max time to wait for the "OK"
     *   acknowledgement; a desynced REPL is detected this much faster
     *   than a slow command execution. Defaults to the full timeout.
     * @return {Promise} - resolved when the command finished.
     * @private
     */
    async _execRaw (command, timeout = REPL_RESPONSE_TIMEOUT, options = {}) {
        this._replCaptureDepth++;
        try {
            this._replBuffer = '';
            // Command and end-of-input marker in one write, saving a
            // packet on the BLE transport.
            // utf-8: MicroPython source is utf-8; latin1 would mangle any
            // non-ascii payload (e.g. Chinese print text or device names).
            await this._writeRaw(Buffer.from(`${command}\x04`, 'utf8'));
            // Raw REPL replies "OK<stdout>\x04<stderr>\x04>". The "OK"
            // arrives before execution starts, so it may use a tighter
            // timeout than the execution-bound stdout wait.
            await this._waitFor('OK', Math.min(timeout, options.ackTimeout || timeout));
            const output = await this._waitFor('\x04', timeout);
            const error = await this._waitFor('\x04');
            await this._waitFor('>');
            if (error.length > 0) {
                throw new Error(`Board error: ${error}`);
            }
            return output;
        } finally {
            this._replCaptureDepth--;
        }
    }

    /**
     * Wait until the REPL buffer contains at least the wanted number of
     * characters, then take and return them.
     * @param {number} count - how many characters to take.
     * @param {number} timeout - max time to wait in ms.
     * @return {Promise<string>} - the taken characters.
     * @private
     */
    _waitForCount (count, timeout = REPL_RESPONSE_TIMEOUT) {
        return this._waitForBuffer(() => {
            if (this._replBuffer.length < count) return null;
            const result = this._replBuffer.slice(0, count);
            this._replBuffer = this._replBuffer.slice(count);
            return result;
        }, timeout, `${count} bytes`);
    }

    /**
     * Execute one command through the flow-controlled raw-paste mode
     * (MicroPython >= 1.13). The command is streamed to the board without
     * buffering it whole in board RAM, which allows much larger commands
     * than the plain raw REPL. Falls back to _execRaw transparently when
     * the firmware does not support raw-paste; the answer is cached.
     * @param {string} command - python source to execute.
     * @param {number} timeout - max time to wait for the output in ms.
     * @return {Promise} - resolved with the command stdout.
     * @private
     */
    async _execRawPaste (command, timeout = REPL_RESPONSE_TIMEOUT) {
        if (this._rawPasteSupported === false) {
            return this._execRaw(command, timeout);
        }
        this._replCaptureDepth++;
        try {
            this._replBuffer = '';
            // Ask to enter raw-paste mode: CTRL-E "A" CTRL-A.
            await this._writeRaw(Buffer.from('\x05A\x01', 'latin1'));
            const answer = await this._waitForCount(2);
            if (answer === 'R\x01') {
                this._rawPasteSupported = true;
                await this._rawPasteWrite(Buffer.from(command, 'utf8'), timeout);
                // Unlike the plain raw REPL there is no leading "OK", the
                // reply is directly "<stdout>\x04<stderr>\x04>".
                const output = await this._waitFor('\x04', timeout);
                const error = await this._waitFor('\x04');
                await this._waitFor('>');
                if (error.length > 0) {
                    throw new Error(`Board error: ${error}`);
                }
                return output;
            }
            this._rawPasteSupported = false;
            if (answer !== 'R\x00') {
                // Old firmware does not understand the request at all: the
                // \x01 makes it re-enter the raw REPL and print the banner
                // again ("ra" of it was already consumed above).
                await this._waitFor('w REPL; CTRL-B to exit');
                await this._waitFor('>');
            }
            // 'R\x00' means understood but unsupported, the board is back
            // at the raw REPL waiting for a plain command in both cases.
            this._replBuffer = '';
            return await this._execRaw(command, timeout);
        } finally {
            this._replCaptureDepth--;
        }
    }

    /**
     * Stream command bytes to the board honoring the raw-paste window
     * based flow control, then wait for the end-of-data acknowledgement.
     * @param {Buffer} commandBytes - python source to stream.
     * @param {number} timeout - max time to wait for flow control in ms.
     * @return {Promise} - resolved when the board acknowledged the data.
     * @private
     */
    async _rawPasteWrite (commandBytes, timeout = REPL_RESPONSE_TIMEOUT) {
        // The first two bytes are the flow control window size (LE).
        const header = await this._waitForCount(2, timeout);
        const windowSize = header.charCodeAt(0) | (header.charCodeAt(1) << 8);
        let windowRemain = windowSize;
        let i = 0;
        while (i < commandBytes.length) {
            // Consume pending flow control bytes, or block until the board
            // opens a new window when the current one is used up.
            while (windowRemain === 0 || this._replBuffer.length > 0) {
                const flow = await this._waitForCount(1, timeout);
                if (flow === '\x01') {
                    windowRemain += windowSize;
                } else if (flow === '\x04') {
                    // The board ended the reception early (e.g. out of
                    // memory). Acknowledge and let the caller read the
                    // error from the regular stdout/stderr reply.
                    await this._writeRaw(Buffer.from('\x04'));
                    return;
                } else {
                    throw new Error('Unexpected flow control byte during raw-paste: ' +
                        `0x${flow.charCodeAt(0).toString(16)}`);
                }
            }
            if (this._abort) {
                throw new Error('Aborted');
            }
            const take = Math.min(windowRemain, commandBytes.length - i);
            await this._writeRaw(commandBytes.slice(i, i + take));
            windowRemain -= take;
            i += take;
        }
        // End of data, wait for the board acknowledgement.
        await this._writeRaw(Buffer.from('\x04'));
        await this._waitFor('\x04', timeout);
    }

    /**
     * Append a job to the live command queue, all raw REPL traffic is
     * serialized through it.
     * @param {Function} job - async function to run.
     * @return {Promise} - resolves with the job result, never rejects.
     * @private
     */
    _enqueueLive (job) {
        this._liveQueue = this._liveQueue
            .then(job)
            .catch(err => {
                // Board level errors must not break the queue chain. Log
                // them so block execution simply continues.
                log.warn('MicroPython live command failed:', err.message);
                return null;
            });
        return this._liveQueue;
    }

    /**
     * Interrupt a running program and wait until the line goes quiet.
     * A tight print loop saturates the link and the host buffers seconds
     * worth of output; entering the raw REPL right away would time out
     * because the banner only arrives after that backlog has drained.
     * Quiet line = program stopped and backlog fully received.
     * @param {number} maxWaitMs - upper bound for the drain.
     * @private
     */
    async _interruptAndDrain (maxWaitMs = 8000) {
        await this._writeRaw(Buffer.from('\r\x03\x03'));
        const start = Date.now();
        let lastTotal = this._rxTotal;
        let quietPolls = 0;
        let resent = false;
        while (Date.now() - start < maxWaitMs && quietPolls < 3) {
            await wait(100);
            if (this._rxTotal === lastTotal) {
                quietPolls++;
                continue;
            }
            quietPolls = 0;
            lastTotal = this._rxTotal;
            // Still streaming after 2s: the interrupt may have drowned in
            // the flood, ask once more (harmless at an idle REPL).
            if (!resent && Date.now() - start > 2000) {
                resent = true;
                await this._writeRaw(Buffer.from('\x03'));
            }
        }
    }

    /**
     * Interrupt the running program and switch the board REPL into raw
     * mode so blocks can be executed interactively.
     * @private
     */
    async _enterLiveMode () {
        if (this._liveReady || this._uploading || !this.isConnected()) return;
        // The flag blocks a second concurrent entry.
        this._liveReady = true;
        // Capture the whole handshake, its control sequences must not
        // reach the GUI console.
        this._replCaptureDepth++;
        try {
            this._replBuffer = '';
            await this._interruptAndDrain();
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x01'));
            await this._waitFor('raw REPL; CTRL-B to exit');
            // Also consume the trailing "\r\n>" prompt. Over fast transports
            // (Web Serial) it may still be in flight when the next step
            // clears the buffer, and would then poison positional reads
            // like the raw-paste probe answer.
            await this._waitFor('>');
            await this._probeBleMtu();
            await this._execRaw(LIVE_PROLOGUE);
            // The prologue killed any still-running push sampler (e.g.
            // after a board-fs exchange rebuilt the session while the vm
            // still believed push active). Drop the vm-side state without
            // charging the failure budget; the next beat restarts push.
            if (this._livePushActive || this._livePushStarting) {
                this._livePushActive = false;
                this._livePushStarting = false;
                this._livePushExprs = [];
                this._livePushGen++;
            }
            this._reportLiveAvailable();
        } catch (err) {
            this._liveReady = false;
            throw err;
        } finally {
            this._replCaptureDepth--;
        }
    }

    /**
     * Leave the live raw REPL and return the board to the friendly REPL,
     * console output flows to the GUI again.
     * @private
     */
    async _exitLiveMode () {
        if (!this._liveReady) return;
        // Best-effort sampler stop while the raw REPL is still ours
        // (this runs inside the live queue, so _execRaw directly; going
        // through execLive would deadlock on the queue). A failed stop
        // only leaves frames to be dropped by the generation check.
        if ((this._livePushActive || this._livePushStarting) && this.isConnected()) {
            try {
                await this._execRaw(MicroPythonBlePeripheral.buildLivePushStopCommand());
            } catch (e) {
                log.warn('MicroPython push sampler stop failed:', e.message);
            }
        }
        this._resetLiveState();
        if (!this.isConnected()) return;
        await this._writeRaw(Buffer.from('\x02'));
    }

    /**
     * Whether live (realtime) block execution is possible right now.
     * @return {boolean} - true when connected, in realtime mode and ready.
     */
    isReady () {
        return this._runtime.isRealtimeMode() && this.isConnected() && this._liveReady && !this._uploading;
    }

    /**
     * Execute python statements on the board in live mode. Commands go
     * through the flow-controlled raw-paste mode when the firmware
     * supports it: the plain raw REPL has no input flow control, so large
     * commands (e.g. a device extension sending a whole driver class)
     * lose bytes on the way to the board. Old firmware transparently
     * falls back to the plain raw REPL.
     * @param {string} command - python source to execute.
     * @param {number} timeout - max time to wait for the output in ms.
     * @param {object} options - execution options.
     * @param {boolean} options.isReadOnly - true when the command does not
     *   change any board state, keeping cached sensor readings valid.
     * @return {Promise<string>} - stdout of the command, null when not ready.
     */
    execLive (command, timeout = REPL_RESPONSE_TIMEOUT, options = {}) {
        if (!this.isReady()) {
            this._reportLiveUnavailable();
            return Promise.resolve(null);
        }
        const isWrite = options.isReadOnly !== true;
        if (isWrite) {
            // The command may move pins or reconfigure peripherals, any
            // cached sensor reading could be stale afterwards. Push
            // frames in flight may have been sampled before the write
            // executes; they are ignored until the write settles (plus
            // a one-period grace, see _handlePushFrame).
            this._liveReadCache = {};
            this._liveWritesInFlight++;
        }
        this._liveInFlight++;
        const finished = this._enqueueLive(async () => {
            if (!this.isReady()) {
                this._reportLiveUnavailable();
                return null;
            }
            const run = () => {
                if (Buffer.byteLength(command, 'utf8') <= RAW_REPL_MAX_COMMAND) {
                    // The tight ack timeout detects a desynced REPL fast
                    // (the OK arrives before execution); the stdout wait
                    // keeps the full execution-bound timeout.
                    return this._execRaw(command, timeout, {ackTimeout: LIVE_ACK_TIMEOUT});
                }
                return this._execRawPaste(command, timeout);
            };
            try {
                return await run();
            } catch (err) {
                // A "Board error:" is a python-level failure inside a
                // fully parsed reply, the protocol itself is healthy.
                // Everything else (timeout, unexpected flow control)
                // means the board and browser REPL state machines may
                // disagree now; resync or every following live command
                // would fail too, looking like a dead board.
                if (String(err && err.message).startsWith('Board error:')) {
                    throw err;
                }
                // Resync and retry the command once, so a transient
                // desync (e.g. the first batch after the green flag)
                // still answers this very block with a correct value
                // instead of a null after the full timeout.
                await this._recoverLiveSession();
                if (!this.isReady()) {
                    this._reportLiveUnavailable();
                    throw err;
                }
                try {
                    return await run();
                } catch (retryErr) {
                    if (!String(retryErr && retryErr.message).startsWith('Board error:')) {
                        // The retry failed at protocol level too: the
                        // caller sees null now, raise the channel hint
                        // and leave a fresh session behind.
                        this._reportLiveUnavailable();
                        await this._recoverLiveSession();
                    }
                    throw retryErr;
                }
            }
        });
        // _enqueueLive never rejects. Settling runs before the batch
        // values are dispatched to the waiting blocks (their .then is
        // chained behind this one), so a held read batch departs while
        // the queue is idle and the blocks resuming right after find
        // their next reads already on the wire. The pump re-arm keeps
        // hot expressions refreshing even when no read is pending.
        return finished.then(result => {
            if (isWrite) {
                this._liveWritesInFlight--;
                if (this._liveWritesInFlight === 0) {
                    this._livePushMuteUntil = Date.now() + this._livePushWriteMuteMs;
                }
            }
            this._liveInFlight--;
            if (this._liveInFlight === 0) {
                this._flushLiveReads();
                this._scheduleLiveReadPump();
            }
            return result;
        });
    }

    /**
     * Rebuild the live raw REPL session after a protocol-level failure:
     * interrupt whatever state the board is stuck in and redo the live
     * mode handshake. Board-side lazy objects are forgotten, they are
     * recreated on demand (the board may even have rebooted).
     * @return {Promise} - resolved when recovery finished or gave up.
     * @private
     */
    async _recoverLiveSession () {
        this._resetLiveState();
        if (this._uploading || !this.isConnected()) return;
        if (!(this._runtime.isRealtimeMode && this._runtime.isRealtimeMode())) return;
        try {
            await this._enterLiveMode();
        } catch (e) {
            // Still failing: stay out of live mode, the next mode switch
            // or reconnect will retry the handshake.
            log.warn('MicroPython live session recovery failed:', e.message);
        }
    }

    /**
     * Tell the GUI (throttled) that live blocks currently return null
     * because the live channel is unusable, so users can tell a real 0
     * from a dead channel. Only meaningful while the peripheral is
     * otherwise connected in realtime mode; a plain disconnect has its
     * own GUI state already.
     * @private
     */
    _reportLiveUnavailable () {
        if (!this.isConnected() || this._uploading) return;
        if (!(this._runtime.isRealtimeMode && this._runtime.isRealtimeMode())) return;
        const time = Date.now();
        if (time - this._lastLiveUnavailableEmit < LIVE_UNAVAILABLE_EMIT_THROTTLE) return;
        this._lastLiveUnavailableEmit = time;
        this._liveUnavailableAnnounced = true;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_LIVE_UNAVAILABLE, {
            deviceId: this._deviceId
        });
    }

    /**
     * Clear a previously reported PERIPHERAL_LIVE_UNAVAILABLE state once
     * the live session is up again.
     * @private
     */
    _reportLiveAvailable () {
        if (!this._liveUnavailableAnnounced) return;
        this._liveUnavailableAnnounced = false;
        this._lastLiveUnavailableEmit = 0;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_LIVE_AVAILABLE, {
            deviceId: this._deviceId
        });
    }

    /**
     * Start (or restart) the live-session watchdog for this connection.
     * Reconnect races (e.g. after an upload soft reboot) can leave the
     * board connected in realtime mode with no live session and nothing
     * scheduled to build one; every block then silently returns null
     * until the user toggles the program mode. The watchdog detects that
     * stall and re-runs the live handshake.
     * @private
     */
    _startLiveWatchdog () {
        this._stopLiveWatchdog();
        this._liveWatchdogTimer = setInterval(() => this._liveWatchdogTick(), this._liveWatchdogIntervalMs);
        // Do not keep a node.js test process alive; no-op in browsers.
        if (this._liveWatchdogTimer && typeof this._liveWatchdogTimer.unref === 'function') {
            this._liveWatchdogTimer.unref();
        }
    }

    /**
     * Stop the live-session watchdog (connection gone or state reset).
     * @private
     */
    _stopLiveWatchdog () {
        if (this._liveWatchdogTimer) {
            clearInterval(this._liveWatchdogTimer);
            this._liveWatchdogTimer = null;
        }
        this._liveStalledSince = null;
    }

    /**
     * One watchdog sample: when the session has been stalled longer than
     * the threshold, enqueue a live-mode re-entry. "Stalled" requires an
     * otherwise idle channel: a running upload, board-fs command or REPL
     * exchange (capture depth), an ongoing reconnect and a still pending
     * watchdog recovery all keep the watchdog quiet.
     * @private
     */
    _liveWatchdogTick () {
        const stalled =
            !!(this._runtime.isRealtimeMode && this._runtime.isRealtimeMode()) &&
            this.isConnected() &&
            !this._liveReady &&
            !this._uploading &&
            !this._reconnecting &&
            !this._connectionDropped &&
            this._replCaptureDepth === 0 &&
            !this._liveWatchdogRecovering;
        if (!stalled) {
            this._liveStalledSince = null;
            return;
        }
        if (this._liveStalledSince === null) {
            this._liveStalledSince = Date.now();
            return;
        }
        if (Date.now() - this._liveStalledSince < this._liveWatchdogStallMs) return;
        this._liveStalledSince = null;
        this._liveWatchdogRecovering = true;
        log.warn('MicroPython live session stalled, watchdog rebuilding it');
        // _enqueueLive never rejects; clearing the flag afterwards lets a
        // still failing session retry after the next full stall window.
        this._enqueueLive(() => this._enterLiveMode()).then(() => {
            this._liveWatchdogRecovering = false;
        });
    }

    /**
     * Make sure a Pin object exists on the board with the wanted mode.
     * @param {string} pin - the pin number.
     * @param {string} mode - 'in', 'out' or null to keep the current mode.
     * @return {string} - the python statements needed, may be empty.
     * @private
     */
    _pinSetupCode (pin, mode) {
        let code = '';
        if (!Object.prototype.hasOwnProperty.call(this._livePins, pin)) {
            code += `p${pin} = Pin(${pin})\n`;
            this._livePins[pin] = null;
        }
        if (mode && this._livePins[pin] !== mode) {
            code += `p${pin}.init(${mode})\n`;
            this._livePins[pin] = mode;
        }
        return code;
    }

    /**
     * Set a pin mode (live mode).
     * @param {string} pin - the pin number.
     * @param {string} mode - INPUT / OUTPUT / INPUT_PULLUP / INPUT_PULLDOWN.
     * @return {Promise} - resolved when done.
     */
    setPinMode (pin, mode) {
        const modeArgs = {
            INPUT: 'Pin.IN',
            OUTPUT: 'Pin.OUT',
            INPUT_PULLUP: 'Pin.IN, Pin.PULL_UP',
            INPUT_PULLDOWN: 'Pin.IN, Pin.PULL_DOWN'
        };
        const arg = modeArgs[mode] || 'Pin.IN';
        return this.execLive(this._pinSetupCode(pin, arg) || `p${pin}.init(${arg})`);
    }

    /**
     * Write a digital level to a pin (live mode).
     * @param {string} pin - the pin number.
     * @param {string} level - '1' or '0'.
     * @return {Promise} - resolved when done.
     */
    setDigitalOutput (pin, level) {
        const value = Number(level) ? 1 : 0;
        return this.execLive(`${this._pinSetupCode(pin, 'Pin.OUT')}p${pin}.value(${value})`);
    }

    /**
     * Write a pwm duty to a pin (live mode).
     * @param {string} pin - the pin number.
     * @param {number} out - duty 0-1023.
     * @return {Promise} - resolved when done.
     */
    setPwmOutput (pin, out) {
        let code = '';
        if (!this._liveObjects.has(`pwm${pin}`)) {
            code += `pwm${pin} = PWM(Pin(${pin}), freq=1000, duty=0)\n`;
            this._liveObjects.add(`pwm${pin}`);
            delete this._livePins[pin];
        }
        code += `pwm${pin}.duty(int(${Number(out) || 0}))`;
        return this.execLive(code);
    }

    /**
     * Write a dac value to a pin (live mode).
     * @param {string} pin - the pin number (25 or 26).
     * @param {number} out - value 0-255.
     * @return {Promise} - resolved when done.
     */
    setDACOutput (pin, out) {
        let code = '';
        if (!this._liveObjects.has(`dac${pin}`)) {
            code += `dac${pin} = DAC(Pin(${pin}))\n`;
            this._liveObjects.add(`dac${pin}`);
            delete this._livePins[pin];
        }
        code += `dac${pin}.write(int(${Number(out) || 0}))`;
        return this.execLive(code);
    }

    /**
     * Drive a servo on a pin (live mode).
     * @param {string} pin - the pin number.
     * @param {number} out - angle 0-180.
     * @return {Promise} - resolved when done.
     */
    setServoOutput (pin, out) {
        let code = '';
        if (!this._liveObjects.has(`servo${pin}`)) {
            code += `servo${pin} = PWM(Pin(${pin}), freq=50)\n`;
            this._liveObjects.add(`servo${pin}`);
            delete this._livePins[pin];
        }
        const angle = Number(out) || 0;
        code += `servo${pin}.duty(int(25.6 + (${angle}) * 102.4 / 180))`;
        return this.execLive(code);
    }

    /**
     * Run init code on the board once per live session.
     * @param {string} key - identifier of the object/module.
     * @param {string} initCode - python statements creating it.
     * @return {Promise} - resolved when the object exists.
     */
    async ensureLiveObject (key, initCode) {
        if (this._liveObjects.has(key)) return;
        if (initCode) await this.execLive(initCode);
        this._liveObjects.add(key);
    }

    /**
     * Whether an object was already created during this live session.
     * @param {string} key - identifier of the object/module.
     * @return {boolean} - true when present.
     */
    hasLiveObject (key) {
        return this._liveObjects.has(key);
    }

    /**
     * Ask the board to print an expression and return the raw text.
     * Readings are cached and concurrent reads of the same expression
     * share one REPL round-trip; distinct expressions arriving within
     * the batch window are merged into one round trip. Repeatedly read
     * (hot) expressions are refreshed in the background by the resident
     * pump, so their reads are answered from the cache without blocking:
     * the pump bounds the real staleness to about one round trip, which
     * is why a pump-covered value stays servable for the whole hot
     * window instead of the plain cache TTL.
     * @param {string} expression - python expression to print.
     * @return {Promise<string>} - trimmed output, empty string as fallback.
     */
    readLiveString (expression) {
        const now = Date.now();
        const lastSeen = this._liveReadLastSeen[expression];
        // Covered by the pump = already hot before this read and the
        // channel is usable, so refreshes are actually flowing. During
        // an upload or with the connection gone the strict TTL applies
        // again and stale values die out right away.
        const pumped = typeof lastSeen === 'number' &&
            (now - lastSeen <= LIVE_READ_HOT_WINDOW) &&
            this.isReady();
        this._liveReadLastSeen[expression] = now;
        this._scheduleLiveReadPump();
        const cached = this._liveReadCache[expression];
        if (cached) {
            // A still-servable value wins over an in-flight refresh:
            // blocks should not stall a full round trip while a good
            // value is at hand (ride-along entries carry both).
            const ttl = pumped ? LIVE_READ_HOT_WINDOW : LIVE_READ_CACHE_TTL;
            if (typeof cached.time === 'number' && now - cached.time < ttl) {
                return Promise.resolve(cached.value);
            }
            if (cached.promise) return cached.promise;
        }
        const promise = this._readLiveExpression(expression).then(value => {
            // Only publish if the cache was not invalidated meanwhile.
            if (this._liveReadCache[expression] &&
                this._liveReadCache[expression].promise === promise) {
                this._liveReadCache[expression] = {value, time: Date.now()};
            }
            return value;
        });
        this._liveReadCache[expression] = {promise};
        return promise;
    }

    /**
     * Queue one expression for the next batched read round trip. Loops
     * over several sensor blocks issue their reads within the same
     * scheduler tick; collecting them for a few milliseconds turns N
     * round trips into one, which is what makes reading usable over BLE.
     * @param {string} expression - python expression to evaluate.
     * @return {Promise<string>} - trimmed value, empty string as fallback.
     * @private
     */
    _readLiveExpression (expression) {
        return new Promise(resolve => {
            const pending = this._pendingLiveReads.find(entry => entry.expression === expression);
            if (pending) {
                pending.resolvers.push(resolve);
                return;
            }
            this._pendingLiveReads.push({expression, resolvers: [resolve]});
            if (this._pendingLiveReads.length >= LIVE_READ_BATCH_LIMIT) {
                this._flushLiveReads();
                return;
            }
            if (!this._liveReadFlushTimer) {
                this._liveReadFlushTimer = setTimeout(() => this._flushLiveReads(), LIVE_READ_BATCH_WINDOW);
            }
        });
    }

    /**
     * Send the collected read expressions to the board as one command
     * and dispatch the answered values back to the waiting blocks. The
     * batch only departs while the live queue is idle: with a command
     * already on the wire (high-RTT links keep one there most of the
     * time) it keeps collecting and the settle hook in execLive flushes
     * it the moment the queue drains, so every read arriving within one
     * round trip shares the next one. Hot expressions ride along to keep
     * their cache fresh. A failed batch (channel down, protocol error,
     * unparseable reply) degrades to empty strings, exactly like a
     * failed single read.
     * @private
     */
    _flushLiveReads () {
        if (this._liveReadFlushTimer) {
            clearTimeout(this._liveReadFlushTimer);
            this._liveReadFlushTimer = null;
        }
        const batch = this._pendingLiveReads;
        if (batch.length === 0) return;
        if (this._liveInFlight > 0 && batch.length < LIVE_READ_BATCH_LIMIT) {
            // Hold the batch back; only a full one departs early so the
            // command size stays bounded.
            return;
        }
        this._pendingLiveReads = [];
        // While the push sampler is streaming frames the hot expressions
        // are already being refreshed at the sampling rate; riding them
        // along would only bloat the command and the reply.
        const riders = this._livePushActive ? [] : this._collectHotRiders(batch);
        this._dispatchLiveReads(batch, riders);
    }

    /**
     * Send one batched read command (pending read entries plus riding
     * hot expressions) to the board and dispatch the answered values.
     * @param {Array.<object>} batch - pending read entries, may be empty
     *   for a pure pump refresh.
     * @param {Array.<object>} riders - rider objects from
     *   _collectHotRiders.
     * @private
     */
    _dispatchLiveReads (batch, riders) {
        const finish = values => {
            batch.forEach((entry, index) => {
                const value = values && index < values.length ? values[index] : '';
                entry.resolvers.forEach(resolve => resolve(value));
            });
            riders.forEach((rider, index) => {
                const valueIndex = batch.length + index;
                rider.settle(values && valueIndex < values.length ? values[valueIndex] : '');
            });
        };
        const expressions = batch.map(entry => entry.expression)
            .concat(riders.map(rider => rider.expression));
        if (expressions.length === 0) return;
        const command = expressions.length === 1 ?
            `print(${expressions[0]})` :
            MicroPythonBlePeripheral.buildLiveReadBatchCommand(expressions);
        this.execLive(command, REPL_RESPONSE_TIMEOUT, {isReadOnly: true}).then(output => {
            if (output === null) {
                finish(null);
                return;
            }
            if (expressions.length === 1) {
                finish([String(output).trim()]);
                return;
            }
            const parts = String(output).split(LIVE_READ_SEPARATOR);
            finish(parts.length === expressions.length ? parts.map(part => part.trim()) : null);
        });
    }

    /**
     * Arm the resident read pump unless it is already pending. The pump
     * runs one display frame later: long enough to keep a fast transport
     * from busy-polling, short enough to be invisible next to any real
     * round trip time.
     * @private
     */
    _scheduleLiveReadPump () {
        if (this._liveReadPumpTimer) return;
        this._liveReadPumpTimer = setTimeout(() => {
            this._liveReadPumpTimer = null;
            this._pumpLiveReads();
        }, LIVE_READ_PUMP_INTERVAL);
        // Do not keep a node.js test process alive; no-op in browsers.
        if (this._liveReadPumpTimer && typeof this._liveReadPumpTimer.unref === 'function') {
            this._liveReadPumpTimer.unref();
        }
    }

    /**
     * Stop a pending resident pump run (connection reset).
     * @private
     */
    _stopLiveReadPump () {
        if (this._liveReadPumpTimer) {
            clearTimeout(this._liveReadPumpTimer);
            this._liveReadPumpTimer = null;
        }
    }

    /**
     * One resident pump beat: while blocks keep reading, hot expressions
     * are refreshed with back-to-back batched reads (at most one in
     * flight ever, the live queue stays drained), so readLiveString is
     * answered from the cache and block execution never stalls on the
     * link RTT. The pump yields to everything else on the channel: a
     * command in flight re-arms the pump through its settle hook, an
     * upload / board-fs exchange / lost connection pauses it (the next
     * read request re-arms it), and it falls silent once no expression
     * has been read for the hot window.
     * @private
     */
    _pumpLiveReads () {
        if (this._liveInFlight > 0) return;
        if (this._pendingLiveReads.length > 0) {
            // Real reads are waiting and the queue is idle: depart now,
            // the window timer only exists for same-tick coalescing.
            this._flushLiveReads();
            return;
        }
        // _replCaptureDepth guards the raw channel during board-fs
        // exchanges and the live-mode handshake, which do not run
        // through the live queue.
        if (!this.isReady() || this._replCaptureDepth > 0) return;
        if (this._manageLivePush()) return;
        const riders = this._collectHotRiders([]);
        if (riders.length === 0) return;
        this._dispatchLiveReads([], riders);
    }

    /**
     * One push-management beat, run in place of a pump batch: keep the
     * board sampler matched to the hot expression set ((re)start it on
     * config changes, stop it when nothing is hot), watch its liveness
     * and fall back to the resident pump when it stalls or keeps
     * failing. Returns true when push owns the refreshing right now, so
     * the caller skips the pump batch; false hands the beat to the pump
     * (push disabled, given up, or just found dead).
     * @return {boolean} - whether the pump batch should be skipped.
     * @private
     */
    _manageLivePush () {
        if (!this._livePushEnabled || this._livePushUnsupported) return false;
        if (this._livePushStarting) return true;
        const hot = this._collectHotExpressions();
        if (hot.length === 0) {
            // Nothing to refresh: shut a running sampler down; either
            // way there is no pump work.
            if (this._livePushActive) this._stopLivePush();
            return true;
        }
        if (this._livePushActive) {
            if (Date.now() - this._livePushLastFrame > this._livePushStallMs) {
                // The sampler died silently (session rebuild killed it,
                // thread crashed...): count the failure and let the pump
                // take over this very beat; the next beat retries the
                // start until the failure budget is spent.
                this._livePushActive = false;
                this._livePushGen++;
                this._livePushFailures++;
                if (this._livePushFailures >= LIVE_PUSH_MAX_FAILURES) {
                    this._livePushUnsupported = true;
                }
                return false;
            }
            if (this._samePushConfig(hot)) {
                // Healthy and matching: keep the beat alive so config
                // changes, hot-window expiry and stalls are noticed even
                // while every read is answered from the cache.
                this._scheduleLiveReadPump();
                return true;
            }
        }
        this._startLivePush(hot);
        return true;
    }

    /**
     * The hot expressions (recently read) the push sampler should
     * serve, pruned, sorted for stable config comparison and capped
     * like a batched read command.
     * @return {Array.<string>} - the expressions.
     * @private
     */
    _collectHotExpressions () {
        const now = Date.now();
        const hot = [];
        for (const expression of Object.keys(this._liveReadLastSeen)) {
            if (now - this._liveReadLastSeen[expression] > LIVE_READ_HOT_WINDOW) {
                delete this._liveReadLastSeen[expression];
                continue;
            }
            hot.push(expression);
        }
        hot.sort();
        return hot.slice(0, LIVE_READ_BATCH_LIMIT);
    }

    /**
     * Whether the running sampler already serves exactly this (sorted)
     * expression list.
     * @param {Array.<string>} exprs - the wanted expressions.
     * @return {boolean} - true when the config matches.
     * @private
     */
    _samePushConfig (exprs) {
        if (exprs.length !== this._livePushExprs.length) return false;
        return exprs.every((expression, index) => expression === this._livePushExprs[index]);
    }

    /**
     * (Re)start the board push sampler for an expression list. The
     * start command is idempotent board-side: assigning the new
     * generation makes the previous sampler thread exit by itself.
     * Successful acknowledgement arms the frame path; anything else
     * (transport null, board error, missing marker - e.g. a firmware
     * without _thread) counts against the failure budget and the
     * resident pump serves the session once it is spent.
     * @param {Array.<string>} exprs - sorted expressions to sample.
     * @private
     */
    _startLivePush (exprs) {
        this._livePushStarting = true;
        const gen = ++this._livePushGen;
        const command = MicroPythonBlePeripheral.buildLivePushStartCommand(
            exprs, gen, LIVE_PUSH_INTERVAL);
        this.execLive(command, REPL_RESPONSE_TIMEOUT, {isReadOnly: true}).then(output => {
            this._livePushStarting = false;
            // Superseded by a newer start/stop/reset meanwhile.
            if (gen !== this._livePushGen) return;
            if (output !== null && String(output).indexOf(LIVE_PUSH_ACK) !== -1) {
                this._livePushActive = true;
                this._livePushExprs = exprs;
                this._livePushLastFrame = Date.now();
            } else {
                this._livePushActive = false;
                this._livePushFailures++;
                if (this._livePushFailures >= LIVE_PUSH_MAX_FAILURES) {
                    this._livePushUnsupported = true;
                }
            }
            // Either way the next beat acts on the new state (watch
            // frames or pump).
            this._scheduleLiveReadPump();
        });
    }

    /**
     * Stop the board push sampler (nothing hot anymore, or an upload is
     * about to take the channel). vm-side state drops synchronously so
     * frames already in flight are ignored at once; the board command
     * is best effort - a failed stop only means a few more dropped
     * frames until the sampler notices the generation change.
     * @return {Promise} - resolves when the stop command settled.
     * @private
     */
    _stopLivePush () {
        const wasRunning = this._livePushActive || this._livePushStarting;
        this._livePushActive = false;
        this._livePushStarting = false;
        this._livePushExprs = [];
        this._livePushGen++;
        if (!wasRunning) return Promise.resolve(null);
        return this.execLive(MicroPythonBlePeripheral.buildLivePushStopCommand(),
            REPL_RESPONSE_TIMEOUT, {isReadOnly: true});
    }

    /**
     * Pick the hot expressions (recently read, not already in the
     * departing batch, not already on the wire) that ride along in this
     * batched read command, and publish an in-flight cache entry for
     * each so concurrent reads share the round trip instead of queueing
     * their own. A rider entry keeps a still-fresh previous value
     * readable while the refresh is on the wire. settle(value) resolves
     * the entry; the cache write is skipped when the entry was
     * invalidated meanwhile (a state-changing command cleared the
     * cache), so a stale ride-along value never survives a write.
     * @param {Array.<object>} batch - the pending read entries departing.
     * @return {Array.<{expression: string, settle: Function}>} - riders.
     * @private
     */
    _collectHotRiders (batch) {
        const riders = [];
        const now = Date.now();
        const inBatch = new Set(batch.map(entry => entry.expression));
        for (const expression of Object.keys(this._liveReadLastSeen)) {
            if (batch.length + riders.length >= LIVE_READ_BATCH_LIMIT) break;
            if (now - this._liveReadLastSeen[expression] > LIVE_READ_HOT_WINDOW) {
                delete this._liveReadLastSeen[expression];
                continue;
            }
            if (inBatch.has(expression)) continue;
            const cached = this._liveReadCache[expression];
            if (cached && cached.promise) continue;
            let resolveRider;
            const promise = new Promise(resolve => {
                resolveRider = resolve;
            });
            this._liveReadCache[expression] = cached ?
                {promise, value: cached.value, time: cached.time} :
                {promise};
            riders.push({
                expression,
                settle: value => {
                    const entry = this._liveReadCache[expression];
                    if (entry && entry.promise === promise) {
                        this._liveReadCache[expression] = {value, time: Date.now()};
                    }
                    resolveRider(value);
                }
            });
        }
        return riders;
    }

    /**
     * Build the python command evaluating several read expressions in one
     * round trip. Each expression is evaluated in its own try block, so a
     * single failing sensor degrades to an empty value without hiding the
     * readings of the others; the values are joined with a separator that
     * can not appear in them and printed once.
     * @param {Array.<string>} expressions - python expressions to evaluate.
     * @return {string} - the python source.
     */
    static buildLiveReadBatchCommand (expressions) {
        // The parentheses keep an expression with a top level comma from
        // spilling into the lambda tuple.
        const lambdas = expressions.map(expression => `lambda:(${expression})`).join(',');
        return '_r=[]\n' +
            `for _f in (${lambdas},):\n` +
            ' try:_r.append(str(_f()))\n' +
            " except:_r.append('')\n" +
            `print('\\x1e'.join(_r))`;
    }

    /**
     * Build the python command installing the push sampler thread. The
     * thread evaluates the expressions every period (same value
     * semantics as a batched read: str(), empty string per failing
     * expression) and writes one delimited frame to stdout, which
     * os.dupterm mirrors into the BLE notification stream. It exits by
     * itself once the global generation no longer matches (the stop
     * command, a newer start and the live prologue all reassign it).
     * A background thread instead of machine.Timer: on this port
     * hardware timer ids alias (Timer(-1) is Timer(3)) and the obble
     * firmware owns that timer while connected, and threads need no
     * micropython.schedule slot either. Frames above the size cap are
     * skipped, the vm-side stall fallback covers pathological values.
     * @param {Array.<string>} expressions - python expressions to sample.
     * @param {number} gen - config generation embedded in every frame.
     * @param {number} periodMs - sampling period.
     * @return {string} - the python source.
     */
    static buildLivePushStartCommand (expressions, gen, periodMs) {
        const lambdas = expressions.map(expression => `lambda:(${expression})`).join(',');
        return 'import sys,time,_thread\n' +
            `_ob_push_g=${gen}\n` +
            'def _ob_push_run(_g,_fs):\n' +
            ' while _ob_push_g==_g:\n' +
            '  try:\n' +
            '   _r=[]\n' +
            '   for _f in _fs:\n' +
            '    try:_r.append(str(_f()))\n' +
            "    except:_r.append('')\n" +
            "   _s='\\x1cP%d;%s\\x1d'%(_g,'\\x1e'.join(_r))\n" +
            '   if len(_s)<=512:sys.stdout.write(_s)\n' +
            '  except:pass\n' +
            `  time.sleep_ms(${periodMs})\n` +
            `_thread.start_new_thread(_ob_push_run,(${gen},(${lambdas},)))\n` +
            `print('${LIVE_PUSH_ACK}')`;
    }

    /**
     * Build the python command stopping the push sampler: the thread
     * loop exits once the generation no longer matches.
     * @return {string} - the python source.
     */
    static buildLivePushStopCommand () {
        return '_ob_push_g=-1\n' +
            "print('OBPUSHOFF')";
    }

    /**
     * Ask the board to print an expression and parse the output as number.
     * @param {string} expression - python expression to print.
     * @return {Promise<number>} - the parsed value, 0 as fallback.
     */
    async readLiveNumber (expression) {
        const value = Number(await this.readLiveString(expression));
        return isNaN(value) ? 0 : value;
    }

    /**
     * Ask the board to print an expression and parse the output as number.
     * @param {string} expression - python expression to print.
     * @return {Promise<number>} - the parsed value, 0 as fallback.
     * @private
     */
    _readNumber (expression) {
        return this.readLiveNumber(expression);
    }

    /**
     * Read a digital pin (live mode).
     * @param {string} pin - the pin number.
     * @return {Promise<boolean>} - the pin level.
     */
    async readDigitalPin (pin) {
        // Only force input mode if the pin was never configured, so reading
        // back an output pin keeps working.
        const setup = this._pinSetupCode(pin, this._livePins[pin] ? null : 'Pin.IN');
        if (setup) await this.execLive(setup.trim());
        return (await this._readNumber(`p${pin}.value()`)) === 1;
    }

    /**
     * Read an analog pin through the ADC (live mode).
     * @param {string} pin - the pin number.
     * @return {Promise<number>} - adc value 0-4095.
     */
    async readAnalogPin (pin) {
        if (!this._liveObjects.has(`adc${pin}`)) {
            await this.execLive(`adc${pin} = ADC(Pin(${pin}))\nadc${pin}.atten(ADC.ATTN_11DB)`);
            this._liveObjects.add(`adc${pin}`);
            delete this._livePins[pin];
        }
        return this._readNumber(`adc${pin}.read()`);
    }

    /**
     * Read a capacitive touch pin (live mode).
     * @param {string} pin - the pin number.
     * @return {Promise<number>} - raw touch value.
     */
    async readTouchPin (pin) {
        if (!this._liveObjects.has(`tp${pin}`)) {
            await this.execLive(`tp${pin} = TouchPad(Pin(${pin}))`);
            this._liveObjects.add(`tp${pin}`);
            delete this._livePins[pin];
        }
        return this._readNumber(`tp${pin}.read()`);
    }

    /**
     * Print text on the board, output is forwarded to the GUI console.
     * @param {string} text - the text to print.
     * @param {string} eol - 'warp' appends a newline, 'noWarp' does not.
     * @return {Promise} - resolved when done.
     */
    async consolePrint (text, eol) {
        const end = eol === 'noWarp' ? ", end=''" : '';
        const output = await this.execLive(`print(${pyStr(text)}${end})`);
        if (output !== null && output.length > 0) {
            // Through the shared aggregation buffer, so earlier collected
            // console bytes cannot be overtaken (console order preserved).
            this._bufferConsoleData(Buffer.from(output, 'latin1'));
        }
    }

    /**
     * Set the BLE advertising name. Persisted on the board (ble_name.txt,
     * read by obble at boot); applied immediately when the board is not
     * connected over BLE, otherwise after the next disconnect. The adv
     * payload budget caps the name at 26 utf-8 bytes.
     * @param {string} name - the new device name.
     * @return {Promise} - resolved when done.
     */
    async setBleDeviceName (name) {
        let clean = String(name === null || name === undefined ? '' : name).trim();
        if (!clean) return;
        // Trim to the 26 byte budget without splitting a utf-8 code point.
        while (clean.length > 0 && Buffer.byteLength(clean, 'utf8') > 26) {
            clean = clean.slice(0, -1);
        }
        await this.execLive(`import obble\nobble.set_name(${pyStr(clean)})`);
    }

    /**
     * BLE has no DTR/RTS lines, ask MicroPython itself for a machine
     * reset instead, then reconnect like after an upload reboot.
     * @return {Promise<boolean>} - true when the reset was requested.
     */
    async hardReset () {
        if (!this.isConnected()) return false;
        this._resetLiveState();
        if (this._ble && typeof this._ble.expectDisconnect === 'function') {
            this._ble.expectDisconnect();
        }
        try {
            // Interrupt anything running, leave a possible raw REPL, then
            // request the reset. The GATT link may drop mid-write.
            await this._writeRaw(Buffer.from('\r\x03\x03\x02'));
            await this._writeRaw(Buffer.from('import machine\r\nmachine.reset()\r\n'));
        } catch (e) {
            // The board rebooted before the write fully completed.
        }
        await this._handlePostUploadReboot();
        if (this._runtime.isRealtimeMode()) {
            this._enqueueLive(() => this._enterLiveMode());
        }
        return true;
    }

    /**
     * Called by the runtime when user wants to upload code to the peripheral.
     * Writes boot.py (BLE bootstrap keeper) and main.py through the raw REPL,
     * then soft-reboots the board.
     * @param {string} code - the code want to upload.
     */
    async upload (code) {
        if (!this.isConnected()) {
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                message: 'No peripheral is connected'
            });
            return;
        }

        // Stop the push sampler first (queued like any live command):
        // the soft reboot would kill it anyway, but a sampler running
        // through the upload would interleave frames with every REPL
        // exchange until then.
        this._stopLivePush();
        // Wait for pending live commands, then take over the REPL channel.
        await this._liveQueue;
        this._liveReady = false;

        this._uploading = true;
        this._abort = false;
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_SET_UPLOAD_ABORT_ENABLED, true);

        try {
            this._sendstd('Entering raw REPL...\n');
            // Interrupt any running program, then enter raw REPL.
            this._replBuffer = '';
            await this._interruptAndDrain();
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x01'));
            await this._waitFor('raw REPL; CTRL-B to exit');
            // Consume the trailing prompt, see _enterLiveMode.
            await this._waitFor('>');

            await this._probeBleMtu();

            // Also probes for raw-paste support, which speeds up all the
            // following file writes considerably.
            await this._execRawPaste('import ubinascii');
            if (this._rawPasteSupported) {
                this._sendstd('Fast upload (raw-paste mode) enabled.\n');
            }

            // Install the library modules of the loaded device extensions
            // (fetched from the external resources) before the program.
            const libraryFiles = this._runtime.getCurrentDeviceExtensionLibraryFiles ?
                this._runtime.getCurrentDeviceExtensionLibraryFiles() : [];
            for (const fileUrl of libraryFiles) {
                let fileName = fileUrl;
                try {
                    fileName = MicroPythonBlePeripheral.libraryFileNameFromUrl(fileUrl);
                    const response = await fetch(fileUrl);
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const content = Buffer.from(await response.arrayBuffer());
                    await this._writeFileRaw(fileName, content);
                } catch (e) {
                    this._sendstd(`Warning: could not install library ${fileName}: ${e.message}\n`);
                }
            }

            await this._writeFileRaw('main.py', Buffer.from(code, 'utf-8'));

            this._sendstd('Reset board...\n');
            // Exit raw REPL then soft reboot so boot.py + main.py run.
            await this._writeRaw(Buffer.from('\x02'));
            await wait(100);
            // Ctrl-D triggers a soft reboot and therefore a short BLE GATT
            // disconnect. Mark it expected before sending the byte to avoid
            // racing the browser's gattserverdisconnected event.
            if (this._ble && typeof this._ble.expectDisconnect === 'function') {
                this._ble.expectDisconnect();
            }
            await this._writeRaw(Buffer.from('\x04'));

            this._uploading = false;
            await this._handlePostUploadReboot();

            this._sendstd('Success\n');
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_SUCCESS, false);
        } catch (err) {
            const aborted = err.message === 'Aborted';
            this._uploading = false;
            if (aborted) {
                // Try to leave raw REPL so the board is usable again.
                this._writeRaw(Buffer.from('\x02'));
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_SUCCESS, true);
            } else {
                this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
                    message: err.message
                });
            }
        }
    }

    /**
     * Write one file to the board through the raw REPL in base64 chunks.
     * Requires ubinascii to be already imported in the raw REPL session.
     * @param {string} fileName - target file name on the board.
     * @param {Buffer} data - the file content.
     * @return {Promise} - resolved when the file is written.
     * @private
     */
    async _writeFileRaw (fileName, data) {
        this._sendstd(`Writing ${fileName}...\n`);
        await this._execRawPaste(`f = open('${fileName}', 'wb')`);
        // Raw-paste streams the command with flow control instead of
        // buffering it whole on the board, so much larger blocks per
        // round-trip are possible.
        const blockSize = this._rawPasteSupported ? RAW_PASTE_BLOCK_SIZE : UPLOAD_BLOCK_SIZE;
        const total = Math.ceil(data.length / blockSize) || 1;
        for (let i = 0; i < data.length; i += blockSize) {
            if (this._abort) {
                throw new Error('Aborted');
            }
            const block = data.slice(i, i + blockSize).toString('base64');
            await this._execRawPaste(`f.write(ubinascii.a2b_base64('${block}'))`);
            const blockNumber = Math.floor(i / blockSize) + 1;
            this._sendstd(`Writing ${fileName} ${Math.round(blockNumber / total * 100)}%\n`);
        }
        await this._execRawPaste('f.close()');
    }

    /**
     * The soft reboot drops the BLE connection. Mark it as an expected
     * disconnect so no "connection lost" error pops up, then reconnect
     * automatically once the board is back. Transports that survive a
     * soft reboot (USB serial) override this with a no-op.
     * @return {Promise} - resolved when the channel is usable again.
     * @private
     */
    async _handlePostUploadReboot () {
        // The board may already have dropped GATT by the time this runs. If
        // it has not, close the old connection silently; the UI should remain
        // in its connected state while automatic reconnect is in progress.
        if (this.isConnected()) {
            this._ble.disconnect({silent: true});
        }
        this._sendstd('Waiting for the board to reboot...\n');
        const connected = await this._reconnect({
            initialDelayMs: POST_UPLOAD_RECONNECT_DELAY,
            shouldContinue: () => !this._abort,
            verbose: true
        });
        if (connected || this._abort) return;

        // Reconnect has definitively failed. Now publish the disconnected
        // state so the menu bar and an open connection modal agree.
        this._ble.disconnect();
        const lastError = this._lastReconnectError;
        const detail = lastError && lastError.message ? ` (${lastError.message})` : '';
        const message = `Could not reconnect automatically${detail}. Please reconnect the device manually.`;
        this._sendstd(`${message}\n`);
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_REQUEST_ERROR, {
            message,
            deviceId: this._deviceId
        });
    }

    /**
     * Reconnect to the board using the still granted Web Bluetooth device
     * handle, no new device chooser is needed. Used after an upload soft
     * reboot and after an unexpected connection drop.
     * @param {object} options - reconnect options.
     * @param {number} options.initialDelayMs - wait before the first try,
     *   e.g. the board reboot time.
     * @param {number} options.attempts - max GATT connection attempts.
     * @param {Function} options.shouldContinue - polled before every
     *   attempt; return false to stop retrying (user abort/new scan).
     * @param {boolean} options.verbose - log progress to the upload console.
     * @return {Promise<boolean>} - true when the channel is usable again.
     * @private
     */
    async _reconnect ({
        initialDelayMs = POST_UPLOAD_RECONNECT_DELAY,
        attempts = RECONNECT_ATTEMPTS,
        shouldContinue = null,
        verbose = false
    } = {}) {
        this._lastReconnectError = null;
        await wait(initialDelayMs);
        for (let retry = 0; retry < attempts; retry++) {
            if (shouldContinue && !shouldContinue()) return false;
            try {
                // Wait for notification subscription (_onConnect) before
                // considering the channel usable.
                const connected = await this._ble.connectPeripheral(this._peripheralId, {silent: true});
                if (connected && this.isConnected()) {
                    if (verbose) this._sendstd('Bluetooth reconnected.\n');
                    return true;
                }
            } catch (error) {
                this._lastReconnectError = error;
            }
            await wait(1000 + (retry * 250));
        }
        return false;
    }

    /**
     * Called by the Web Bluetooth backend when the GATT link dropped
     * unexpectedly (board reboot or brown-out, out of range). The firmware
     * advertises fast for 30s after a disconnect and the granted device
     * handle can be reconnected without a chooser, so try to get the
     * session back silently; only report a lost connection when that
     * fails. On success the realtime session is rebuilt by _onConnect.
     * @return {Promise} - resolved when the run finished either way.
     * @private
     */
    async _handleConnectionDrop () {
        if (this._reconnecting) return;
        this._reconnecting = true;
        try {
            // Fail in-flight raw REPL exchanges fast instead of letting
            // them run into their timeouts; the board-side live session
            // is stale now anyway and is rebuilt after the reconnect.
            this._connectionDropped = true;
            this._resetLiveState();
            this._notifyReplWaiters();
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_RECONNECTING, {
                deviceId: this._deviceId
            });
            const connected = await this._reconnect({
                initialDelayMs: DROP_RECONNECT_DELAY,
                // reset() clears the flag when the user disconnects or
                // starts a new scan meanwhile; stop retrying then.
                shouldContinue: () => this._connectionDropped
            });
            if (connected) return;
            if (!this._connectionDropped) return;
            // Give up: publish the loss the same way an unexpected
            // disconnect did before automatic reconnects existed.
            this._ble.disconnect();
            this.reset();
            this._runtime.emit(this._runtime.constructor.PERIPHERAL_CONNECTION_LOST_ERROR, {
                message: 'Scratch lost connection to',
                deviceId: this._deviceId
            });
        } finally {
            this._reconnecting = false;
        }
    }

    /**
     * Called by the runtime when user wants to abort the uploading process.
     */
    abortUpload () {
        this._abort = true;
        // Wake pending REPL waits so they fail fast instead of timing out.
        this._notifyReplWaiters();
    }

    /**
     * Whether firmware flashing is actually supported on this channel.
     * @return {boolean} - false, BLE can not carry the firmware image.
     */
    canUploadFirmware () {
        return false;
    }

    /**
     * BLE channel can not flash the MicroPython firmware itself, this
     * requires the USB serial channel.
     */
    uploadFirmware () {
        this._runtime.emit(this._runtime.constructor.PERIPHERAL_UPLOAD_ERROR, {
            message: 'Flashing firmware is not supported over BLE, please use the USB serial device instead'
        });
    }

    /**
     * Reject path traversal / injection before embedding a path in Python.
     * Kept permissive otherwise: files already on the board may carry odd
     * names (e.g. a legacy cache-busting "lib.py?v=1.0.0") and must stay
     * manageable. Quotes and backslashes are escaped by _pyQuote.
     * @param {string} filePath - board-relative path.
     * @return {string} sanitized path.
     * @private
     */
    _sanitizeBoardPath (filePath) {
        const value = String(filePath || '.').replace(/\\/g, '/');
        if (!value) {
            throw new Error('Invalid board path');
        }
        // Control characters could break out of the quoted python literal
        // or disturb the raw REPL protocol itself.
        for (let i = 0; i < value.length; i++) {
            const code = value.charCodeAt(i);
            if (code < 0x20 || code === 0x7F) {
                throw new Error('Invalid board path');
            }
        }
        if (value.split('/').indexOf('..') !== -1) {
            throw new Error('Invalid board path');
        }
        return value;
    }

    /**
     * Quote a path as a Python single-quoted string literal.
     * @param {string} filePath - sanitized path.
     * @return {string} python literal.
     * @private
     */
    _pyQuote (filePath) {
        return `'${String(filePath).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }

    /**
     * Run a short raw-REPL command for board filesystem access, restoring
     * live mode afterwards when the runtime is in realtime mode.
     * @param {string} command - python source.
     * @param {number} timeout - response timeout.
     * @return {Promise<string>} command stdout.
     * @private
     */
    async _runBoardFsCommand (command, timeout = REPL_RESPONSE_TIMEOUT) {
        if (!this.isConnected()) {
            throw new Error('No peripheral is connected');
        }
        await this._liveQueue;
        const wasLive = this._liveReady;
        this._liveReady = false;
        // Capture the whole exchange, the raw REPL handshake banners must
        // not reach the GUI console and _waitFor only sees captured data.
        this._replCaptureDepth++;
        try {
            this._replBuffer = '';
            await this._interruptAndDrain();
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x01'));
            await this._waitFor('raw REPL; CTRL-B to exit');
            // Consume the trailing prompt, see _enterLiveMode.
            await this._waitFor('>');
            const output = await this._execRaw(command, timeout);
            await this._writeRaw(Buffer.from('\x02'));
            // Swallow the friendly REPL banner printed after CTRL-B.
            await this._waitFor('>>>', 1000).catch(() => {});
            return output;
        } finally {
            this._replCaptureDepth--;
            if (wasLive && this._runtime.isRealtimeMode && this._runtime.isRealtimeMode()) {
                this._enqueueLive(() => this._enterLiveMode());
            }
        }
    }

    /**
     * List files on the MicroPython board filesystem.
     * @param {string} directory - board directory (default '.').
     * @return {Promise<Array.<{name:string, path:string, isDir:boolean, size:number}>>}
     */
    async listBoardFiles (directory = '.') {
        const dir = this._sanitizeBoardPath(directory || '.');
        const quoted = this._pyQuote(dir);
        const command =
            'import os\n' +
            `_p=${quoted}\n` +
            'try:\n' +
            ' _names=os.listdir(_p)\n' +
            'except OSError:\n' +
            ' _names=os.listdir()\n' +
            " _p='.'\n" +
            'for _n in _names:\n' +
            " _full=(_p.rstrip('/')+'/'+_n) if _p not in ('.',) else _n\n" +
            ' try:\n' +
            '  _st=os.stat(_full)\n' +
            '  _isdir=(_st[0]&0x4000)!=0\n' +
            "  print(('D' if _isdir else 'F')+'\\t'+_n+'\\t'+str(0 if _isdir else _st[6]))\n" +
            ' except OSError:\n' +
            "  print('F\\t'+_n+'\\t0')\n";
        const output = await this._runBoardFsCommand(command);
        return MicroPythonBlePeripheral.parseBoardLsOutput(output, dir);
    }

    /**
     * Read a file from the board as base64.
     * @param {string} filePath - board file path.
     * @return {Promise<{name:string, path:string, size:number, contentBase64:string}>}
     */
    async readBoardFile (filePath) {
        const path = this._sanitizeBoardPath(filePath);
        const quoted = this._pyQuote(path);
        const command =
            'import os,ubinascii\n' +
            `_p=${quoted}\n` +
            '_st=os.stat(_p)\n' +
            'if (_st[0]&0x4000)!=0:\n' +
            " raise OSError('is a directory')\n" +
            'if _st[6] > 200000:\n' +
            " raise OSError('file too large')\n" +
            "with open(_p,'rb') as _f:\n" +
            ' _data=_f.read()\n' +
            "print(str(_st[6])+'\\t'+ubinascii.b2a_base64(_data).decode().strip())\n";
        const output = await this._runBoardFsCommand(command, 60000);
        const line = String(output || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
        const tab = line.indexOf('\t');
        if (tab === -1) {
            throw new Error('Unexpected board file response');
        }
        const size = Number(line.slice(0, tab));
        const contentBase64 = line.slice(tab + 1).replace(/\s+/g, '');
        const name = path.split('/').pop();
        return {name, path, size, contentBase64};
    }

    /**
     * Delete a file (or empty directory) on the board.
     * @param {string} filePath - board path.
     * @return {Promise<boolean>}
     */
    async removeBoardFile (filePath) {
        const path = this._sanitizeBoardPath(filePath);
        const quoted = this._pyQuote(path);
        const command =
            'import os\n' +
            `_p=${quoted}\n` +
            '_st=os.stat(_p)\n' +
            'if (_st[0]&0x4000)!=0:\n' +
            ' os.rmdir(_p)\n' +
            'else:\n' +
            ' os.remove(_p)\n' +
            "print('OK')\n";
        await this._runBoardFsCommand(command);
        return true;
    }

    /**
     * Write a file to the board from base64 content.
     * @param {string} filePath - board path.
     * @param {string} contentBase64 - file bytes as base64.
     * @return {Promise<boolean>}
     */
    async writeBoardFile (filePath, contentBase64) {
        const path = this._sanitizeBoardPath(filePath);
        if (!this.isConnected()) {
            throw new Error('No peripheral is connected');
        }
        const data = Buffer.from(String(contentBase64 || ''), 'base64');
        await this._liveQueue;
        const wasLive = this._liveReady;
        this._liveReady = false;
        // Same capture rules as _runBoardFsCommand.
        this._replCaptureDepth++;
        try {
            this._replBuffer = '';
            await this._interruptAndDrain();
            this._replBuffer = '';
            await this._writeRaw(Buffer.from('\r\x01'));
            await this._waitFor('raw REPL; CTRL-B to exit');
            // Consume the trailing prompt, see _enterLiveMode.
            await this._waitFor('>');
            await this._execRawPaste('import ubinascii');
            await this._writeFileRaw(path, data);
            await this._writeRaw(Buffer.from('\x02'));
            // Swallow the friendly REPL banner printed after CTRL-B.
            await this._waitFor('>>>', 1000).catch(() => {});
            return true;
        } finally {
            this._replCaptureDepth--;
            if (wasLive && this._runtime.isRealtimeMode && this._runtime.isRealtimeMode()) {
                this._enqueueLive(() => this._enterLiveMode());
            }
        }
    }

    /**
     * Parse `listBoardFiles` stdout into structured entries.
     * @param {string} output - raw REPL stdout.
     * @param {string} directory - listed directory.
     * @return {Array.<{name:string, path:string, isDir:boolean, size:number}>}
     */
    static parseBoardLsOutput (output, directory = '.') {
        const dir = directory && directory !== '.' ? String(directory).replace(/\/$/, '') : '';
        const entries = [];
        String(output || '').split(/\r?\n/).forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const parts = trimmed.split('\t');
            if (parts.length < 2) return;
            const kind = parts[0];
            const name = parts[1];
            const size = Number(parts[2] || 0);
            if ((kind !== 'F' && kind !== 'D') || !name) return;
            entries.push({
                name,
                path: dir ? `${dir}/${name}` : name,
                isDir: kind === 'D',
                size: Number.isFinite(size) ? size : 0
            });
        });
        entries.sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return entries;
    }
}

module.exports = MicroPythonBlePeripheral;
module.exports.parseBoardLsOutput = MicroPythonBlePeripheral.parseBoardLsOutput;
