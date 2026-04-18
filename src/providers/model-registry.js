import {
    PROVIDER_MODELS,
    customModelMatchesProvider,
    getConfiguredSupportedModels,
    getCustomModelActualProvider,
    getCustomModelListProvider,
    normalizeModelIds,
    usesManagedModelList
} from './provider-models.js';

const SOURCE_PRIORITY = {
    builtin: 1,
    managed: 2,
    custom: 3
};

const DISPLAY_TOKEN_MAP = {
    gpt: 'GPT',
    grok: 'Grok',
    gemini: 'Gemini',
    claude: 'Claude',
    codex: 'Codex',
    qwen: 'Qwen',
    kimi: 'Kimi',
    glm: 'GLM',
    iflow: 'iFlow',
    deepseek: 'DeepSeek',
    minimax: 'MiniMax',
    auto: 'Auto',
    fast: 'Fast',
    heavy: 'Heavy',
    expert: 'Expert',
    mini: 'Mini',
    flash: 'Flash',
    lite: 'Lite',
    thinking: 'Thinking',
    imagine: 'Imagine',
    image: 'Image',
    edit: 'Edit',
    responses: 'Responses',
    oauth: 'OAuth'
};

const DISPLAY_HYPHEN_PREFIXES = new Set(['gpt', 'glm']);

export function formatModelDisplayName(modelId = '') {
    const normalizedId = String(modelId || '').trim();
    if (!normalizedId) {
        return '';
    }

    const rawTokens = normalizedId.split('-').filter(Boolean);
    const formattedTokens = rawTokens.map(token => {
            if (DISPLAY_TOKEN_MAP[token]) {
                return DISPLAY_TOKEN_MAP[token];
            }

            if (/^\d+(\.\d+)*$/.test(token)) {
                return token;
            }

            if (/^[a-z]\d+$/i.test(token)) {
                return token.charAt(0).toUpperCase() + token.slice(1);
            }

            return token.charAt(0).toUpperCase() + token.slice(1);
        });

    if (
        rawTokens.length >= 2 &&
        DISPLAY_HYPHEN_PREFIXES.has(rawTokens[0]) &&
        /^\d+(\.\d+)*$/.test(rawTokens[1])
    ) {
        formattedTokens.splice(0, 2, `${formattedTokens[0]}-${formattedTokens[1]}`);
    }

    return formattedTokens.join(' ');
}

function resolveBuiltinModels(providerType, builtinProviderModels = PROVIDER_MODELS) {
    if (builtinProviderModels[providerType]) {
        return normalizeModelIds(builtinProviderModels[providerType]);
    }

    for (const key of Object.keys(builtinProviderModels)) {
        if (providerType.startsWith(key + '-')) {
            return normalizeModelIds(builtinProviderModels[key]);
        }
    }

    return [];
}

function normalizeAliases(aliasValue) {
    if (Array.isArray(aliasValue)) {
        return normalizeModelIds(aliasValue);
    }

    if (typeof aliasValue === 'string' && aliasValue.trim()) {
        return [aliasValue.trim()];
    }

    return [];
}

function sortUnique(values = []) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getPrimarySource(sources = []) {
    const normalizedSources = Array.isArray(sources) ? sources : [];
    return normalizedSources.reduce((best, current) => {
        if (!best) {
            return current;
        }
        return SOURCE_PRIORITY[current] > SOURCE_PRIORITY[best] ? current : best;
    }, '');
}

function addContribution(registryMap, modelId, {
    source,
    providerType,
    listProviderType = null,
    aliases = [],
    displayName = '',
    actualProvider = '',
    actualModel = ''
}) {
    if (!modelId) {
        return;
    }

    const normalizedId = String(modelId).trim();
    if (!normalizedId) {
        return;
    }

    const entry = registryMap.get(normalizedId) || {
        id: normalizedId,
        displayName: formatModelDisplayName(normalizedId),
        aliases: [],
        providerTypes: [],
        listProviderTypes: [],
        sources: [],
        primarySource: '',
        actualProvider: '',
        actualModel: ''
    };

    entry.aliases = sortUnique([...entry.aliases, ...normalizeAliases(aliases)]);
    entry.providerTypes = sortUnique([...entry.providerTypes, providerType]);
    if (listProviderType) {
        entry.listProviderTypes = sortUnique([...entry.listProviderTypes, listProviderType]);
    }
    entry.sources = sortUnique([...entry.sources, source]);
    entry.primarySource = getPrimarySource(entry.sources);
    if (displayName && source === 'custom') {
        entry.displayName = displayName;
    } else if (!entry.displayName) {
        entry.displayName = formatModelDisplayName(normalizedId);
    }

    if (source === 'custom') {
        entry.actualProvider = actualProvider || entry.actualProvider || '';
        entry.actualModel = actualModel || normalizedId;
    } else if (!entry.actualModel) {
        entry.actualModel = normalizedId;
    }

    registryMap.set(normalizedId, entry);
}

function getEffectiveProviderModels(providerType, {
    builtinProviderModels = PROVIDER_MODELS,
    providerPools = {},
    customModels = []
} = {}) {
    const builtinModels = resolveBuiltinModels(providerType, builtinProviderModels);
    const providers = providerPools[providerType] || [];
    const managedModels = normalizeModelIds(
        providers.flatMap(provider => getConfiguredSupportedModels(providerType, provider))
    );
    const effectiveBaseModels = managedModels.length > 0 ? managedModels : builtinModels;
    const customModelIds = normalizeModelIds(
        customModels
            .filter(model => customModelMatchesProvider(model, providerType))
            .map(model => model.id)
    );

    return {
        builtinModels,
        managedModels,
        effectiveModels: normalizeModelIds([...effectiveBaseModels, ...customModelIds])
    };
}

export function buildModelRegistry({
    providerTypes = [],
    builtinProviderModels = PROVIDER_MODELS,
    providerPools = {},
    customModels = []
} = {}) {
    const normalizedProviderTypes = sortUnique([
        ...providerTypes,
        ...Object.keys(providerPools || {})
    ]);
    const registryMap = new Map();

    normalizedProviderTypes.forEach(providerType => {
        const {
            builtinModels,
            managedModels,
            effectiveModels
        } = getEffectiveProviderModels(providerType, {
            builtinProviderModels,
            providerPools,
            customModels
        });

        const hiddenBuiltinModels = usesManagedModelList(providerType) && managedModels.length > 0
            ? builtinModels.filter(modelId => !managedModels.includes(modelId))
            : [];
        const managedOnlyModels = managedModels.filter(modelId => !builtinModels.includes(modelId));

        builtinModels.forEach(modelId => {
            addContribution(registryMap, modelId, {
                source: managedModels.length > 0 && managedModels.includes(modelId) ? 'managed' : 'builtin',
                providerType,
                listProviderType: effectiveModels.includes(modelId) ? providerType : null
            });
        });

        managedOnlyModels.forEach(modelId => {
            addContribution(registryMap, modelId, {
                source: 'managed',
                providerType,
                listProviderType: providerType
            });
        });

        hiddenBuiltinModels.forEach(modelId => {
            addContribution(registryMap, modelId, {
                source: 'builtin',
                providerType
            });
        });
    });

    (Array.isArray(customModels) ? customModels : []).forEach(model => {
        const matchingProviderTypes = normalizedProviderTypes.filter(providerType => customModelMatchesProvider(model, providerType));
        const listProviderTypes = matchingProviderTypes.length > 0
            ? matchingProviderTypes
            : [getCustomModelListProvider(model) || 'custom-auto'];

        listProviderTypes.forEach(providerType => {
            addContribution(registryMap, model.id, {
                source: 'custom',
                providerType,
                listProviderType: providerType,
                aliases: model.alias,
                displayName: model.name,
                actualProvider: getCustomModelActualProvider(model),
                actualModel: model.actualModel || model.id
            });
        });
    });

    return [...registryMap.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function buildProviderModelMap(registry = []) {
    const providerModelMap = {};

    (Array.isArray(registry) ? registry : []).forEach(entry => {
        (entry.listProviderTypes || []).forEach(providerType => {
            if (!providerModelMap[providerType]) {
                providerModelMap[providerType] = [];
            }

            if (!providerModelMap[providerType].includes(entry.id)) {
                providerModelMap[providerType].push(entry.id);
            }
        });
    });

    Object.keys(providerModelMap).forEach(providerType => {
        providerModelMap[providerType] = normalizeModelIds(providerModelMap[providerType]);
    });

    return providerModelMap;
}

export function buildModelRegistryPayload(options = {}) {
    const items = buildModelRegistry(options);
    const providerModelMap = buildProviderModelMap(items);
    return {
        items,
        providerModelMap,
        providerTypes: sortUnique(Object.keys(providerModelMap))
    };
}
