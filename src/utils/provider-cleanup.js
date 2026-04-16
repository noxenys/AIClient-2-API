import fs from 'fs';
import path from 'path';

import { PROVIDER_MAPPINGS } from './provider-utils.js';

const REAUTH_FAILURE_PATTERNS = [
    /please re-authenticate/i,
    /refresh failed:\s*failed to refresh .*token/i,
    /failed to refresh .*token/i
];

function normalizePathValue(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return '';
    }

    return path.resolve(filePath).replace(/\\/g, '/').toLowerCase();
}

export function isDefinitiveCredentialFailure(errorMessage = '') {
    const message = String(errorMessage || '').trim();
    if (!message) {
        return false;
    }

    if (REAUTH_FAILURE_PATTERNS.some(pattern => pattern.test(message))) {
        return true;
    }

    // 429 可能和 401 文案共存，按用户要求优先保留 429 节点。
    if (/\b429\b/.test(message) || /rate limit|too many requests|quota/i.test(message)) {
        return false;
    }

    return /\b(401|403)\b/.test(message) ||
        /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(message);
}

export function shouldPermanentlyDeleteProvider(provider = {}) {
    return isDefinitiveCredentialFailure(provider.lastErrorMessage || '');
}

export function getCredentialPathKeysForProviderType(providerType = '') {
    return [...new Set(
        PROVIDER_MAPPINGS
            .filter(mapping => providerType === mapping.providerType || providerType.startsWith(`${mapping.providerType}-`))
            .map(mapping => mapping.credPathKey)
            .filter(key => typeof key === 'string' && key.endsWith('_PATH'))
    )];
}

export function getCredentialFilePathsForProvider(providerType = '', provider = {}) {
    return getCredentialPathKeysForProviderType(providerType)
        .map(key => provider[key])
        .filter(filePath => typeof filePath === 'string' && filePath.trim());
}

function isCredentialPathStillReferenced(providerPools = {}, globalConfig = {}, targetPath = '', removingRefs = new Set()) {
    const normalizedTargetPath = normalizePathValue(targetPath);
    if (!normalizedTargetPath) {
        return false;
    }

    for (const mapping of PROVIDER_MAPPINGS) {
        if (typeof mapping.credPathKey === 'string' && mapping.credPathKey.endsWith('_PATH')) {
            const globalPath = globalConfig[mapping.credPathKey];
            if (normalizePathValue(globalPath) === normalizedTargetPath) {
                return true;
            }
        }
    }

    for (const [providerType, providers] of Object.entries(providerPools || {})) {
        for (const provider of providers || []) {
            const refKey = `${providerType}:${provider.uuid}`;
            if (removingRefs.has(refKey)) {
                continue;
            }

            const referencedPaths = getCredentialFilePathsForProvider(providerType, provider);
            if (referencedPaths.some(filePath => normalizePathValue(filePath) === normalizedTargetPath)) {
                return true;
            }
        }
    }

    return false;
}

export function removeProvidersByPredicate(providerPools = {}, providerType = '', shouldRemove = () => false, options = {}) {
    const providers = Array.isArray(providerPools[providerType]) ? providerPools[providerType] : [];
    const globalConfig = options.globalConfig || {};
    const deletedProviders = [];
    const remainingProviders = [];

    for (const provider of providers) {
        if (shouldRemove(provider)) {
            deletedProviders.push(provider);
        } else {
            remainingProviders.push(provider);
        }
    }

    const nextProviderPools = { ...providerPools };
    if (deletedProviders.length === 0) {
        return {
            providerPools: nextProviderPools,
            deletedProviders,
            remainingProviders,
            deletedCredentialFiles: []
        };
    }

    if (remainingProviders.length === 0) {
        delete nextProviderPools[providerType];
    } else {
        nextProviderPools[providerType] = remainingProviders;
    }

    const removingRefs = new Set(
        deletedProviders.map(provider => `${providerType}:${provider.uuid}`)
    );
    const deletedCredentialFiles = [];

    for (const provider of deletedProviders) {
        for (const credentialPath of getCredentialFilePathsForProvider(providerType, provider)) {
            const resolvedPath = path.resolve(credentialPath);
            if (!fs.existsSync(resolvedPath)) {
                continue;
            }

            if (isCredentialPathStillReferenced(nextProviderPools, globalConfig, resolvedPath, removingRefs)) {
                continue;
            }

            fs.unlinkSync(resolvedPath);
            deletedCredentialFiles.push(resolvedPath);
        }
    }

    return {
        providerPools: nextProviderPools,
        deletedProviders,
        remainingProviders,
        deletedCredentialFiles
    };
}
