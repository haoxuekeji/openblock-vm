const log = require('../../util/log');

/**
 * Default CDN locations of the MediaPipe solution bundles. The npm packages
 * ship both the JS runtime and the model/wasm assets, so a single base URL is
 * enough. Deployments without internet access can mirror the packages and
 * override these via `window.OpenBlockMlConfig`.
 */
const DEFAULT_BASES = {
    hands: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240',
    pose: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404'
};

const SOLUTION_GLOBALS = {
    hands: 'Hands',
    pose: 'Pose'
};

const pendingLoads = {};

/**
 * @param {string} solution - 'hands' or 'pose'.
 * @returns {string} base url of the solution package, without trailing slash.
 */
const getBaseUrl = solution => {
    const config = (typeof window !== 'undefined' && window.OpenBlockMlConfig) || {};
    const override = config[`${solution}BaseUrl`];
    const base = typeof override === 'string' && override ? override : DEFAULT_BASES[solution];
    return base.replace(/\/+$/, '');
};

/**
 * Inject a script tag and resolve when it has loaded.
 * @param {string} src - script url.
 * @returns {Promise} resolved when loaded, rejected on error.
 */
const injectScript = src => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
    document.head.appendChild(script);
});

/**
 * Load a MediaPipe solution runtime from the CDN (once) and construct it.
 * @param {string} solution - 'hands' or 'pose'.
 * @returns {Promise.<Function>} resolves with the solution constructor.
 */
const loadSolutionConstructor = solution => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('MediaPipe solutions require a browser environment'));
    }
    const globalName = SOLUTION_GLOBALS[solution];
    if (window[globalName]) {
        return Promise.resolve(window[globalName]);
    }
    if (!pendingLoads[solution]) {
        const base = getBaseUrl(solution);
        pendingLoads[solution] = injectScript(`${base}/${solution}.js`)
            .then(() => {
                if (!window[globalName]) {
                    throw new Error(`${globalName} was not registered by ${base}/${solution}.js`);
                }
                return window[globalName];
            })
            .catch(error => {
                // Allow a retry on the next attempt instead of caching the failure.
                delete pendingLoads[solution];
                log.warn(`bodySensing: ${error.message}`);
                throw error;
            });
    }
    return pendingLoads[solution];
};

/**
 * Create a configured MediaPipe solution instance whose model/wasm assets are
 * resolved against the same base URL as the runtime script.
 * @param {string} solution - 'hands' or 'pose'.
 * @param {object} options - passed to `instance.setOptions`.
 * @returns {Promise.<object>} resolves with the running solution instance.
 */
const createSolution = (solution, options) => loadSolutionConstructor(solution)
    .then(SolutionClass => {
        const base = getBaseUrl(solution);
        const instance = new SolutionClass({
            locateFile: file => `${base}/${file}`
        });
        instance.setOptions(options);
        return instance;
    });

module.exports = {
    createSolution,
    getBaseUrl
};
