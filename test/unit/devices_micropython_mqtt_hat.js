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

test('MQTT realtime polling starts the external hat only after a message', async t => {
    const source = fs.readFileSync(
        '../external-resources-v3/extensions/espMqtt/runtime.js',
        'utf8'
    );
    const context = {exports: null};
    nodeVm.runInNewContext(source, context, {filename: 'espMqtt/runtime.js'});

    const calls = [];
    const startedHats = [];
    let output = '\x01>>> 0\n';
    const runtime = {
        getDevice: () => ({deviceId: 'microPythonEsp32'}),
        peripheralExtensions: {
            microPythonEsp32: {
                execLive: (code, timeout) => {
                    calls.push({code, timeout});
                    return Promise.resolve(output);
                }
            }
        },
        startHats: opcode => startedHats.push(opcode)
    };
    const primitives = context.exports(runtime);

    output = '\x01>>> 1\n';
    await primitives.espMqtt_checkMsg();
    t.same(startedHats, ['espMqtt_whenMessage']);
    t.equal(calls[0].timeout, 5000);
    t.match(calls[0].code, /_ob_mqtt\.check_msg\(\)/);
    t.match(calls[0].code, /print\(1 if _ob_mqtt_message_pending/);

    output = '\x01>>> 0\n';
    await primitives.espMqtt_checkMsg();
    t.same(startedHats, ['espMqtt_whenMessage']);
    t.end();
});
