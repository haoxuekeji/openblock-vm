const Buffer = require('buffer').Buffer;
const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const makePeripheral = () => {
    const received = [];
    const runtime = {
        constructor: {
            PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
            PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA'
        },
        emit (name, data) {
            if (name === 'PERIPHERAL_RECIVE_DATA') received.push(data);
        },
        on () {},
        removeListener () {},
        registerPeripheralExtension () {},
        isRealtimeMode: () => true
    };
    const peripheral = new MicroPythonBlePeripheral(
        runtime, 'dev', 'dev', {register: false}
    );
    peripheral.isConnected = () => true;
    return {peripheral, received};
};

test('a burst of tiny packets is delivered as one aggregated event', async t => {
    const {peripheral, received} = makePeripheral();

    for (let i = 0; i < 100; i++) {
        peripheral._routeIncoming(Buffer.from(`${i};`, 'latin1'));
    }
    t.equal(received.length, 0, 'nothing emitted synchronously');

    await wait(60);
    t.equal(received.length, 1, 'one aggregated emission');
    const expected = Array.from({length: 100}, (v, i) => `${i};`).join('');
    t.equal(received[0].toString('latin1'), expected, 'no bytes lost, order kept');
    t.end();
});

test('hitting the byte limit flushes ahead of the timer', t => {
    const {peripheral, received} = makePeripheral();

    const big = Buffer.alloc(3000, 0x41);
    peripheral._routeIncoming(big);
    t.equal(received.length, 0, 'below the limit, still buffered');
    peripheral._routeIncoming(big);
    t.equal(received.length, 1, 'limit reached, flushed immediately');
    t.equal(received[0].length, 6000, 'both chunks in the flush');
    t.end();
});

test('captured REPL traffic bypasses the console buffer', async t => {
    const {peripheral, received} = makePeripheral();

    peripheral._replCaptureDepth = 1;
    peripheral._routeIncoming(Buffer.from('OK\x04\x04>', 'latin1'));
    await wait(40);
    t.equal(received.length, 0, 'no console emission for captured bytes');
    t.equal(peripheral._replBuffer, 'OK\x04\x04>', 'bytes went to the REPL buffer');
    t.end();
});

test('disconnect flushes the pending tail instead of dropping it', t => {
    const {peripheral, received} = makePeripheral();

    peripheral._routeIncoming(Buffer.from('tail', 'latin1'));
    t.equal(received.length, 0, 'buffered');
    peripheral.reset();
    t.equal(received.length, 1, 'flushed on reset');
    t.equal(received[0].toString('latin1'), 'tail', 'tail bytes delivered');
    t.end();
});

test('console print output keeps its place in the aggregated stream', async t => {
    const {peripheral, received} = makePeripheral();
    peripheral._liveReady = true;
    peripheral._writeRaw = buffer => {
        const text = buffer.toString('latin1');
        if (text.endsWith('\x04') && !text.startsWith('\x05')) {
            peripheral._routeIncoming(Buffer.from('OKhello\r\n\x04\x04>', 'latin1'));
        }
        return Promise.resolve();
    };

    peripheral._bufferConsoleData(Buffer.from('before ', 'latin1'));
    await peripheral.consolePrint('hello', 'warp');
    await wait(60);
    const all = received.map(chunk => chunk.toString('latin1')).join('');
    t.equal(all, 'before hello\r\n', 'earlier bytes not overtaken by the print output');
    t.end();
});
