import { apiClient } from './auth.js';

let modelRegistryCache = null;

function normalizeRegistryPayload(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return {
            items: Array.isArray(payload.items) ? payload.items : [],
            providerModelMap: payload.providerModelMap && typeof payload.providerModelMap === 'object'
                ? payload.providerModelMap
                : {},
            providerTypes: Array.isArray(payload.providerTypes) ? payload.providerTypes : []
        };
    }

    return {
        items: [],
        providerModelMap: {},
        providerTypes: []
    };
}

export function invalidateModelRegistryCache() {
    modelRegistryCache = null;
}

export async function fetchModelRegistry(forceRefresh = false) {
    if (!forceRefresh && modelRegistryCache) {
        return modelRegistryCache;
    }

    try {
        const payload = await apiClient.get('/model-registry');
        modelRegistryCache = normalizeRegistryPayload(payload);
    } catch (error) {
        console.warn('[Model Registry] Falling back to legacy provider-models endpoint:', error);
        const providerModelMap = await apiClient.get('/provider-models');
        modelRegistryCache = normalizeRegistryPayload({
            items: [],
            providerModelMap,
            providerTypes: Object.keys(providerModelMap || {})
        });
    }

    return modelRegistryCache;
}

export async function getProviderModelMap(forceRefresh = false) {
    const registry = await fetchModelRegistry(forceRefresh);
    return registry.providerModelMap || {};
}

export async function getRegistryItems(forceRefresh = false) {
    const registry = await fetchModelRegistry(forceRefresh);
    return registry.items || [];
}
