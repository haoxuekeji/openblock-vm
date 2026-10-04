const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const OLED_TRACEBACK = 'Traceback (most recent call last):\r\n' +
    '  File "<stdin>", line 2, in <module>\r\n' +
    'RuntimeError: OLED is not initialized. Run the OLED init block first\r\n';

const makeRuntime = events => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
        PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
        PERIPHERAL_LIVE_UNAVAILABLE: 'PERIPHERAL_LIVE_UNAVAILABLE',
        PERIPHERAL_LIVE_AVAILABLE: 'PERIPHERAL_LIVE_AVAILABLE',
        PERIPHERAL_LIVE_ERROR: 'PERIPHERAL_LIVE_ERROR'
    },
    emit (name, data) {
        events.push({name, data});
    },
    on () {},
    removeListener () {},
    registerPeripheralExtension () {},
    isRealtimeMode: () => true
});

/**
 * Build a peripheral with a live session up, wired to a fake board whose
 * stderr answer for every command is taken from `board.stderr`.
 * @return {{peripheral: MicroPythonBlePeripheral, events: Array.<object>, board: object}} -
 *   the peripheral under test, the emitted runtime events and the fake
 *   board settings.
 */
const makePeripheral = () => {
    const events = [];
    const board = {stderr: OLED_TRACEBACK, commands: []};
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(events), 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._liveReady = true;
    let pasteBuffer = null;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('utf8');
        const reply = answer => peripheral._routeIncoming(Buffer.from(answer, 'utf8'));
        if (text === '\x05A\x01') {
            pasteBuffer = '';
            reply('R\x01\x00\x08');
        } else if (pasteBuffer !== null) {
            pasteBuffer += text;
            if (pasteBuffer.endsWith('\x04')) {
                board.commands.push(pasteBuffer.slice(0, -1));
                pasteBuffer = null;
                // Raw-paste replies have no leading OK.
                reply(`\x04\x04${board.stderr}\x04>`);
            }
        } else if (text.endsWith('\x04')) {
            board.commands.push(text.slice(0, -1));
            reply(`OK\x04${board.stderr}\x04>`);
        }
        return Promise.resolve();
    };
    return {peripheral, events, board};
};

const errorsOf = events => events.filter(event => event.name === 'PERIPHERAL_LIVE_ERROR');

test('a python exception in a live block is reported to the GUI', async t => {
    const {peripheral, events} = makePeripheral();

    const output = await peripheral.execLive('_ob_oled.show()');
    t.equal(output, null, 'the block still sees null');
    const errors = errorsOf(events);
    t.equal(errors.length, 1, 'one error event');
    t.equal(errors[0].data.deviceId, 'dev');
    t.equal(errors[0].data.message, OLED_TRACEBACK, 'raw board stderr without the Board error prefix');
    t.ok(peripheral.isReady(), 'a python error leaves the live session up');
    t.equal(events.filter(event => event.name === 'PERIPHERAL_LIVE_UNAVAILABLE').length, 0,
        'no channel-down hint for a healthy protocol');
    t.end();
});

test('a failing block in a loop is reported once per throttle window', async t => {
    const {peripheral, events, board} = makePeripheral();

    await peripheral.execLive('_ob_oled.show()');
    await peripheral.execLive('_ob_oled.show()');
    await peripheral.execLive('_ob_oled.show()');
    t.equal(errorsOf(events).length, 1, 'identical errors are throttled');

    board.stderr = 'Traceback (most recent call last):\r\n' +
        'OSError: [Errno 19] ENODEV\r\n';
    await peripheral.execLive('_ob_lcd.show()');
    t.equal(errorsOf(events).length, 2, 'a different error is reported right away');

    board.stderr = OLED_TRACEBACK;
    await peripheral.execLive('_ob_oled.show()');
    t.equal(errorsOf(events).length, 3, 'switching back to the first error is reported too');
    await peripheral.execLive('_ob_oled.show()');
    t.equal(errorsOf(events).length, 3, 'its repeats are throttled again');
    peripheral._lastLiveErrorEmit -= 5000;
    await peripheral.execLive('_ob_oled.show()');
    t.equal(errorsOf(events).length, 4, 'the same error is reported again after the window');
    t.end();
});

test('quiet commands and non-realtime sessions report nothing', async t => {
    const {peripheral, events} = makePeripheral();

    const output = await peripheral.execLive('import _thread', 5000, {isReadOnly: true, quiet: true});
    t.equal(output, null, 'quiet command still resolves null');
    t.equal(errorsOf(events).length, 0, 'quiet command is not reported');

    peripheral._startLivePush(['p4.value()']);
    await peripheral._liveQueue;
    await new Promise(resolve => setImmediate(resolve));
    t.equal(errorsOf(events).length, 0, 'push sampler start failures stay internal');
    t.equal(peripheral._livePushFailures, 1, 'and count against the push failure budget');

    peripheral._lastLiveErrorMessage = null;
    peripheral._reportLiveBoardError(`Board error: ${OLED_TRACEBACK}`);
    t.equal(errorsOf(events).length, 1, 'direct report works while realtime');
    peripheral._lastLiveErrorMessage = null;
    peripheral._runtime.isRealtimeMode = () => false;
    peripheral._reportLiveBoardError(`Board error: ${OLED_TRACEBACK}`);
    t.equal(errorsOf(events).length, 1, 'nothing outside realtime mode');
    t.end();
});

test('a failing batched sensor read is reported and reads empty', async t => {
    const {peripheral, events} = makePeripheral();
    peripheral._livePushEnabled = false;
    const value = await peripheral.readLiveString('_ob_mpu.accel()');
    t.equal(value, '', 'the read degrades to an empty string');
    const errors = errorsOf(events);
    t.equal(errors.length, 1, 'the read error reaches the GUI');
    t.match(errors[0].data.message, /RuntimeError: OLED is not initialized/);
    t.end();
});
