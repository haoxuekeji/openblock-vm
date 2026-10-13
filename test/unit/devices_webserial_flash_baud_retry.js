const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

global.navigator = {serial: {}};
const Peripheral = require('../../src/devices/common/micropython-webserial-peripheral');

// A fake esptool-js: main() fails with the CH340 "stream stopped" error
// above `okBelow` baud and succeeds at or below it.
const makeFakeEsptool = (okBelow, chipName = 'ESP32') => {
    const state = {bauds: [], flashed: false, disconnects: 0};
    class Transport {
        async disconnect () {
            state.disconnects++;
        }
    }
    class ESPLoader {
        constructor (o) {
            state.bauds.push(o.baudrate);
            this.chip = {CHIP_NAME: chipName};
            this._baud = o.baudrate;
        }
        async main () {
            if (this._baud > okBelow) {
                throw new Error('Unable to verify flash chip connection Error: Serial data stream stopped: ' +
                    'Possible serial noise or corruption.');
            }
        }
        async writeFlash (o) {
            o.reportProgress(0, 100, 100);
            state.flashed = true;
        }
        async after () {}
    }
    return {state, modules: {ESPLoader, Transport}};
};

const makePeripheral = modules => {
    const inst = Object.create(Peripheral.prototype);
    inst._runtime = {constructor: {}, emit () {}};
    inst._deviceOpt = {chip: 'esp32', flashAddress: '0x1000'};
    inst._abort = false;
    inst.log = [];
    inst._sendstd = m => inst.log.push(String(m).trim());
    inst._loadEsptool = async () => modules;
    return inst;
};

test('a CH340 that drops at 921600 is flashed at the first working lower baud', async t => {
    const {state, modules} = makeFakeEsptool(230400);
    const inst = makePeripheral(modules);
    await inst._flashWithEsptool({}, new Uint8Array(8));
    t.same(state.bauds, [921600, 460800, 230400], 'one attempt per baud until it works');
    t.ok(state.flashed, 'firmware written');
    t.equal(state.disconnects, 3, 'the port is closed after every attempt');
    t.ok(inst.log.some(l => /Retrying at 460800/.test(l)), 'retry announced in the console');
    t.end();
});

test('115200 (ROM baud) is the last resort and its failure propagates', async t => {
    const {state, modules} = makeFakeEsptool(0);
    const inst = makePeripheral(modules);
    await t.rejects(inst._flashWithEsptool({}, new Uint8Array(8)), /Serial data stream stopped/);
    t.same(state.bauds, [921600, 460800, 230400, 115200]);
    t.notOk(state.flashed);
    t.end();
});

test('a chip mismatch is not retried', async t => {
    const {state, modules} = makeFakeEsptool(1e9, 'ESP32-C3');
    const inst = makePeripheral(modules);
    await t.rejects(inst._flashWithEsptool({}, new Uint8Array(8)), /expects esp32/);
    t.equal(state.bauds.length, 1);
    t.end();
});
