const tap = require('tap');
const VirtualMachine = require('../../src/virtual-machine');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

/**
 * Build a vm whose device loading is stubbed out.
 * @param {boolean} loadFails - whether loadDeviceURL should reject.
 * @return {VirtualMachine} the prepared vm.
 */
const makeVm = (loadFails = false) => {
    const vm = new VirtualMachine();
    vm.extensionManager.loadDeviceURL = () => {
        if (loadFails) return Promise.reject(new Error('load failed'));
        return Promise.resolve();
    };
    return vm;
};

test('installDevice restores upload mode and arms the one-shot flag', t => {
    const vm = makeVm();
    return vm.installDevice([], {deviceId: 'microPythonEsp32'}, 'upload').then(() => {
        t.equal(vm.runtime.isRealtimeMode(), false, 'upload mode restored');
        t.equal(vm.runtime.consumeProgramModeRestored(), true, 'flag armed');
        t.equal(vm.runtime.consumeProgramModeRestored(), false, 'flag is one-shot');
        t.end();
    });
});

test('installDevice restores realtime mode and arms the one-shot flag', t => {
    const vm = makeVm();
    vm.runtime.setRealtimeMode(false);
    return vm.installDevice([], {deviceId: 'microPythonEsp32'}, 'realtime').then(() => {
        t.equal(vm.runtime.isRealtimeMode(), true, 'realtime mode restored');
        t.equal(vm.runtime.consumeProgramModeRestored(), true, 'flag armed');
        t.end();
    });
});

test('installDevice without explicit mode defaults to realtime, flag stays off', t => {
    const vm = makeVm();
    vm.runtime.setRealtimeMode(false);
    return vm.installDevice([], {deviceId: 'microPythonEsp32'}).then(() => {
        t.equal(vm.runtime.isRealtimeMode(), true, 'defaults to realtime');
        t.equal(vm.runtime.consumeProgramModeRestored(), false,
            'old files keep the device defaultProgramMode behavior');
        t.end();
    });
});

test('installDevice without device does not touch mode or flag', t => {
    const vm = makeVm();
    vm.runtime.setRealtimeMode(false);
    const result = vm.installDevice([], {}, 'realtime');
    t.same(result, [], 'targets passed through');
    t.equal(vm.runtime.isRealtimeMode(), false, 'mode untouched');
    t.equal(vm.runtime.consumeProgramModeRestored(), false, 'flag untouched');
    t.end();
});

test('installDevice clears the flag when the device fails to load', t => {
    const vm = makeVm(true);
    return vm.installDevice([], {deviceId: 'microPythonEsp32'}, 'realtime')
        .then(() => t.fail('should have rejected'))
        .catch(error => {
            t.equal(error.message, 'load failed', 'error propagated');
            t.equal(vm.runtime.consumeProgramModeRestored(), false,
                'flag does not leak into the next device selection');
            t.end();
        });
});
