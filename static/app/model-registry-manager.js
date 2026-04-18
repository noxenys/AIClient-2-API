import { apiClient } from './auth.js';

let modelRegistryCache = null;

function normalizeRegistryPayload(payload) {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return {
            items: Array.isArray(payload.items) ? payload.items : [],
            providerModelMap: payload.providerModelMap && typeof payload.providerModelMap === 'object'
                ? payload.providerModelMap
                : {},
            providerTypes: Array.isArray(payload.providerTypes) ? payload.providerTypes : [],
            modelStatus: payload.modelStatus && typeof payload.modelStatus === 'object'
                ? payload.modelStatus
                : { providers: {} }
        };
    }

    return {
        items: [],
        providerModelMap: {},
        providerTypes: [],
        modelStatus: { providers: {} }
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

function createFallbackModelEntry(modelId) {
    return {
        id: modelId,
        displayName: modelId,
        aliases: [],
        primarySource: 'legacy'
    };
}

export async function getProviderModelEntriesMap(forceRefresh = false) {
    const registry = await fetchModelRegistry(forceRefresh);
    const itemMap = new Map((registry.items || []).map(item => [item.id, item]));
    const providerModelMap = registry.providerModelMap || {};
    const modelStatusProviders = registry.modelStatus?.providers || {};
    const entriesMap = {};

    Object.entries(providerModelMap).forEach(([providerType, modelIds]) => {
        const providerModelStatus = modelStatusProviders[providerType]?.byModel || {};
        entriesMap[providerType] = (Array.isArray(modelIds) ? modelIds : []).map(modelId => {
            const entry = itemMap.get(modelId) || createFallbackModelEntry(modelId);
            const modelStatus = providerModelStatus[entry.id]
                || providerModelStatus[entry.actualModel]
                || providerModelStatus[modelId]
                || null;

            return modelStatus
                ? { ...entry, modelStatus }
                : entry;
        });
    });

    return entriesMap;
}
