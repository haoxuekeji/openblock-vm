const tap = require('tap');

tap.tearDown(() => process.nextTick(process.exit));

const test = tap.test;

// Browser shims must exist before the loader is exercised. Scripts appended
// to the fake head are resolved asynchronously by the handler installed per
// test through `global.__scriptHandler`.
global.window = {};
global.document = {
    createElement: () => ({}),
    head: {
        appendChild (script) {
            setTimeout(() => global.__scriptHandler(script), 0);
        }
    }
};

const {createSolution, getBaseUrls} = require('../../src/extensions/scratch3_body_sensing/solution-loader');

const CDN_HANDS = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240';

test('getBaseUrls puts the deployment mirror first and keeps the CDN as fallback', t => {
    global.window.OpenBlockMlConfig = {handsBaseUrl: 'https://mirror.example.com/mp/hands/'};
    t.deepEqual(getBaseUrls('hands'), ['https://mirror.example.com/mp/hands', CDN_HANDS],
        'override first (trailing slash stripped), CDN second');

    delete global.window.OpenBlockMlConfig;
    t.deepEqual(getBaseUrls('hands'), [CDN_HANDS], 'without an override only the CDN remains');
    t.end();
});

test('a broken mirror falls back to the CDN and assets follow the winning base', t => {
    global.window.OpenBlockMlConfig = {handsBaseUrl: 'https://mirror.example.com/mp/hands'};

    class FakeHands {
        constructor (config) {
            this.config = config;
        }
        setOptions (options) {
            this.options = options;
        }
    }

    global.__scriptHandler = script => {
        if (script.src.indexOf('mirror.example.com') !== -1) {
            script.onerror();
        } else if (script.src.indexOf('cdn.jsdelivr.net') !== -1) {
            global.window.Hands = FakeHands;
            script.onload();
        }
    };

    return createSolution('hands', {maxNumHands: 1}).then(instance => {
        t.ok(instance instanceof FakeHands, 'constructed from the fallback source');
        t.equal(instance.config.locateFile('hand_landmark_lite.tflite'),
            `${CDN_HANDS}/hand_landmark_lite.tflite`,
            'model assets resolve against the base that actually served the script');
        t.deepEqual(instance.options, {maxNumHands: 1}, 'options forwarded');
        t.end();
    });
});

test('a healthy mirror wins and assets stay on the mirror', t => {
    global.window.OpenBlockMlConfig = {poseBaseUrl: 'https://mirror.example.com/mp/pose'};

    class FakePose {
        constructor (config) {
            this.config = config;
        }
        setOptions (options) {
            this.options = options;
        }
    }

    global.__scriptHandler = script => {
        if (script.src.indexOf('mirror.example.com') === -1) {
            script.onerror();
        } else {
            global.window.Pose = FakePose;
            script.onload();
        }
    };

    return createSolution('pose', {modelComplexity: 0}).then(instance => {
        t.ok(instance instanceof FakePose, 'constructed from the mirror');
        t.equal(instance.config.locateFile('pose_landmark_lite.tflite'),
            'https://mirror.example.com/mp/pose/pose_landmark_lite.tflite',
            'model assets resolve against the mirror');
        t.end();
    });
});

test('when every source fails the loader rejects but allows a later retry', t => {
    delete global.window.OpenBlockMlConfig;
    delete global.window.Hands;

    let attempts = 0;
    global.__scriptHandler = script => {
        attempts++;
        script.onerror();
    };

    // hands was loaded by an earlier test; use a clean copy of the module.
    delete require.cache[require.resolve('../../src/extensions/scratch3_body_sensing/solution-loader')];
    // eslint-disable-next-line global-require
    const fresh = require('../../src/extensions/scratch3_body_sensing/solution-loader');

    return fresh.createSolution('hands', {}).then(
        () => {
            t.fail('should have rejected');
            t.end();
        },
        error => {
            t.ok(/Failed to load script/.test(error.message), `rejects with a load error: ${error.message}`);
            t.equal(attempts, 1, 'only the CDN was tried (no override configured)');

            // A later attempt must be able to try again (failure not cached).
            class FakeHands {
                setOptions () {}
            }
            global.__scriptHandler = script => {
                global.window.Hands = FakeHands;
                script.onload();
            };
            return fresh.createSolution('hands', {}).then(instance => {
                t.ok(instance instanceof FakeHands, 'retry succeeds after transient failure');
                t.end();
            });
        }
    );
});
