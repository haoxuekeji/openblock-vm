const tap = require('tap');

const MicroPythonBlePeripheral = require(
    '../../src/devices/common/micropython-ble-peripheral'
);

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const makeRuntime = () => {
    const events = [];
    return {
        constructor: {
            PROGRAM_MODE_UPDATE: 'PROGRAM_MODE_UPDATE',
            PERIPHERAL_RECIVE_DATA: 'PERIPHERAL_RECIVE_DATA',
            PERIPHERAL_RECONNECTING: 'PERIPHERAL_RECONNECTING',
            PERIPHERAL_CONNECTION_LOST_ERROR: 'PERIPHERAL_CONNECTION_LOST_ERROR',
            PERIPHERAL_REQUEST_ERROR: 'PERIPHERAL_REQUEST_ERROR',
            PERIPHERAL_SET_UPLOAD_ABORT_ENABLED: 'PERIPHERAL_SET_UPLOAD_ABORT_ENABLED'
        },
        events,
        emit (name, data) {
            events.push({name, data});
        },
        on () {},
        removeListener () {},
        registerPeripheralExtension () {},
        isRealtimeMode: () => false
    };
};

const makePeripheral = () => {
    const peripheral = new MicroPythonBlePeripheral(
        makeRuntime(), 'dev', 'dev', {register: false}
    );
    peripheral._peripheralId = 'board-1';
    return peripheral;
};

test('abort breaks the interrupt-and-drain wait while the board floods output', async t => {
    const peripheral = makePeripheral();
    peripheral._ble = {write: () => Promise.resolve()};
    peripheral._uploading = true;
    peripheral._abort = false;

    // Keep the drain window busy: new console bytes every 40ms would make
    // the old code sit out the full 8s drain budget.
    const flood = setInterval(() => {
        peripheral._rxTotal += 10;
    }, 40);

    const drain = peripheral._interruptAndDrain(8000);
    const started = Date.now();
    await wait(250);
    peripheral.abortUpload();

    await t.rejects(drain, /Aborted/, 'drain rejects on abort');
    clearInterval(flood);
    t.ok(Date.now() - started < 2000, 'reacted well before the drain budget');
    t.end();
});

test('abort stops a chunked write between chunks', async t => {
    const peripheral = makePeripheral();
    let writes = 0;
    peripheral._ble = {
        write: async () => {
            writes++;
            await wait(30);
        }
    };
    peripheral._uploading = true;
    peripheral._abort = false;

    const chunkSize = peripheral._bleChunkSize;
    const buffer = Buffer.alloc(chunkSize * 5, 0x41);
    const writing = peripheral._writeRaw(buffer);
    await wait(10);
    peripheral.abortUpload();

    await t.rejects(writing, /Aborted/, 'chunked write rejects on abort');
    t.ok(writes < 5, `stopped early after ${writes} chunk(s)`);
    t.end();
});

test('non-upload writes are not affected by a stale abort flag', async t => {
    const peripheral = makePeripheral();
    let writes = 0;
    peripheral._ble = {
        write: () => {
            writes++;
            return Promise.resolve();
        }
    };
    // State after an aborted upload: flag still set, upload finished.
    peripheral._uploading = false;
    peripheral._abort = true;

    await peripheral._writeRaw(Buffer.alloc(4, 0x41));
    t.equal(writes, 1, 'write went through');
    t.end();
});
