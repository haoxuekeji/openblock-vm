/**
 * Declarative device descriptor helpers (#16).
 * Normalizes optional parentDeviceId / frameworks / typeList fields so
 * third-party device packs can declare multi-framework boards explicitly
 * instead of relying on deviceId naming heuristics.
 */

/**
 * @param {object} device - raw device index entry.
 * @return {object} shallow-cloned entry with normalized metadata.
 */
const normalizeDeviceDescriptor = device => {
    if (!device || typeof device !== 'object') {
        return device;
    }
    const next = Object.assign({}, device);
    if (Array.isArray(next.frameworks) && !next.typeList) {
        next.typeList = next.frameworks.slice();
    }
    if (Array.isArray(next.typeList) && !next.frameworks) {
        next.frameworks = next.typeList.slice();
    }
    if (next.parentDeviceId) {
        next.parentDeviceId = String(next.parentDeviceId);
    }
    return next;
};

/**
 * @param {Array.<object>} devices - raw device index.
 * @return {Array.<object>} normalized list.
 */
const normalizeDeviceDescriptors = devices => {
    if (!Array.isArray(devices)) {
        return [];
    }
    return devices.map(normalizeDeviceDescriptor);
};

module.exports = {
    normalizeDeviceDescriptor,
    normalizeDeviceDescriptors
};
