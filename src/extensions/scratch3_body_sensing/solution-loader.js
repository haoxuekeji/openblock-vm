const log = require('../../util/log');

/**
 * Default CDN locations of the MediaPipe solution bundles. The npm packages
 * ship both the JS runtime and the model/wasm assets, so a single base URL is
 * enough. Deployments can mirror the packages next to the GUI and point at
 * them via `window.OpenBlockMlConfig` (see getBaseUrls); the CDN then only
 * remains as a fallback for setups without a local mirror.
 */
const DEFAULT_BASES = {
    hands: 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240',
    pose: 'https://cdn.jsdelivr.net/npm/@mediapipe/pose@0.5.1675469404'
};

const SOLUTION_GLOBALS = {
    hands: 'Hands',
    pose: 'Pose'
};

/**
 * Give up on a base after this long. On networks where the CDN is blocked
 * the connection often hangs instead of failing, which used to stall the
 * whole load for minutes; a bounded wait lets the next base take over.
 * @type {number}
 */
const SCRIPT_LOAD_TIMEOUT = 15 * 1000;

const pendingLoads = {};

/**
 * Base url that actually served a solution's runtime script. The model and
 * wasm assets must be resolved against the same base, so this is recorded
 * when the script load succeeds.
 */
const loadedBases = {};

/**
 * Candidate base urls for a solution, most preferred first: the deployment
 * override (usually a same-origin mirror, reliable wherever the page itself
 * loads) and then the public CDN.
 * @param {string} solution - 'hands' or 'pose'.
 * @returns {Array.<string>} base urls without trailing slash.
 */
const getBaseUrls = solution => {
    const config = (typeof window !== 'undefined' && window.OpenBlockMlConfig) || {};
    const override = config[`${solution}BaseUrl`];
    const bases = [];
    if (typeof override === 'string' && override) {
        bases.push(override);
    }
    if (DEFAULT_BASES[solution] && bases.indexOf(DEFAULT_BASES[solution]) === -1) {
        bases.push(DEFAULT_BASES[solution]);
    }
    return bases.map(base => base.replace(/\/+$/, ''));
};

/**
 * Inject a script tag and resolve when it has loaded.
 * @param {string} src - script url.
 * @returns {Promise} resolved when loaded, rejected on error or timeout.
 */
const injectScript = src => new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    let timer = null;
    const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
            if (script.parentNode) script.parentNode.removeChild(script);
            reject(error);
        } else {
            resolve();
        }
    };
    script.src = src;
    script.crossOrigin = 'anonymous';
    script.onload = () => finish(null);
    script.onerror = () => finish(new Error(`Failed to load script: ${src}`));
    timer = setTimeout(() => finish(new Error(`Timed out loading script: ${src}`)), SCRIPT_LOAD_TIMEOUT);
    document.head.appendChild(script);
});

/**
 * Load a MediaPipe solution runtime (once), trying each base url in order,
 * and remember which base served it.
 * @param {string} solution - 'hands' or 'pose'.
 * @returns {Promise.<{ctor: Function, base: string}>} resolves with the
 * solution constructor and the base url its assets must be fetched from.
 */
const loadSolutionConstructor = solution => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('MediaPipe solutions require a browser environment'));
    }
    const globalName = SOLUTION_GLOBALS[solution];
    if (window[globalName]) {
        return Promise.resolve({
            ctor: window[globalName],
            base: loadedBases[solution] || getBaseUrls(solution)[0]
        });
    }
    if (!pendingLoads[solution]) {
        const bases = getBaseUrls(solution);
        let chain = Promise.reject(new Error(`No base urls configured for ${solution}`));
        bases.forEach(base => {
            chain = chain.catch(previousError => {
                if (previousError && previousError.message.indexOf('No base urls') === -1) {
                    log.warn(`bodySensing: ${previousError.message}; trying next source`);
                }
                return injectScript(`${base}/${solution}.js`).then(() => {
                    if (!window[globalName]) {
                        throw new Error(`${globalName} was not registered by ${base}/${solution}.js`);
                    }
                    loadedBases[solution] = base;
                    return {ctor: window[globalName], base};
                });
            });
        });
        pendingLoads[solution] = chain.catch(error => {
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
 * resolved against the same base URL that served the runtime script.
 * @param {string} solution - 'hands' or 'pose'.
 * @param {object} options - passed to `instance.setOptions`.
 * @returns {Promise.<object>} resolves with the running solution instance.
 */
const createSolution = (solution, options) => loadSolutionConstructor(solution)
    .then(({ctor: SolutionClass, base}) => {
        const instance = new SolutionClass({
            locateFile: file => `${base}/${file}`
        });
        instance.setOptions(options);
        return instance;
    });

module.exports = {
    createSolution,
    getBaseUrls
};
