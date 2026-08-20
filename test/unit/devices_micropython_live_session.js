const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const makeRuntime = () => ({
    constructor: {
        PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
        PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA'
    },
    emit () {},
    on () {},
    removeListener () {},
    registerPeripheralExtension () {},
    isRealtimeMode: () => true
});

/**
 * Build a live-mode peripheral wired to a fake board: every _writeRaw
 * call is handed to onWrite together with a reply(text) function that
 * feeds board bytes back into the incoming data path.
 * @param {Function} onWrite - (writtenText, reply) => void.
 * @return {{peripheral: MicroPythonBlePeripheral, writes: Array.<string>}} -
 *   the peripheral under test and the list of written raw texts.
 */
const makeLivePeripheral = onWrite => {
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(), 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    peripheral._liveReady = true;
    const writes = [];
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        writes.push(text);
        onWrite(text, reply => peripheral._routeIncoming(Buffer.from(reply, 'latin1')));
        return Promise.resolve();
    };
    return {peripheral, writes};
};

test('short live commands take the plain raw REPL', async t => {
    const {peripheral, writes} = makeLivePeripheral((text, reply) => {
        if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            reply('OK\x04\x04>');
        }
    });

    const output = await peripheral.execLive('p4.value(1)');
    t.equal(output, '', 'command executed with empty stdout');
    t.notOk(writes.some(text => text.startsWith('\x05A\x01')),
        'no raw-paste handshake for short commands');
    t.equal(writes.length, 1, 'command and EOT sent in a single write');
    t.end();
});

test('large live commands keep using raw-paste flow control', async t => {
    const bigCommand = `x = '${'a'.repeat(400)}'`;
    const {peripheral, writes} = makeLivePeripheral((text, reply) => {
        if (text === '\x05A\x01') {
            // Supported, flow control window 2048 bytes.
            reply('R\x01\x00\x08');
        } else if (text === '\x04') {
            // End-of-data ack, then empty stdout/stderr reply.
            reply('\x04');
            reply('\x04\x04>');
        }
    });

    const output = await peripheral.execLive(bigCommand);
    t.equal(output, '', 'command executed with empty stdout');
    t.ok(writes.includes('\x05A\x01'), 'raw-paste handshake sent');
    t.end();
});

test('python-level board errors do not tear down the live session', async t => {
    const {peripheral, writes} = makeLivePeripheral((text, reply) => {
        if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            reply('OK\x04NameError: name p9 is not defined\x04>');
        }
    });

    const output = await peripheral.execLive('p9.value(1)');
    t.equal(output, null, 'failed command reports null');
    t.ok(peripheral._liveReady, 'live session kept');
    t.notOk(writes.includes('\r\x03\x03'), 'no interrupt/resync sent');
    t.end();
});

test('a protocol timeout resyncs the raw REPL and retries the command once', async t => {
    let dropReplies = 1;
    const {peripheral, writes} = makeLivePeripheral((text, reply) => {
        if (text === '\r\x03\x03') return;
        if (text === '\r\x01') {
            reply('raw REPL; CTRL-B to exit\r\n>');
            return;
        }
        if (text.endsWith('\x04')) {
            if (dropReplies > 0) {
                // The board answer is lost once: the browser must not
                // stay out of sync forever afterwards.
                dropReplies--;
                return;
            }
            reply('OK\x04\x04>');
        }
    });

    const output = await peripheral.execLive('p4.value(1)', 50);
    t.equal(output, '', 'command answered by the post-resync retry');
    t.ok(writes.includes('\r\x03\x03'), 'board interrupted for resync');
    t.ok(writes.includes('\r\x01'), 'raw REPL re-entered');
    t.ok(peripheral._liveReady, 'live session usable again');
    t.equal(writes.filter(text => text === 'p4.value(1)\x04').length, 2,
        'the failed command was retried once');

    const next = await peripheral.execLive('p4.value(0)', 50);
    t.equal(next, '', 'next command works without reconnecting');
    t.end();
});

test('a desynced first command heals well below the execution timeout', async t => {
    let dropReplies = 1;
    const {peripheral} = makeLivePeripheral((text, reply) => {
        if (text === '\r\x03\x03') return;
        if (text === '\r\x01') {
            reply('raw REPL; CTRL-B to exit\r\n>');
            return;
        }
        if (text.endsWith('\x04')) {
            if (dropReplies > 0) {
                dropReplies--;
                return;
            }
            // Raw REPL reply: OK<stdout>\x04<stderr>\x04>
            reply('OK42\r\n\x04\x04>');
        }
    });

    // Default timeout (5s): the tight OK-ack timeout must detect the
    // desync early, resync and retry, answering correctly in well under
    // half the old worst case.
    const start = Date.now();
    const output = await peripheral.execLive('print(42)');
    const elapsed = Date.now() - start;
    t.equal(String(output).trim(), '42', 'retried command returned the real value');
    t.ok(elapsed < 3000, `self-healed in ${elapsed}ms (was: full 5s timeout + null)`);
    t.end();
});
