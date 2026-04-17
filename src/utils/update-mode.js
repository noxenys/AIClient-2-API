const VALID_UPDATE_MODES = new Set(['auto', 'git', 'tarball', 'image']);

export function normalizeUpdateMode(mode) {
    const normalized = String(mode || 'auto').trim().toLowerCase();
    return VALID_UPDATE_MODES.has(normalized) ? normalized : 'auto';
}

export function resolveEffectiveUpdateMode(configuredMode, isGitRepo) {
    const normalizedMode = normalizeUpdateMode(configuredMode);
    if (normalizedMode !== 'auto') {
        return normalizedMode;
    }

    return isGitRepo ? 'git' : 'image';
}

export function canPerformSelfUpdate(mode) {
    return VALID_UPDATE_MODES.has(normalizeUpdateMode(mode));
}

export function compareVersions(v1, v2) {
    const clean1 = String(v1 || '').replace(/^v/, '');
    const clean2 = String(v2 || '').replace(/^v/, '');

    const parts1 = clean1.split('.').map(Number);
    const parts2 = clean2.split('.').map(Number);
    const maxLen = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLen; i++) {
        const num1 = parts1[i] || 0;
        const num2 = parts2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }

    return 0;
}

export function sortAndFilterVersions(versions = [], limit = 10) {
    return [...new Set(
        (Array.isArray(versions) ? versions : [])
            .filter(name => /^v?\d+\.\d+/.test(String(name || '')))
    )]
        .sort((a, b) => compareVersions(b, a))
        .slice(0, limit);
}

export function findRollbackVersion(versions = [], currentVersion = '') {
    const sortedVersions = sortAndFilterVersions(versions, Array.isArray(versions) ? versions.length : 10);
    if (sortedVersions.length === 0) {
        return null;
    }

    const currentVersionIndex = sortedVersions.findIndex(version => compareVersions(version, currentVersion) === 0);
    if (currentVersionIndex >= 0) {
        return sortedVersions[currentVersionIndex + 1] || null;
    }

    return sortedVersions.find(version => compareVersions(version, currentVersion) < 0) || null;
}
