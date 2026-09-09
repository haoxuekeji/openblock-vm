const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);
const MicroPythonWebSerialPeripheral = require(
    '../../src/devices/common/micropython-webserial-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const STOP_TOKEN = MicroPythonBlePeripheral.STOP_TOKEN;
const BANNER = 'raw REPL; CTRL-B to exit\r\n>';

const makeRuntime = () => {
    const events = [];
    return {
        constructor: {
            PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
            PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
            PERIPHERAL_LIVE_UNAVAILABLE: 'PERIPHERAL_LIVE_UNAVAILABLE',
            PERIPHERAL_LIVE_AVAILABLE: 'PERIPHERAL_LIVE_AVAILABLE',
            PERIPHERAL_UPLOAD_STDOUT: 'PERIPHERAL_UPLOAD_STDOUT',
            PERIPHERAL_UPLOAD_ERROR: 'PERIPHERAL_UPLOAD_ERROR',
            PERIPHERAL_SET_UPLOAD_ABORT_ENABLED: 'PERIPHERAL_SET_UPLOAD_ABORT_ENABLED'
        },
        events,
        emit (name, payload) {
            events.push({name, payload});
        },
        on () {},
        removeListener () {},
        registerPeripheralExtension () {},
        isRealtimeMode: () => true
    };
};

/**
 * A fake board running a program whose bare `except:` swallows the
 * first `swallow` interrupts; the next one stops it, after which a
 * Ctrl-A is answered with the raw REPL banner. Live commands are
 * acknowledged once at the raw REPL.
 * @param {MicroPythonBlePeripheral} peripheral - the peripheral under test.
 * @param {object} options - board behaviour.
 * @param {number} options.swallow - interrupts swallowed before stopping
 *   (Infinity = never stops).
 * @param {boolean} options.hasBle - whether the peripheral is on BLE
 *   (a `_ble` handle makes it send the stop token).
 * @return {{writes: Array.<string>, state: object}} - the write log and
 *   the mutable board state.
 */
const wireBoard = (peripheral, {swallow = 0, hasBle = true} = {}) => {
    const writes = [];
    const state = {running: true, swallowed: 0};
    if (hasBle) {
        peripheral._ble = {write: () => Promise.resolve()};
    }
    peripheral.isConnected = () => true;
    peripheral._interruptGapsMs = [5, 10, 15];
    peripheral._rawReplProbeTimeoutMs = 40;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        writes.push(text);
        const reply = answer => peripheral._routeIncoming(Buffer.from(answer, 'latin1'));
        if (text.includes('\x03')) {
            if (state.running) {
                if (state.swallowed < swallow) {
                    state.swallowed++;
                } else {
                    state.running = false;
                }
            }
            return Promise.resolve();
        }
        if (state.running) return Promise.resolve();
        if (text === '\r\x01') {
            reply(BANNER);
        } else if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            reply('OK\x04\x04>');
        }
        return Promise.resolve();
    };
    return {writes, state};
};

const makeBlePeripheral = () => new MicroPythonBlePeripheral(
    makeRuntime(), 'dev', 'dev', {register: false}
);

const makeSerialPeripheral = (usbVendorId, onReset) => {
    const serial = new MicroPythonWebSerialPeripheral(makeRuntime(), 'dev', 'dev', []);
    serial._serial = {
        isConnected: () => true,
        write: () => Promise.resolve(),
        hardReset: () => {
            if (onReset) onReset();
            return Promise.resolve();
        },
        getPortInfo: () => ({usbVendorId})
    };
    return serial;
};

test('interrupts are single-byte writes and survive a swallowing except', async t => {
    const peripheral = makeBlePeripheral();
    // Two interrupts land inside the program's bare except, the third
    // one stops it: one burst has three, so one round suffices.
    const {writes, state} = wireBoard(peripheral, {swallow: 2});

    await peripheral._enterLiveMode();
    t.ok(peripheral._liveReady, 'live session established');
    t.notOk(state.running, 'program stopped');
    const interrupts = writes.filter(text => text.includes('\x03'));
    t.ok(interrupts.length >= 3, `sent ${interrupts.length} interrupts`);
    t.ok(interrupts.every(text => text === '\x03'),
        'every interrupt is its own single-byte write');
    t.notOk(writes.some(text => text.includes('\r\x03')),
        'no carriage return glued in front of an interrupt');
    t.end();
});

test('a program that never stops fails with INTERRUPT_FAILED and one actionable hint', async t => {
    const peripheral = makeBlePeripheral();
    const {writes} = wireBoard(peripheral, {swallow: Infinity});
    const started = Date.now();
    await peripheral._enqueueLive(() => peripheral._enterLiveMode());

    t.notOk(peripheral._liveReady, 'no live session');
    const probes = writes.filter(text => text === '\r\x01').length;
    t.ok(probes >= 2, `probed the raw REPL ${probes} times before giving up`);
    const hints = peripheral._runtime.events.filter(event => event.name === 'PERIPHERAL_LIVE_UNAVAILABLE');
    t.equal(hints.length, 1, 'exactly one unavailable hint');
    t.equal(hints[0].payload.reason, 'interrupt-failed', 'hint carries the interrupt-failed reason');
    t.ok(Date.now() - started < 12000 + 6000, 'gave up within the entry budget');
    t.end();
});

test('a distinct reason bypasses the unavailable throttle, recovery clears it', async t => {
    const peripheral = makeBlePeripheral();
    wireBoard(peripheral, {swallow: 0});
    peripheral._reportLiveUnavailable();
    peripheral._reportLiveUnavailable();
    peripheral._reportLiveUnavailable('interrupt-failed');
    const hints = peripheral._runtime.events.filter(event => event.name === 'PERIPHERAL_LIVE_UNAVAILABLE');
    t.equal(hints.length, 2, 'throttled repeat dropped, new reason let through');
    t.equal(hints[0].payload.reason, 'channel');
    t.equal(hints[1].payload.reason, 'interrupt-failed');

    await peripheral._enterLiveMode();
    const cleared = peripheral._runtime.events.filter(event => event.name === 'PERIPHERAL_LIVE_AVAILABLE');
    t.equal(cleared.length, 1, 'recovery withdraws the hint once');
    t.equal(peripheral._lastLiveUnavailableReason, null, 'reason forgotten for the next episode');
    t.end();
});

test('a flooding program is drained before the raw REPL is probed', async t => {
    const peripheral = makeBlePeripheral();
    const {writes, state} = wireBoard(peripheral, {swallow: 1});
    // The running program floods the console; the flood only stops
    // once the program does.
    let lastFloodIndex = -1;
    const flood = setInterval(() => {
        if (!state.running) return;
        peripheral._rxTotal += 20;
        lastFloodIndex = writes.length;
    }, 20);

    await peripheral._enterLiveMode();
    clearInterval(flood);
    t.ok(peripheral._liveReady, 'live session established');
    const probeIndex = writes.indexOf('\r\x01');
    t.ok(probeIndex > lastFloodIndex, 'probe sent only after the line went quiet');
    t.end();
});

test('the stop token leads every burst on BLE and is never sent over serial', async t => {
    const ble = makeBlePeripheral();
    const {writes: bleWrites} = wireBoard(ble, {swallow: 0});
    await ble._enterLiveMode();
    const firstInterrupt = bleWrites.findIndex(text => text.includes('\x03'));
    t.equal(bleWrites[0], STOP_TOKEN, 'token is the first write of the round');
    t.ok(firstInterrupt > 0, 'token precedes the Ctrl-C burst');
    t.equal(STOP_TOKEN.charAt(0), '\x1d', 'token is framed by group separators');

    const serial = makeSerialPeripheral(0x1a86);
    const {writes: serialWrites} = wireBoard(serial, {swallow: 0, hasBle: false});
    await serial._enterLiveMode();
    t.ok(serial._liveReady, 'serial live session established');
    t.notOk(serialWrites.includes(STOP_TOKEN), 'no token on the UART transport');
    t.end();
});

test('a connection drop during the interrupt rounds fails fast', async t => {
    const peripheral = makeBlePeripheral();
    wireBoard(peripheral, {swallow: Infinity});
    const started = Date.now();
    const entering = peripheral._enterRawRepl();
    await wait(30);
    peripheral._connectionDropped = true;
    peripheral._notifyReplWaiters();

    await t.rejects(entering, /Connection lost/, 'entry rejects with the drop');
    t.ok(Date.now() - started < 2000, 'well before the entry budget');
    t.end();
});

test('web serial falls back to a DTR/RTS reset with a Ctrl-C spray through the boot window', async t => {
    let resets = 0;
    let state = null;
    const serial = makeSerialPeripheral(0x1a86, () => {
        resets++;
        // The program restarts after the reset; the very next interrupt
        // catches it in its setup code, before the swallowing loop.
        state.running = true;
        state.swallowed = Infinity;
    });
    serial._forceStopSprayMs = 150;
    serial._forceStopSprayIntervalMs = 10;
    const wired = wireBoard(serial, {swallow: Infinity, hasBle: false});
    state = wired.state;
    const writes = wired.writes;

    await serial._enterLiveMode();
    t.ok(serial._liveReady, 'live session established through the fallback');
    t.equal(resets, 1, 'board reset exactly once');
    // The interrupt rounds never asked for a reset; the spray did.
    const sprayed = writes.filter(text => text === '\x03').length;
    t.ok(sprayed > 9, `sent ${sprayed} interrupts including the boot-window spray`);
    t.end();
});

test('web serial skips the reset fallback on native USB chips', async t => {
    let resets = 0;
    const serial = makeSerialPeripheral(0x303a, () => {
        resets++;
    });
    wireBoard(serial, {swallow: Infinity, hasBle: false});

    await t.rejects(serial._enterRawRepl(), /could not be interrupted/, 'gives up without a reset');
    t.equal(resets, 0, 'the port would not survive a reset, so none is pulsed');
    t.end();
});

test('a BLE hard reset stops the program before sending the reset command', async t => {
    const peripheral = makeBlePeripheral();
    peripheral._peripheralId = 'board-1';
    const {writes} = wireBoard(peripheral, {swallow: 0});
    peripheral._handlePostUploadReboot = () => Promise.resolve();
    peripheral._enqueueLive = () => Promise.resolve();

    t.ok(await peripheral.hardReset(), 'reset requested');
    const exitRaw = writes.indexOf('\x02');
    const resetCommand = writes.findIndex(text => text.includes('machine.reset()'));
    const lastInterrupt = writes.lastIndexOf('\x03');
    t.ok(lastInterrupt >= 0 && exitRaw > lastInterrupt && resetCommand > exitRaw,
        'interrupts, raw REPL exit and reset line are separate ordered writes');
    t.notOk(writes.some(text => text.includes('\x03') && text.length > 1),
        'no reset byte is glued behind an interrupt');
    t.end();
});
