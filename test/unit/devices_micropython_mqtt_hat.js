const tap = require('tap');
const fs = require('fs');
const nodeVm = require('vm');

const VirtualMachine = require('../../src/virtual-machine');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

test('device extension realtime hats register and unload cleanly', t => {
    const vm = new VirtualMachine();
    const primitive = () => 42;
    const realtimeRegistration = {
        espMqtt_checkMsg: primitive
    };
    Object.defineProperty(realtimeRegistration, 'hats', {
        value: {
            espMqtt_whenMessage: {
                edgeActivated: false,
                restartExistingThreads: true
            }
        },
        enumerable: false
    });

    vm.runtime.addDeviceExtension(
        'espMqtt', '<category id="espMqtt"/>', null, [], realtimeRegistration,
        ['realtime', 'upload']
    );

    t.equal(vm.runtime.getOpcodeFunction('espMqtt_checkMsg'), primitive);
    t.ok(vm.runtime.getIsHat('espMqtt_whenMessage'));
    t.notOk(vm.runtime.getIsEdgeActivatedHat('espMqtt_whenMessage'));

    vm.runtime.removeDeviceExtension('espMqtt');
    t.notOk(vm.runtime.getOpcodeFunction('espMqtt_checkMsg'));
    t.notOk(vm.runtime.getIsHat('espMqtt_whenMessage'));
    t.end();
});

/**
 * Load the MQTT extension runtime against a fake board. The board answers
 * the hat's poll command with its message count (-1 without a connected
 * client) and every other command with board.reply.
 * @return {object} - primitives, board state, recorded commands and a
 *   clock to move the sandbox time.
 */
const loadMqttRuntime = () => {
    const source = fs.readFileSync(
        '../external-resources-v3/extensions/espMqtt/runtime.js',
        'utf8'
    );
    const clock = {now: 10000};
    const context = {exports: null, Date: {now: () => clock.now}};
    nodeVm.runInNewContext(source, context, {filename: 'espMqtt/runtime.js'});

    const board = {connected: false, seq: 0, reply: ''};
    const calls = [];
    const runtime = {
        getDevice: () => ({deviceId: 'microPythonEsp32'}),
        peripheralExtensions: {
            microPythonEsp32: {
                execLive: (code, timeout, options) => {
                    calls.push({code, timeout, options});
                    if (code.indexOf('_ob_mqtt.check_msg()') !== -1 && code.indexOf('else -1') !== -1) {
                        return Promise.resolve(`${board.connected ? board.seq : -1}\r\n`);
                    }
                    return Promise.resolve(board.reply);
                }
            }
        }
    };
    return {primitives: context.exports(runtime), board, calls, clock};
};

const flush = () => new Promise(resolve => setImmediate(resolve));

const hatUtil = topBlock => ({thread: {topBlock, target: {id: 'stage'}}});

test('MQTT message hat is edge-activated and polls the board itself in realtime', t => {
    const {primitives} = loadMqttRuntime();
    t.same(primitives.hats.espMqtt_whenMessage, {edgeActivated: true, restartExistingThreads: false});
    t.notOk(Object.keys(primitives).includes('hats'), 'hat metadata is not a primitive');
    t.equal(typeof primitives.espMqtt_whenMessage, 'function');
    t.end();
});

test('MQTT message hat fires once per new message', async t => {
    const {primitives, board, calls, clock} = loadMqttRuntime();
    const when = primitives.espMqtt_whenMessage;
    const util = hatUtil('hat1');

    t.equal(when({}, util), false, 'first evaluation only registers the hat');
    await flush();
    const polls = calls.filter(call => call.options && call.options.isReadOnly);
    t.equal(polls.length, 1, 'background poll started');
    t.ok(Buffer.byteLength(polls[0].code) <= 256, 'poll fits a single raw REPL round trip');
    t.notMatch(polls[0].code, /raise/, 'the poll never raises on the board');

    clock.now += 500;
    when({}, util);
    await flush();
    t.equal(calls.length, 1, 'no client yet: polled lazily');

    board.connected = true;
    board.reply = '0\r\n';
    await primitives.espMqtt_connect({HOST: 'broker.emqx.io', PORT: 1883});
    t.match(calls[1].code, /_ob_mqtt = MQTTClient\(/);
    t.notMatch(calls[1].code, /_ob_mqtt = MQTTClient\([^\n]*keepalive/,
        'no keepalive: a listening-only client is not dropped');
    t.match(calls[1].code, /_ob_mqtt_seq \+= 1/, 'the callback counts messages');

    board.seq = 1;
    clock.now += 400;
    t.equal(when({}, util), false, 'poll for the new message in flight');
    await flush();
    t.equal(when({}, util), true, 'fires for the message');
    t.equal(when({}, util), false, 'falls back right after firing');
    clock.now += 400;
    t.equal(when({}, util), false, 'nothing new');
    await flush();
    t.equal(when({}, util), false, 'still nothing new');

    board.seq = 3;
    clock.now += 400;
    when({}, util);
    await flush();
    t.equal(when({}, util), true, 'two messages since the last poll fire once');
    t.end();
});

test('every message hat fires, and a board restart does not replay old messages', async t => {
    const {primitives, board, clock} = loadMqttRuntime();
    const when = primitives.espMqtt_whenMessage;
    board.connected = true;
    board.seq = 7;

    when({}, hatUtil('hatA'));
    when({}, hatUtil('hatB'));
    await flush();
    t.equal(when({}, hatUtil('hatA')), false, 'messages from before the editor saw the board do not fire');
    t.equal(when({}, hatUtil('hatB')), false);

    board.seq = 8;
    clock.now += 400;
    when({}, hatUtil('hatA'));
    await flush();
    t.equal(when({}, hatUtil('hatA')), true, 'first hat fires');
    t.equal(when({}, hatUtil('hatB')), true, 'second hat fires for the same message');

    board.seq = 0;
    clock.now += 400;
    when({}, hatUtil('hatA'));
    await flush();
    when({}, hatUtil('hatA'));
    t.equal(when({}, hatUtil('hatA')), false, 'restarted counter re-baselines');
    board.seq = 1;
    clock.now += 400;
    when({}, hatUtil('hatA'));
    await flush();
    t.equal(when({}, hatUtil('hatA')), true, 'first message after the restart fires');
    t.end();
});

test('the explicit check block feeds the message hat', async t => {
    const {primitives, board, calls} = loadMqttRuntime();
    const when = primitives.espMqtt_whenMessage;
    board.connected = true;
    board.seq = 2;
    when({}, hatUtil('hat1'));
    await flush();

    board.reply = '\x01>>> 3\n';
    await primitives.espMqtt_checkMsg();
    const check = calls[calls.length - 1];
    t.equal(check.timeout, 5000);
    t.match(check.code, /_ob_mqtt\.check_msg\(\)/);
    t.match(check.code, /MQTT is not connected/, 'an explicit check before connect still reports it');
    t.equal(when({}, hatUtil('hat1')), true, 'hat fires for the message the check block received');
    t.end();
});
