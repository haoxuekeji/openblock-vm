const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

const Runtime = require('../../src/engine/runtime');
const ExtensionManager = require('../../src/extension-support/extension-manager');
const dispatch = require('../../src/dispatch/central-dispatch');
const BodySensing = require('../../src/extensions/scratch3_body_sensing');
const MlClassifier = require('../../src/extensions/scratch3_ml_classifier');

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

const makeFakeProvider = () => {
    const provider = {
        enableCalls: 0,
        disableCalls: 0,
        mirror: false,
        enableVideo () {
            this.enableCalls++;
            return Promise.resolve();
        },
        disableVideo () {
            this.disableCalls++;
        },
        getFrame () {
            return null;
        },
        setPreviewGhost () {}
    };
    return provider;
};

test('removeScratchExtension removes the matching toolbox category, not the last one', t => {
    const runtime = new Runtime();
    runtime._blockInfo.push({id: 'bodySensing', blocks: []});
    runtime._blockInfo.push({id: 'mlClassifier', blocks: []});
    runtime._loadedScratchExtensions.push('bodySensing', 'mlClassifier');

    runtime.removeScratchExtension('bodySensing');

    t.deepEqual(runtime._blockInfo.map(info => info.id), ['mlClassifier'],
        'only the unloaded extension category is removed');
    t.deepEqual(runtime._loadedScratchExtensions, ['mlClassifier']);

    // Removing an id that is not registered must not eat another category.
    runtime.removeScratchExtension('doesNotExist');
    t.deepEqual(runtime._blockInfo.map(info => info.id), ['mlClassifier'],
        'unknown ids leave the registry untouched');

    t.end();
});

test('unloadExtension disposes the instance and stops the camera with the last video user', async t => {
    const runtime = new Runtime();
    dispatch.setServiceSync('runtime', runtime);
    const manager = new ExtensionManager(runtime);

    await manager.loadExtensionURL('bodySensing');
    await manager.loadExtensionURL('mlClassifier');
    await tick();

    t.deepEqual(runtime._blockInfo.map(info => info.id), ['bodySensing', 'mlClassifier'],
        'both categories registered');

    const bodyService = manager._loadedExtensions.get('bodySensing');
    const mlService = manager._loadedExtensions.get('mlClassifier');
    const bodyInstance = dispatch.services[bodyService];
    const mlInstance = dispatch.services[mlService];
    t.ok(bodyInstance instanceof BodySensing, 'bodySensing instance registered');
    t.ok(mlInstance instanceof MlClassifier, 'mlClassifier instance registered');

    // Install the provider after loading so load-time videoToggle calls
    // don't pollute the counters.
    const provider = makeFakeProvider();
    runtime.ioDevices.video.setProvider(provider);

    manager.unloadExtension('bodySensing');

    t.deepEqual(runtime._blockInfo.map(info => info.id), ['mlClassifier'],
        'unloading bodySensing removes its own category');
    t.equal(bodyInstance._disposed, true, 'bodySensing instance disposed');
    t.equal(dispatch.services[bodyService], undefined, 'bodySensing service dropped');
    t.equal(provider.disableCalls, 0, 'camera stays on while mlClassifier still uses it');

    manager.unloadExtension('mlClassifier');

    t.deepEqual(runtime._blockInfo.map(info => info.id), [], 'no categories left');
    t.equal(mlInstance._disposed, true, 'mlClassifier instance disposed');
    t.equal(mlInstance._continuous, false, 'continuous classification stopped');
    t.ok(provider.disableCalls >= 1, 'camera turned off with the last video extension');

    // Re-adding after an unload must produce a fresh, working instance.
    await manager.loadExtensionURL('bodySensing');
    await tick();
    t.deepEqual(runtime._blockInfo.map(info => info.id), ['bodySensing'], 'extension can be re-added');
    const newService = manager._loadedExtensions.get('bodySensing');
    const newInstance = dispatch.services[newService];
    t.ok(newInstance instanceof BodySensing, 'fresh instance registered');
    t.notEqual(newInstance, bodyInstance, 'old disposed instance is not reused');

    manager.unloadExtension('bodySensing');
    t.end();
});

test('clearExtensions disposes every instance and turns the camera off', async t => {
    const runtime = new Runtime();
    dispatch.setServiceSync('runtime', runtime);
    const manager = new ExtensionManager(runtime);

    await manager.loadExtensionURL('bodySensing');
    await manager.loadExtensionURL('mlClassifier');
    await tick();

    const instances = Array.from(manager._loadedExtensions.values())
        .map(serviceName => dispatch.services[serviceName]);
    const provider = makeFakeProvider();
    runtime.ioDevices.video.setProvider(provider);

    manager.clearExtensions();

    t.equal(instances.length, 2);
    instances.forEach(instance => t.equal(instance._disposed, true, 'instance disposed'));
    t.deepEqual(runtime._blockInfo, [], 'block info cleared');
    t.ok(provider.disableCalls >= 1, 'camera turned off');
    t.end();
});

test('an explicit stop is not overridden by auto-enabling reporters and hats', t => {
    const fakeRuntime = {
        on () {},
        removeListener () {},
        getTargetForStage () {
            return undefined;
        },
        currentStepTime: 33,
        ioDevices: null
    };
    const ext = new BodySensing(fakeRuntime);
    ext._ensureDetector = part => {
        const detector = ext._detectors[part];
        detector.active = true;
        return Promise.resolve({});
    };

    // A hat poll (or reporter) auto-starts detection...
    ext.whenGesture({GESTURE: 'rock'});
    t.equal(ext._detectors.hands.active, true, 'hat poll auto-enables detection');

    // ...but after an explicit stop the polls must not restart it.
    ext.disableDetection({PART: 'hands'});
    t.equal(ext._detectors.hands.active, false, 'stop block deactivates detection');
    ext.whenGesture({GESTURE: 'rock'});
    ext.currentGesture();
    ext.isHandDetected();
    t.equal(ext._detectors.hands.active, false, 'polls after an explicit stop stay stopped');

    // Pose detection is independent of the hands stop.
    ext.isPoseDetected();
    t.equal(ext._detectors.pose.active, true, 'other part still auto-enables');

    // An explicit start lifts the suppression.
    ext.enableDetection({PART: 'hands'});
    t.equal(ext._detectors.hands.active, true, 'start block re-enables detection');
    t.end();
});

test('bodySensing dispose stops the loop, closes models and detaches the listener', t => {
    const listeners = [];
    const removed = [];
    const fakeRuntime = {
        on (name, fn) {
            listeners.push({name, fn});
        },
        removeListener (name, fn) {
            removed.push({name, fn});
        },
        getTargetForStage () {
            return undefined;
        },
        currentStepTime: 33,
        ioDevices: {video: {getFrame: () => null}}
    };
    const ext = new BodySensing(fakeRuntime);
    t.equal(listeners.length, 1, 'constructor registered one listener');

    let closed = 0;
    ext._detectors.hands.instance = {close: () => {
        closed++; return Promise.resolve();
    }};
    ext._detectors.hands.active = true;
    ext._handLandmarks = [{x: 0.5, y: 0.5}];

    ext.dispose();

    t.equal(ext._disposed, true);
    t.equal(ext._detectors.hands.active, false, 'detector deactivated');
    t.equal(ext._detectors.hands.instance, null, 'model instance dropped');
    t.equal(closed, 1, 'MediaPipe solution closed');
    t.equal(ext._handLandmarks, null, 'stale landmarks cleared');
    t.equal(ext._detectors.pose.active, false, 'all detectors deactivated');
    t.equal(removed.length, 1, 'listener removed');
    t.equal(removed[0].fn, listeners[0].fn, 'the registered listener is the one removed');
    t.end();
});

test('mlClassifier dispose stops continuous classification and detaches the listener', t => {
    const listeners = [];
    const removed = [];
    const fakeRuntime = {
        on (name, fn) {
            listeners.push({name, fn});
        },
        removeListener (name, fn) {
            removed.push({name, fn});
        },
        getTargetForStage () {
            return undefined;
        },
        currentStepTime: 33,
        ioDevices: {video: {getFrame: () => null}}
    };
    const ext = new MlClassifier(fakeRuntime);
    ext.startContinuous({INTERVAL: 0.5});
    t.equal(ext._continuous, true);

    ext.dispose();

    t.equal(ext._disposed, true);
    t.equal(ext._continuous, false, 'continuous loop stopped');
    t.equal(removed.length, 1, 'listener removed');
    t.equal(removed[0].fn, listeners[0].fn, 'the registered listener is the one removed');
    t.end();
});
