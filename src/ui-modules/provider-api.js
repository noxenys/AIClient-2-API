import { existsSync, readFileSync, writeFileSync } from 'fs';
import logger from '../utils/logger.js';
import { getRequestBody } from '../utils/common.js';
import {
    getConfiguredSupportedModels,
    getProviderModels,
    normalizeModelIds,
    usesManagedModelList
} from '../providers/provider-models.js';
import {
    buildModelRegistryPayload
} from '../providers/model-registry.js';
import {
    detectAvailableModelsForProvider,
    inferSupportedModelsFromProviderConfig
} from '../providers/provider-detection.js';
import {
    PROVIDER_MAPPINGS,
    generateUUID,
    createProviderConfig,
    formatSystemPath,
    detectProviderFromPath,
    addToUsedPaths,
    isPathUsed,
    pathsEqual
} from '../utils/provider-utils.js';
import { removeProvidersByPredicate, shouldPermanentlyDeleteProvider } from '../utils/provider-cleanup.js';
import { inferProviderStateFromConfig, isProviderStateSelectable } from '../utils/provider-state.js';
import { broadcastEvent } from './event-broadcast.js';
import { getRegisteredProviders, invalidateServiceAdapter } from '../providers/adapter.js';

const BLOCKED_SELECTION_SCORE = 1e18;
const DEFAULT_BATCH_IMPORT_MODE = 'append';
const DEFAULT_BATCH_DEDUPE_STRATEGY = 'smart';

const NON_SENSITIVE_FIELDS = new Set([
    'uuid',
    'customName',
    'isHealthy',
    'isDisabled',
    'needsRefresh',
    'state',
    'stateScore',
    'schedulerScore',
    'schedulerRank',
    'selectableRank',
    'recentFailureType',
    'recentHttpStatus'
]);

const PROVIDER_IDENTITY_KEYS = {
    'openai-custom': ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    'openaiResponses-custom': ['OPENAI_BASE_URL', 'OPENAI_API_KEY'],
    'claude-custom': ['CLAUDE_BASE_URL', 'CLAUDE_API_KEY'],
    'forward-api': ['FORWARD_BASE_URL', 'FORWARD_API_KEY']
};

function parseBooleanQuery(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    if (value === true || value === 'true' || value === '1') {
        return true;
    }

    if (value === false || value === 'false' || value === '0') {
        return false;
    }

    return null;
}

function parseCsvParam(value) {
    return String(value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

function normalizeSortOrder(order = 'asc') {
    return String(order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
}

function extractRecentHttpStatus(message = '') {
    const match = String(message || '').match(/\b(401|403|429|500|502|503|504)\b/);
    return match ? Number(match[1]) : null;
}

function getProviderCredentialKeys(providerType = '') {
    const mapping = PROVIDER_MAPPINGS.find(item => item.providerType === providerType);
    if (mapping?.credPathKey) {
        return [mapping.credPathKey];
    }

    return PROVIDER_IDENTITY_KEYS[providerType] || [];
}

function buildProviderIdentityFingerprint(providerType, provider = {}) {
    const keys = getProviderCredentialKeys(providerType);
    const parts = keys
        .map(key => {
            const value = provider[key];
            if (typeof value === 'string' && value.trim()) {
                return `${key}:${value.trim()}`;
            }
            return null;
        })
        .filter(Boolean);

    if (parts.length > 0) {
        return `${providerType}|${parts.join('|')}`;
    }

    const fallbackFields = ['OPENAI_BASE_URL', 'CLAUDE_BASE_URL', 'FORWARD_BASE_URL', 'customName'];
    const fallbackParts = fallbackFields
        .map(key => {
            const value = provider[key];
            if (typeof value === 'string' && value.trim()) {
                return `${key}:${value.trim()}`;
            }
            return null;
        })
        .filter(Boolean);

    return fallbackParts.length > 0 ? `${providerType}|${fallbackParts.join('|')}` : null;
}

function formatSchedulerPenaltyText(penaltyBreakdown = []) {
    return penaltyBreakdown.map(item => `${item.label}: ${item.value}`).join(' | ');
}

function deriveSchedulerDecisionReason(provider = {}) {
    const reason = provider.schedulerDecisionReason || provider.lastStateReason || provider.lastErrorMessage;
    if (reason) {
        return String(reason);
    }

    if (provider.isSelectionCandidate) {
        return provider.isPrimaryCandidate ? 'current top selectable node' : 'eligible but ranked behind other nodes';
    }

    if (provider.isDisabled) {
        return 'disabled by user';
    }

    if (provider.needsRefresh) {
        return 'waiting refresh before reuse';
    }

    return 'state not selectable';
}

function getProviderRecoveryTime(provider = {}) {
    return provider.recoveryTime || provider.scheduledRecoveryTime || provider.cooldownUntil || null;
}

function getCooldownRemainingMs(provider = {}) {
    const recoveryTime = getProviderRecoveryTime(provider);
    if (!recoveryTime) {
        return null;
    }

    const timestamp = new Date(recoveryTime).getTime();
    if (!Number.isFinite(timestamp)) {
        return null;
    }

    return Math.max(0, timestamp - Date.now());
}

function getProviderStatusCounts(provider = {}) {
    return {
        activeRequests: Number(provider.activeRequests || 0),
        waitingRequests: Number(provider.waitingRequests || 0)
    };
}

function buildObservedProvider(providerType, provider, schedulerSnapshot = null) {
    const runtimeState = inferProviderStateFromConfig(provider);
    const schedulerData = schedulerSnapshot?.get(provider.uuid) || null;
    const recoveryTime = schedulerData?.recoveryTime || getProviderRecoveryTime(provider);
    const cooldownRemainingMs = schedulerData?.cooldownRemainingMs ?? getCooldownRemainingMs(provider);
    const recentHttpStatus = schedulerData?.recentHttpStatus ?? provider.recentHttpStatus ?? extractRecentHttpStatus(provider.lastStateReason || provider.lastErrorMessage || '');
    const isSelectable = schedulerData?.isSelectionCandidate ?? provider.isSelectable ?? (isProviderStateSelectable(runtimeState) && !provider.isDisabled && !provider.needsRefresh);
    const { activeRequests, waitingRequests } = getProviderStatusCounts(provider);

    return {
        ...provider,
        providerType,
        state: runtimeState,
        isHealthy: runtimeState === 'healthy',
        isDisabled: runtimeState === 'disabled',
        isSelectable,
        isSelectionCandidate: schedulerData?.isSelectionCandidate ?? provider.isSelectionCandidate ?? isSelectable,
        isPrimaryCandidate: schedulerData?.isPrimaryCandidate ?? provider.isPrimaryCandidate ?? false,
        schedulerScore: schedulerData?.schedulerScore ?? provider.schedulerScore ?? null,
        schedulerRank: schedulerData?.schedulerRank ?? provider.schedulerRank ?? null,
        selectableRank: schedulerData?.selectableRank ?? provider.selectableRank ?? null,
        schedulerDecision: schedulerData?.schedulerDecision ?? provider.schedulerDecision ?? null,
        schedulerDecisionReason: deriveSchedulerDecisionReason({
            ...provider,
            ...schedulerData
        }),
        schedulerPenaltyBreakdown: schedulerData?.penaltyBreakdown ?? provider.schedulerPenaltyBreakdown ?? [],
        schedulerPenaltySummary: formatSchedulerPenaltyText(schedulerData?.penaltyBreakdown ?? provider.schedulerPenaltyBreakdown ?? []),
        stateScore: Number(provider.stateScore || 0),
        consecutiveFailures: Number(provider.consecutiveFailures || 0),
        recentFailureType: provider.recentFailureType || null,
        recentHttpStatus: recentHttpStatus ?? null,
        recentFailureLabel: recentHttpStatus ? `HTTP ${recentHttpStatus}` : (provider.recentFailureType || null),
        recoveryTime,
        cooldownRemainingMs,
        activeRequests,
        waitingRequests,
        identityFingerprint: buildProviderIdentityFingerprint(providerType, provider)
    };
}

function sanitizeProviderData(provider, maskSensitive = false) {
    if (!provider || typeof provider !== 'object') return provider;
    const sanitized = { ...provider };
    sanitized.state = inferProviderStateFromConfig(sanitized);
    
    // 1. 过滤敏感字段（API Keys, Tokens 等）
    if (maskSensitive) {
        for (const key in sanitized) {
            // 排除已知非敏感字段
            if (NON_SENSITIVE_FIELDS.has(key)) continue;
            
            const val = sanitized[key];
            if (typeof val !== 'string' || !val) continue;

            // 识别敏感字段：包含 KEY, TOKEN, SECRET, PASSWORD, CLEARANCE 等关键词
            // 同时排除包含 PATH, URL, DIR, ENDPOINT 等关键词的路径/地址字段
            const isSensitive = /API_KEY|TOKEN|SECRET|PASSWORD|CLEARANCE|ACCESS_KEY|credentials/i.test(key);
            const isPath = /PATH|URL|DIR|ENDPOINT|REGION/i.test(key);

            if (isSensitive && !isPath) {
                // 对密钥进行脱敏显示（只保留前 4 位和后 4 位）
                if (val.length > 10) {
                    sanitized[key] = val.substring(0, 4) + '****' + val.substring(val.length - 4);
                } else {
                    sanitized[key] = '********';
                }
            }
        }
    }

    // 2. 净化 customName 中的 HTML/脚本
    if (typeof sanitized.customName === 'string') {
        let name = sanitized.customName;
        if (/(?:data|javascript|vbscript)\s*:/i.test(name)) {
            sanitized.customName = '';
            return sanitized;
        }
        name = name.replace(/<[^>]*>/g, '');
        name = name.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
        name = name.replace(/&[#\w]+;/g, '');
        sanitized.customName = name.trim();
    }
    return sanitized;
}

function sanitizeProviderPools(pools, maskSensitive = false) {
    if (!pools || typeof pools !== 'object') return pools;
    const sanitized = {};
    for (const [type, providers] of Object.entries(pools)) {
        sanitized[type] = Array.isArray(providers)
            ? providers.map(p => sanitizeProviderData(p, maskSensitive))
            : providers;
    }
    return sanitized;
}

function getProviderStateCounts(providers = []) {
    const counts = {
        healthy: 0,
        cooldown: 0,
        risky: 0,
        banned: 0,
        disabled: 0,
        unknown: 0
    };

    providers.forEach(provider => {
        const state = inferProviderStateFromConfig(provider);
        if (Object.prototype.hasOwnProperty.call(counts, state)) {
            counts[state]++;
        } else {
            counts.unknown++;
        }
    });

    return counts;
}

function getProviderHealthSummary(providers = []) {
    const stateCounts = getProviderStateCounts(providers);
    return {
        stateCounts,
        healthyCount: stateCounts.healthy,
        disabledCount: stateCounts.disabled,
        unhealthyCount: stateCounts.cooldown + stateCounts.risky + stateCounts.banned + stateCounts.unknown,
        selectableCount: providers.filter(provider => provider.isSelectable).length,
        busyCount: providers.filter(provider => Number(provider.activeRequests || 0) > 0 || Number(provider.waitingRequests || 0) > 0).length
    };
}

function getNextCooldownUntil(providers = []) {
    const cooldownEntries = providers
        .filter(provider => inferProviderStateFromConfig(provider) === 'cooldown' && getProviderRecoveryTime(provider))
        .map(provider => {
            const recoveryTime = getProviderRecoveryTime(provider);
            const timestamp = new Date(recoveryTime).getTime();
            if (!Number.isFinite(timestamp)) {
                return null;
            }

            return {
                value: recoveryTime,
                timestamp
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.timestamp - b.timestamp);

    return cooldownEntries[0]?.value || null;
}

function buildProviderSummary(providers = [], previewLimit = 24) {
    const {
        stateCounts,
        healthyCount,
        disabledCount,
        unhealthyCount,
        selectableCount,
        busyCount
    } = getProviderHealthSummary(providers);
    const authFailureCount = providers.filter(provider => provider.recentFailureType === 'auth').length;
    const rateLimitFailureCount = providers.filter(provider => provider.recentFailureType === 'rate_limit').length;
    return {
        totalCount: providers.length,
        healthyCount,
        disabledCount,
        unhealthyCount,
        selectableCount,
        busyCount,
        stateCounts,
        cooldownCount: stateCounts.cooldown || 0,
        riskyCount: stateCounts.risky || 0,
        bannedCount: stateCounts.banned || 0,
        authFailureCount,
        rateLimitFailureCount,
        nextCooldownUntil: getNextCooldownUntil(providers),
        totalUsage: providers.reduce((sum, provider) => sum + (provider.usageCount || 0), 0),
        totalErrors: providers.reduce((sum, provider) => sum + (provider.errorCount || 0), 0),
        topCandidateUuid: providers.find(provider => provider.isPrimaryCandidate)?.uuid || null,
        previewNodes: providers.slice(0, previewLimit).map(provider => ({
            uuid: provider.uuid,
            customName: provider.customName || null,
            state: provider.state,
            isHealthy: provider.isHealthy,
            isDisabled: provider.isDisabled,
            isSelectable: provider.isSelectable,
            isPrimaryCandidate: provider.isPrimaryCandidate || false,
            schedulerScore: provider.schedulerScore ?? null,
            schedulerRank: provider.schedulerRank ?? null,
            selectableRank: provider.selectableRank ?? null,
            usageCount: provider.usageCount || 0,
            errorCount: provider.errorCount || 0,
            cooldownUntil: provider.cooldownUntil || null,
            cooldownRemainingMs: provider.cooldownRemainingMs ?? null,
            recoveryTime: provider.recoveryTime || null,
            recentFailureType: provider.recentFailureType || null,
            recentHttpStatus: provider.recentHttpStatus ?? null,
            lastStateReason: provider.lastStateReason || provider.lastErrorMessage || null,
            schedulerDecision: provider.schedulerDecision || null,
            schedulerDecisionReason: provider.schedulerDecisionReason || null,
            activeRequests: provider.activeRequests || 0,
            waitingRequests: provider.waitingRequests || 0
        }))
    };
}

function buildRuntimeProviderEntries(currentConfig, providerPoolManager, providerType = null) {
    if (!providerPoolManager?.providerStatus) {
        return providerType ? [] : {};
    }

    const sourceEntries = providerType
        ? { [providerType]: providerPoolManager.providerStatus[providerType] || [] }
        : providerPoolManager.providerStatus;

    const result = {};
    for (const [type, entries] of Object.entries(sourceEntries)) {
        const schedulerSnapshot = providerPoolManager.getProviderSelectionSnapshot
            ? providerPoolManager.getProviderSelectionSnapshot(type)
            : new Map();
        result[type] = (entries || []).map(entry => buildObservedProvider(type, {
            ...entry.config,
            activeRequests: entry.state?.activeCount || 0,
            waitingRequests: entry.state?.waitingCount || 0
        }, schedulerSnapshot));
    }

    return providerType ? (result[providerType] || []) : result;
}

function buildFileBackedProviderEntries(currentConfig, providerPoolManager, providerType = null) {
    const providerPools = loadProviderPools(currentConfig, providerPoolManager);
    if (providerType) {
        return (providerPools[providerType] || []).map(provider => buildObservedProvider(providerType, provider));
    }

    const result = {};
    for (const [type, providers] of Object.entries(providerPools)) {
        result[type] = (providers || []).map(provider => buildObservedProvider(type, provider));
    }
    return result;
}

function getObservedProvidersByType(currentConfig, providerPoolManager, providerType = null) {
    if (providerPoolManager?.providerStatus) {
        return buildRuntimeProviderEntries(currentConfig, providerPoolManager, providerType);
    }

    return buildFileBackedProviderEntries(currentConfig, providerPoolManager, providerType);
}

function matchesProviderStateFilter(provider, stateFilter = []) {
    return stateFilter.length === 0 || stateFilter.includes(provider.state);
}

function matchesRecentFailureFilter(provider, failureFilter = []) {
    return failureFilter.length === 0 || failureFilter.includes(provider.recentFailureType || '');
}

function matchesSelectableFilter(provider, selectableFilter) {
    return selectableFilter === null || Boolean(provider.isSelectable) === selectableFilter;
}

function matchesAbnormalFilter(provider, abnormalFilter) {
    if (abnormalFilter === null) {
        return true;
    }

    const isAbnormal = provider.state !== 'healthy' || provider.needsRefresh || Number(provider.errorCount || 0) > 0;
    return abnormalFilter ? isAbnormal : !isAbnormal;
}

function applyProviderFilters(providers = [], filters = {}) {
    const stateFilter = Array.isArray(filters.state) ? filters.state : parseCsvParam(filters.state);
    const failureFilter = Array.isArray(filters.recentFailureType) ? filters.recentFailureType : parseCsvParam(filters.recentFailureType);
    const selectableFilter = parseBooleanQuery(filters.selectable);
    const abnormalFilter = parseBooleanQuery(filters.abnormal);
    const needsRefreshFilter = parseBooleanQuery(filters.needsRefresh);
    const searchTerm = String(filters.search || '').trim().toLowerCase();

    return providers.filter(provider => {
        if (!matchesProviderStateFilter(provider, stateFilter)) {
            return false;
        }

        if (!matchesRecentFailureFilter(provider, failureFilter)) {
            return false;
        }

        if (!matchesSelectableFilter(provider, selectableFilter)) {
            return false;
        }

        if (!matchesAbnormalFilter(provider, abnormalFilter)) {
            return false;
        }

        if (needsRefreshFilter !== null && Boolean(provider.needsRefresh) !== needsRefreshFilter) {
            return false;
        }

        if (!searchTerm) {
            return true;
        }

        return Object.values(provider).some(value => {
            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                return String(value).toLowerCase().includes(searchTerm);
            }

            if (Array.isArray(value)) {
                return value.some(item => {
                    if (typeof item === 'string' || typeof item === 'number') {
                        return String(item).toLowerCase().includes(searchTerm);
                    }

                    if (item && typeof item === 'object') {
                        return Object.values(item).some(nested => String(nested || '').toLowerCase().includes(searchTerm));
                    }

                    return false;
                });
            }

            return false;
        });
    });
}

function sortProvidersForView(providers = [], sortBy = 'schedulerRank', sortOrder = 'asc') {
    const normalizedSortOrder = normalizeSortOrder(sortOrder);
    const sortFactor = normalizedSortOrder === 'desc' ? -1 : 1;

    const getSortValue = provider => {
        switch (sortBy) {
            case 'schedulerScore':
                return provider.schedulerScore ?? BLOCKED_SELECTION_SCORE;
            case 'stateScore':
                return provider.stateScore ?? 0;
            case 'usageCount':
                return provider.usageCount ?? 0;
            case 'errorCount':
                return provider.errorCount ?? 0;
            case 'cooldownRemainingMs':
                return provider.cooldownRemainingMs ?? -1;
            case 'recentHttpStatus':
                return provider.recentHttpStatus ?? 0;
            case 'selectableRank':
                return provider.selectableRank ?? BLOCKED_SELECTION_SCORE;
            case 'lastStateChangeAt':
                return new Date(provider.lastStateChangeAt || 0).getTime();
            case 'schedulerRank':
            default:
                return provider.schedulerRank ?? BLOCKED_SELECTION_SCORE;
        }
    };

    return [...providers].sort((a, b) => {
        const valueA = getSortValue(a);
        const valueB = getSortValue(b);

        if (valueA !== valueB) {
            return (valueA < valueB ? -1 : 1) * sortFactor;
        }

        return String(a.customName || a.uuid || '').localeCompare(String(b.customName || b.uuid || '')) * sortFactor;
    });
}

/**
 * 过滤掉数据中的脱敏占位符，避免在保存时覆盖真实数据
 */
function filterMaskedData(data) {
    if (!data || typeof data !== 'object') return data;
    const result = { ...data };
    
    for (const key in result) {
        const val = result[key];
        if (typeof val === 'string') {
            // 匹配 ******** 或 XXXX****XXXX 格式
            // 如果值包含 **** 且长度符合脱敏特征，则认为它是脱敏后的回传值，应该忽略
            // 不再仅限于特定的 sensitiveKeys，而是检查所有字符串字段
            if (val === '********' || (val.includes('****') && val.length >= 10)) {
                delete result[key];
            }
        }
    }
    
    return result;
}

function getProviderPoolsFilePath(currentConfig) {
    return currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
}

function loadProviderPools(currentConfig, providerPoolManager) {
    const filePath = getProviderPoolsFilePath(currentConfig);

    if (providerPoolManager?.providerPools) {
        return providerPoolManager.providerPools;
    }

    if (!existsSync(filePath)) {
        return {};
    }

    return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function getRuntimeModelRegistryPayload(currentConfig, providerPoolManager, providerTypes = []) {
    const providerPools = loadProviderPools(currentConfig, providerPoolManager);
    return buildModelRegistryPayload({
        providerTypes,
        providerPools,
        customModels: currentConfig?.customModels || []
    });
}

function parsePositiveInteger(value, fallback, { min = 1, max = 200 } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function matchesProviderSearch(provider, searchTerm = '') {
    if (!searchTerm) {
        return true;
    }

    const normalizedTerm = searchTerm.toLowerCase();
    return Object.values(provider || {}).some(value => {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value).toLowerCase().includes(normalizedTerm);
        }

        if (Array.isArray(value)) {
            return value.some(item =>
                (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') &&
                String(item).toLowerCase().includes(normalizedTerm)
            );
        }

        return false;
    });
}

function persistProviderStatusToFile(currentConfig, providerPoolManager) {
    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    const providerPools = {};

    for (const providerType in providerPoolManager.providerStatus) {
        providerPools[providerType] = providerPoolManager.providerStatus[providerType].map(providerStatus => providerStatus.config);
    }

    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
    return filePath;
}

function persistProviderPoolsToFile(currentConfig, providerPoolManager, providerPools) {
    const filePath = getProviderPoolsFilePath(currentConfig);
    writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');

    if (providerPoolManager) {
        providerPoolManager.providerPools = providerPools;
        providerPoolManager.initializeProviderStatus();
    }

    return filePath;
}

function getObservedProvidersForType(currentConfig, providerPoolManager, providerType, filters = {}, sortOptions = {}) {
    const providers = getObservedProvidersByType(currentConfig, providerPoolManager, providerType) || [];
    const filteredProviders = applyProviderFilters(providers, filters);
    return sortProvidersForView(filteredProviders, sortOptions.sortBy, sortOptions.sortOrder);
}

function getTargetProviderUuids(currentConfig, providerPoolManager, providerType, selector = {}) {
    if (Array.isArray(selector.uuids) && selector.uuids.length > 0) {
        return [...new Set(selector.uuids.map(uuid => String(uuid).trim()).filter(Boolean))];
    }

    if (selector.filters && typeof selector.filters === 'object') {
        return getObservedProvidersForType(currentConfig, providerPoolManager, providerType, selector.filters, selector.sortOptions || {})
            .map(provider => provider.uuid);
    }

    return [];
}

function getProviderTypeEntry(providerType, providerPools = {}) {
    return Array.isArray(providerPools[providerType]) ? providerPools[providerType] : [];
}

function normalizeImportedProvider(providerType, provider = {}) {
    const normalized = filterMaskedData({ ...provider });
    if (!normalized.uuid) {
        normalized.uuid = generateUUID();
    }

    if (!normalized.customName) {
        normalized.customName = null;
    }

    normalized.state = normalized.state || inferProviderStateFromConfig(normalized);
    return normalized;
}

function dedupeProviders(providerType, providers = [], strategy = DEFAULT_BATCH_DEDUPE_STRATEGY) {
    const uuidSeen = new Set();
    const identitySeen = new Set();
    const dedupedProviders = [];
    const removedProviders = [];

    for (const provider of providers) {
        const uuidKey = provider.uuid || null;
        const identityKey = buildProviderIdentityFingerprint(providerType, provider);

        const duplicateByUuid = uuidKey && uuidSeen.has(uuidKey);
        const duplicateByIdentity = identityKey && identitySeen.has(identityKey);
        const isDuplicate = strategy === 'uuid'
            ? duplicateByUuid
            : strategy === 'credential'
                ? duplicateByIdentity
                : duplicateByUuid || duplicateByIdentity;

        if (isDuplicate) {
            removedProviders.push(provider);
            continue;
        }

        if (uuidKey) {
            uuidSeen.add(uuidKey);
        }
        if (identityKey) {
            identitySeen.add(identityKey);
        }
        dedupedProviders.push(provider);
    }

    return { dedupedProviders, removedProviders };
}

function sanitizeExportProviders(providers = [], maskSensitive = false) {
    return providers.map(provider => sanitizeProviderData(provider, maskSensitive));
}

function applyBatchModelsPatch(provider, payload = {}) {
    if (payload.checkModelName !== undefined) {
        provider.checkModelName = payload.checkModelName || null;
    }

    if (payload.supportedModels !== undefined) {
        provider.supportedModels = normalizeModelIds(Array.isArray(payload.supportedModels) ? payload.supportedModels : []);
    }

    if (payload.notSupportedModels !== undefined) {
        provider.notSupportedModels = normalizeModelIds(Array.isArray(payload.notSupportedModels) ? payload.notSupportedModels : []);
    }
}

function isAuthHealthCheckError(errorMessage = '') {
    return /\b(401|403)\b/.test(errorMessage) ||
        /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
}

async function runProviderHealthCheck(providerPoolManager, providerType, providerStatus) {
    const providerConfig = providerStatus.config;

    try {
        // 对于管理模型列表的提供商，如果配置了支持的模型，从中挑选一个用于健康检查
        let checkModelName = providerConfig.checkModelName;
        if (!checkModelName && usesManagedModelList(providerType)) {
            const supportedModels = getConfiguredSupportedModels(providerType, providerConfig);
            if (supportedModels.length > 0) {
                // 优先挑选常见的/轻量级的模型，或者直接取第一个
                checkModelName = supportedModels.find(m =>
                    m.includes('flash') || m.includes('mini') || m.includes('3.5') || m.includes('small')
                ) || supportedModels[0];
                logger.info(`[UI API] Selected model ${checkModelName} for health check of managed provider ${providerConfig.uuid}`);
            }
        }

        const healthResult = await providerPoolManager._checkProviderHealth(providerType, {
            ...providerConfig,
            checkModelName
        });

        if (healthResult.success) {
            providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
            return {
                uuid: providerConfig.uuid,
                success: true,
                healthy: true,
                modelName: healthResult.modelName,
                message: 'Healthy'
            };
        }

        const errorMessage = healthResult.errorMessage || 'Check failed';
        const isAuthError = isAuthHealthCheckError(errorMessage);

        if (isAuthError) {
            providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
            logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
        } else {
            providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
        }

        providerStatus.config.lastHealthCheckTime = new Date().toISOString();
        if (healthResult.modelName) {
            providerStatus.config.lastHealthCheckModel = healthResult.modelName;
        }

        return {
            uuid: providerConfig.uuid,
            success: false,
            healthy: false,
            modelName: healthResult.modelName,
            message: errorMessage,
            isAuthError
        };
    } catch (error) {
        const errorMessage = error.message || 'Unknown error';
        const isAuthError = isAuthHealthCheckError(errorMessage);

        if (isAuthError) {
            providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
            logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
        } else {
            providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
        }

        providerStatus.config.lastHealthCheckTime = new Date().toISOString();

        return {
            uuid: providerConfig.uuid,
            success: false,
            healthy: false,
            message: errorMessage,
            isAuthError
        };
    }
}

// 使用 Promise 链式队列，确保文件操作顺序执行
let _fileLockChain = Promise.resolve();

// 超时包装函数：防止操作永久挂起导致锁链阻塞
function withTimeout(promise, ms = 30000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Operation timeout after ${ms}ms`)), ms)
        )
    ]);
}

function withFileLock(fn) {
    const next = _fileLockChain
        .then(() => withTimeout(fn(), 30000))
        .catch(err => {
            // 记录错误并抛出，中断操作
            logger.error('[FileLock] Operation failed:', err?.message || err);
            throw err;
        });
    _fileLockChain = next.then(() => {}).catch(() => {});
    return next;
}
/**
 * 获取所有提供商的状态（包括支持的类型和号池组）
 */
export async function handleGetProviders(req, res, currentConfig, providerPoolManager) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const summaryOnly = url.searchParams.get('summary') === 'true';
    const registeredProviders = getRegisteredProviders();
    let poolTypes = [];

    const providerStatus = getObservedProvidersByType(currentConfig, providerPoolManager) || {};
    const filePath = getProviderPoolsFilePath(currentConfig);
    try {
        if (existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            poolTypes = Object.keys(poolsData);
            poolTypes.forEach(type => {
                if (!providerStatus[type] || providerStatus[type].length === 0) {
                    providerStatus[type] = (poolsData[type] || []).map(provider => buildObservedProvider(type, provider));
                } else if (!providerStatus[type]) {
                    providerStatus[type] = [];
                }
            });
        }
    } catch (error) {
        logger.warn('[UI API] Failed to supplement provider status:', error.message);
    }

    const supportedProviders = [...new Set([...registeredProviders, ...poolTypes])];
    const providerStateCountsByType = {};
    const providersSummary = {};
    const globalStateCounts = {
        healthy: 0,
        cooldown: 0,
        risky: 0,
        banned: 0,
        disabled: 0,
        unknown: 0
    };

    Object.entries(providerStatus).forEach(([type, providers]) => {
        const stateCounts = getProviderStateCounts(providers);
        providerStateCountsByType[type] = stateCounts;
        providersSummary[type] = buildProviderSummary(providers);
        Object.keys(globalStateCounts).forEach(key => {
            globalStateCounts[key] += stateCounts[key] || 0;
        });
    });

    if (summaryOnly) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            summaryMode: true,
            supportedProviders,
            providersSummary,
            providerStateCountsByType,
            globalStateCounts
        }));
        return true;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providers: sanitizeProviderPools(providerStatus, true), // 列表显示进行打码
        supportedProviders: supportedProviders,
        providersSummary,
        providerStateCountsByType,
        globalStateCounts
    }));
    return true;
}

/**
 * 获取特定提供商类型的详细信息
 */
export async function handleGetProviderType(req, res, currentConfig, providerPoolManager, providerType) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const search = (url.searchParams.get('search') || '').trim();
    const filters = {
        search,
        state: parseCsvParam(url.searchParams.get('state')),
        recentFailureType: parseCsvParam(url.searchParams.get('recentFailureType')),
        selectable: url.searchParams.get('selectable'),
        abnormal: url.searchParams.get('abnormal'),
        needsRefresh: url.searchParams.get('needsRefresh')
    };
    const sortBy = url.searchParams.get('sortBy') || 'schedulerRank';
    const sortOrder = url.searchParams.get('sortOrder') || 'asc';
    const pageParam = url.searchParams.get('page');
    const pageSizeParam = url.searchParams.get('pageSize');
    const usePaginatedResponse = pageParam !== null || pageSizeParam !== null || search !== '' ||
        filters.state.length > 0 || filters.recentFailureType.length > 0 ||
        filters.selectable !== null || filters.abnormal !== null || filters.needsRefresh !== null ||
        sortBy !== 'schedulerRank' || sortOrder !== 'asc';

    const providers = getObservedProvidersByType(currentConfig, providerPoolManager, providerType) || [];
    const { stateCounts, healthyCount, unhealthyCount, selectableCount, busyCount } = getProviderHealthSummary(providers);

    if (!usePaginatedResponse) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            providerType,
            providers: providers.map(p => sanitizeProviderData(p, true)), // 详情页也进行打码，确保即便点击显示也是脱敏数据
            totalCount: providers.length,
            healthyCount,
            unhealthyCount,
            selectableCount,
            busyCount,
            stateCounts,
            summary: buildProviderSummary(providers)
        }));
        return true;
    }

    const filteredProviders = getObservedProvidersForType(currentConfig, providerPoolManager, providerType, filters, {
        sortBy,
        sortOrder
    });
    const pageSize = parsePositiveInteger(pageSizeParam, 20);
    const totalPages = Math.max(1, Math.ceil(filteredProviders.length / pageSize));
    const page = parsePositiveInteger(pageParam, 1, { min: 1, max: totalPages });
    const startIndex = (page - 1) * pageSize;
    const pagedProviders = filteredProviders.slice(startIndex, startIndex + pageSize).map(provider =>
        sanitizeProviderData(provider, true)
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        providers: pagedProviders,
        items: pagedProviders,
        totalCount: providers.length,
        healthyCount,
        unhealthyCount,
        selectableCount,
        busyCount,
        stateCounts,
        summary: buildProviderSummary(providers),
        filteredCount: filteredProviders.length,
        page,
        pageSize,
        totalPages,
        search,
        filters: {
            ...filters,
            selectable: parseBooleanQuery(filters.selectable),
            abnormal: parseBooleanQuery(filters.abnormal),
            needsRefresh: parseBooleanQuery(filters.needsRefresh)
        },
        sortBy,
        sortOrder: normalizeSortOrder(sortOrder)
    }));
    return true;
}

export async function handleExportProviders(req, res, currentConfig, providerPoolManager, providerType) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const filters = {
        search: (url.searchParams.get('search') || '').trim(),
        state: parseCsvParam(url.searchParams.get('state')),
        recentFailureType: parseCsvParam(url.searchParams.get('recentFailureType')),
        selectable: url.searchParams.get('selectable'),
        abnormal: url.searchParams.get('abnormal'),
        needsRefresh: url.searchParams.get('needsRefresh')
    };
    const sortOptions = {
        sortBy: url.searchParams.get('sortBy') || 'schedulerRank',
        sortOrder: url.searchParams.get('sortOrder') || 'asc'
    };
    const maskSensitive = parseBooleanQuery(url.searchParams.get('masked')) === true;

    const observedProviders = getObservedProvidersForType(currentConfig, providerPoolManager, providerType, filters, sortOptions);
    const selectedUuids = new Set(observedProviders.map(provider => provider.uuid));
    const rawProviders = getProviderTypeEntry(providerType, loadProviderPools(currentConfig, providerPoolManager));
    const orderedProviders = observedProviders
        .map(provider => rawProviders.find(item => item.uuid === provider.uuid))
        .filter(Boolean)
        .filter(provider => selectedUuids.has(provider.uuid));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        success: true,
        providerType,
        count: orderedProviders.length,
        exportedAt: new Date().toISOString(),
        filters: {
            ...filters,
            selectable: parseBooleanQuery(filters.selectable),
            abnormal: parseBooleanQuery(filters.abnormal),
            needsRefresh: parseBooleanQuery(filters.needsRefresh)
        },
        providers: sanitizeExportProviders(orderedProviders, maskSensitive)
    }));
    return true;
}

export async function handleBatchImportProviders(req, res, currentConfig, providerPoolManager, providerType) {
    return withFileLock(async () => {
        const body = await getRequestBody(req);
        const importMode = body.mode === 'replace' ? 'replace' : DEFAULT_BATCH_IMPORT_MODE;
        const dedupeEnabled = body.dedupe !== false;
        const dedupeStrategy = body.dedupeStrategy || DEFAULT_BATCH_DEDUPE_STRATEGY;
        const importProviders = Array.isArray(body.providers) ? body.providers : [];

        if (importProviders.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providers array is required' } }));
            return true;
        }

        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const existingProviders = getProviderTypeEntry(providerType, providerPools);
        const normalizedImports = importProviders.map(provider => normalizeImportedProvider(providerType, provider));

        let nextProviders = importMode === 'replace'
            ? normalizedImports
            : [...existingProviders, ...normalizedImports];

        let removedProviders = [];
        if (dedupeEnabled) {
            const result = dedupeProviders(providerType, nextProviders, dedupeStrategy);
            nextProviders = result.dedupedProviders;
            removedProviders = result.removedProviders;
        }

        providerPools[providerType] = nextProviders;
        const filePath = persistProviderPoolsToFile(currentConfig, providerPoolManager, providerPools);

        broadcastEvent('config_update', {
            action: 'batch_import',
            filePath,
            providerType,
            importMode,
            importedCount: normalizedImports.length,
            removedCount: removedProviders.length,
            totalCount: nextProviders.length,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            mode: importMode,
            importedCount: normalizedImports.length,
            removedCount: removedProviders.length,
            totalCount: nextProviders.length,
            removedProviders: removedProviders.map(provider => ({
                uuid: provider.uuid,
                customName: provider.customName || null
            }))
        }));
        return true;
    }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    });
}

export async function handleDedupeProviders(req, res, currentConfig, providerPoolManager, providerType) {
    return withFileLock(async () => {
        const body = await getRequestBody(req);
        const strategy = body.strategy || DEFAULT_BATCH_DEDUPE_STRATEGY;
        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const currentProviders = getProviderTypeEntry(providerType, providerPools);
        const { dedupedProviders, removedProviders } = dedupeProviders(providerType, currentProviders, strategy);

        providerPools[providerType] = dedupedProviders;
        const filePath = persistProviderPoolsToFile(currentConfig, providerPoolManager, providerPools);

        broadcastEvent('config_update', {
            action: 'batch_dedupe',
            filePath,
            providerType,
            removedCount: removedProviders.length,
            strategy,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            strategy,
            totalCount: dedupedProviders.length,
            removedCount: removedProviders.length,
            removedProviders: removedProviders.map(provider => ({
                uuid: provider.uuid,
                customName: provider.customName || null
            }))
        }));
        return true;
    }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    });
}

export async function handleBatchProviderAction(req, res, currentConfig, providerPoolManager, providerType) {
    return withFileLock(async () => {
        const body = await getRequestBody(req);
        const action = String(body.action || '').trim();
        const selector = body.selector || { uuids: body.uuids, filters: body.filters };
        const targetUuids = getTargetProviderUuids(currentConfig, providerPoolManager, providerType, selector);

        if (!action) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'action is required' } }));
            return true;
        }

        if (targetUuids.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No target providers matched the selector' } }));
            return true;
        }

        if (action === 'refresh-status') {
            if (!providerPoolManager?.providerStatus?.[providerType]) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
                return true;
            }

            const providerStatuses = providerPoolManager.providerStatus[providerType]
                .filter(providerStatus => targetUuids.includes(providerStatus.config.uuid));
            const results = [];

            for (const providerStatus of providerStatuses) {
                results.push(await runProviderHealthCheck(providerPoolManager, providerType, providerStatus));
            }

            const filePath = persistProviderStatusToFile(currentConfig, providerPoolManager);
            broadcastEvent('config_update', {
                action: 'batch_refresh_status',
                filePath,
                providerType,
                targetCount: targetUuids.length,
                results,
                timestamp: new Date().toISOString()
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                providerType,
                action,
                targetCount: targetUuids.length,
                successCount: results.filter(result => result.success).length,
                failCount: results.filter(result => !result.success).length,
                results
            }));
            return true;
        }

        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const providers = getProviderTypeEntry(providerType, providerPools);
        const targets = providers.filter(provider => targetUuids.includes(provider.uuid));

        if (targets.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Matched providers are no longer available' } }));
            return true;
        }

        targets.forEach(provider => {
            if (action === 'enable') {
                provider.isDisabled = false;
                if (provider.state === 'disabled') {
                    provider.state = null;
                }
                provider.lastStateReason = 'Enabled by batch action';
                return;
            }

            if (action === 'disable') {
                provider.isDisabled = true;
                provider.state = 'disabled';
                provider.lastStateReason = 'Disabled by batch action';
                return;
            }

            if (action === 'reset-health') {
                provider.isHealthy = true;
                provider.isDisabled = false;
                provider.state = 'healthy';
                provider.stateScore = 100;
                provider.cooldownUntil = null;
                provider.scheduledRecoveryTime = null;
                provider.lastErrorMessage = null;
                provider.lastStateReason = 'Health reset by batch action';
                provider.errorCount = 0;
                provider.consecutiveFailures = 0;
                provider.recentFailureType = null;
                provider.needsRefresh = false;
                provider.refreshCount = 0;
                provider.lastHealthCheckTime = new Date().toISOString();
                return;
            }

            if (action === 'update-models') {
                applyBatchModelsPatch(provider, body.payload || {});
            }
        });

        if (!['enable', 'disable', 'reset-health', 'update-models'].includes(action)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Unsupported batch action: ${action}` } }));
            return true;
        }

        providerPools[providerType] = providers;
        const filePath = persistProviderPoolsToFile(currentConfig, providerPoolManager, providerPools);

        broadcastEvent('config_update', {
            action: 'batch_action',
            filePath,
            providerType,
            batchAction: action,
            targetCount: targets.length,
            targetUuids,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            action,
            targetCount: targets.length,
            targets: targets.map(provider => ({
                uuid: provider.uuid,
                customName: provider.customName || null
            }))
        }));
        return true;
    }).catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    });
}

/**
 * 获取支持的提供商类型（已注册适配器的，以及号池中已存在的自定义类型）
 */
export async function handleGetSupportedProviders(req, res, currentConfig, providerPoolManager) {
    const registeredProviders = getRegisteredProviders();
    let poolTypes = [];

    const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
    try {
        if (providerPoolManager && providerPoolManager.providerPools) {
            poolTypes = Object.keys(providerPoolManager.providerPools);
        } else if (filePath && existsSync(filePath)) {
            const poolsData = JSON.parse(readFileSync(filePath, 'utf-8'));
            poolTypes = Object.keys(poolsData);
        }
    } catch (error) {
        logger.warn('[UI API] Failed to load provider pools for supported types:', error.message);
    }

    // 合并注册的提供商和号池中的类型
    const supportedProviders = [...new Set([...registeredProviders, ...poolTypes])];
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(supportedProviders));
    return true;
}

/**
 * 获取所有提供商的可用模型（支持动态配置组）
 */
export async function handleGetProviderModels(req, res, currentConfig, providerPoolManager) {
    const registeredProviders = getRegisteredProviders();
    let allModels = {};

    try {
        const payload = getRuntimeModelRegistryPayload(currentConfig, providerPoolManager, registeredProviders);
        allModels = payload.providerModelMap;
    } catch (error) {
        logger.warn('[UI API] Failed to build model registry payload:', error.message);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(allModels));
    return true;
}

/**
 * 获取特定提供商类型的可用模型
 */
export async function handleGetProviderTypeModels(req, res, currentConfig, providerPoolManager, providerType) {
    let models = [];
    try {
        const payload = getRuntimeModelRegistryPayload(currentConfig, providerPoolManager, [providerType]);
        models = payload.providerModelMap[providerType] || [];
    } catch (error) {
        logger.warn('[UI API] Failed to load provider type models from registry:', error.message);
        models = getProviderModels(providerType);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        providerType,
        models
    }));
    return true;
}

export async function handleGetModelRegistry(req, res, currentConfig, providerPoolManager) {
    const registeredProviders = getRegisteredProviders();

    try {
        const payload = getRuntimeModelRegistryPayload(currentConfig, providerPoolManager, registeredProviders);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to build model registry:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * Detect available models for a specific provider node.
 */
export async function handleDetectProviderModels(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const body = await getRequestBody(req);
        const draftConfig = filterMaskedData(body?.providerConfig || {});

        const providerPools = loadProviderPools(currentConfig, providerPoolManager);
        const providers = providerPools[providerType] || [];
        const existingProvider = providers.find(provider => provider.uuid === providerUuid) || {};

        const detectionUuid = `${providerUuid}-detect-models`;
        const instanceKey = `${providerType}${detectionUuid}`;
        const tempConfig = {
            ...currentConfig,
            ...existingProvider,
            ...draftConfig,
            MODEL_PROVIDER: providerType,
            uuid: detectionUuid
        };

        const models = await detectAvailableModelsForProvider(providerType, tempConfig, { instanceKey });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            uuid: providerUuid,
            count: models.length,
            models,
            selectedModels: getConfiguredSupportedModels(providerType, existingProvider)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 添加新的提供商配置
 */
export async function handleAddProvider(req, res, currentConfig, providerPoolManager) {
    return withFileLock(() => _handleAddProvider(req, res, currentConfig, providerPoolManager)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleAddProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { providerType, providerConfig } = body;

        if (!providerType || !providerConfig) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerType and providerConfig are required' } }));
            return true;
        }

        // Generate UUID if not provided
        if (!providerConfig.uuid) {
            providerConfig.uuid = generateUUID();
        }

        // Set default values
        providerConfig.isHealthy = providerConfig.isHealthy !== undefined ? providerConfig.isHealthy : true;
        providerConfig.lastUsed = providerConfig.lastUsed || null;
        providerConfig.usageCount = providerConfig.usageCount || 0;
        providerConfig.errorCount = providerConfig.errorCount || 0;
        providerConfig.lastErrorTime = providerConfig.lastErrorTime || null;

        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[UI API] Failed to read existing provider pools:', readError.message);
            }
        }

        // Add new provider to the appropriate type
        if (!providerPools[providerType]) {
            providerPools[providerType] = [];
        }
        
        // 过滤掉脱敏字段
        const filteredConfig = filterMaskedData(providerConfig);
        if (usesManagedModelList(providerType)) {
            filteredConfig.supportedModels = normalizeModelIds(filteredConfig.supportedModels);
            filteredConfig.notSupportedModels = [];
        }
        providerPools[providerType].push(filteredConfig);

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Added new provider to ${providerType}: ${providerConfig.uuid}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'add',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(providerConfig),
            timestamp: new Date().toISOString()
        });

        // 广播提供商更新事件
        broadcastEvent('provider_update', {
            action: 'add',
            providerType,
            providerConfig: sanitizeProviderData(providerConfig),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider added successfully',
            provider: sanitizeProviderData(providerConfig, true),
            providerType
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 更新特定提供商配置
 */
export async function handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    return withFileLock(() => _handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleUpdateProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const body = await getRequestBody(req);
        const { providerConfig } = body;

        if (!providerConfig) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'providerConfig is required' } }));
            return true;
        }

        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and update the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Update provider while preserving certain fields
        const existingProvider = providers[providerIndex];
        
        // 过滤掉传入配置中的脱敏占位符，避免覆盖真实数据
        const filteredConfig = filterMaskedData(providerConfig);
        if (usesManagedModelList(providerType)) {
            filteredConfig.supportedModels = normalizeModelIds(filteredConfig.supportedModels);
            filteredConfig.notSupportedModels = [];
        }
        
        const updatedProvider = {
            ...existingProvider,
            ...filteredConfig,
            uuid: providerUuid, // Ensure UUID doesn't change
            lastUsed: existingProvider.lastUsed, // Preserve usage stats
            usageCount: existingProvider.usageCount,
            errorCount: existingProvider.errorCount,
            lastErrorTime: existingProvider.lastErrorTime
        };

        providerPools[providerType][providerIndex] = updatedProvider;

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Updated provider ${providerUuid} in ${providerType}`);
        invalidateServiceAdapter(providerType, providerUuid);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'update',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(updatedProvider),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider updated successfully',
            provider: sanitizeProviderData(updatedProvider, true)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 删除特定提供商配置
 */
export async function handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    return withFileLock(() => _handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleDeleteProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and remove the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        const deletedProvider = providers[providerIndex];
        providers.splice(providerIndex, 1);

        // Remove the entire provider type if no providers left
        if (providers.length === 0) {
            delete providerPools[providerType];
        }

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Deleted provider ${providerUuid} from ${providerType}`);
        invalidateServiceAdapter(providerType, providerUuid);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete',
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(deletedProvider),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'Provider deleted successfully',
            deletedProvider: sanitizeProviderData(deletedProvider)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 禁用/启用特定提供商配置
 */
export async function handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
    return withFileLock(() => _handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action)).catch(err => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'File operation failed: ' + err.message } }));
        return true;
    });
}
async function _handleDisableEnableProvider(req, res, currentConfig, providerPoolManager, providerType, providerUuid, action) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and update the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Update isDisabled field
        const provider = providers[providerIndex];
        provider.isDisabled = action === 'disable';
        
        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] ${action === 'disable' ? 'Disabled' : 'Enabled'} provider ${providerUuid} in ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            
            // Call the appropriate method
            if (action === 'disable') {
                providerPoolManager.disableProvider(providerType, provider);
            } else {
                providerPoolManager.enableProvider(providerType, provider);
            }
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: action,
            filePath: filePath,
            providerType,
            providerConfig: sanitizeProviderData(provider),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Provider ${action}d successfully`,
            provider: sanitizeProviderData(provider)
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 重置特定提供商类型的所有提供商健康状态
 */
export async function handleResetProviderHealth(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Reset health status for all providers of this type
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        let resetCount = 0;
        providers.forEach(provider => {
            // 统计 isHealthy 从 false 变为 true 的节点数量
            if (!provider.isHealthy) {
                resetCount++;
            }
            // 重置所有节点的状态
            provider.isHealthy = true;
            provider.errorCount = 0;
            provider.refreshCount = 0;
            provider.needsRefresh = false;
            provider.lastErrorTime = null;
        });

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Reset health status for ${resetCount} providers in ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'reset_health',
            filePath: filePath,
            providerType,
            resetCount,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully reset health status for ${resetCount} providers`,
            resetCount,
            totalCount: providers.length
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 删除特定提供商类型的所有不健康节点
 */
export async function handleDeleteUnhealthyProviders(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find and remove unhealthy providers
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        const unhealthyProviders = providers.filter(p => !p.isHealthy);
        const cleanupResult = removeProvidersByPredicate(
            providerPools,
            providerType,
            provider => !provider.isHealthy && shouldPermanentlyDeleteProvider(provider),
            { globalConfig: currentConfig }
        );
        const deletedProviders = cleanupResult.deletedProviders;
        const remainingProviders = cleanupResult.remainingProviders;
        const skippedProviders = unhealthyProviders.filter(provider =>
            !deletedProviders.some(deletedProvider => deletedProvider.uuid === provider.uuid)
        );
        
        if (unhealthyProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to delete',
                deletedCount: 0,
                remainingCount: providers.length
            }));
            return true;
        }

        if (deletedProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No permanently invalid providers to delete',
                deletedCount: 0,
                skippedCount: skippedProviders.length,
                remainingCount: providers.length
            }));
            return true;
        }

        providerPools = cleanupResult.providerPools;

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Deleted ${deletedProviders.length} permanently invalid providers from ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        deletedProviders.forEach(provider => invalidateServiceAdapter(providerType, provider.uuid));

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'delete_unhealthy',
            filePath: filePath,
            providerType,
            deletedCount: deletedProviders.length,
            skippedCount: skippedProviders.length,
            deletedProviders: deletedProviders.map(p => sanitizeProviderData({ uuid: p.uuid, customName: p.customName })),
            deletedCredentialFiles: cleanupResult.deletedCredentialFiles,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully deleted ${deletedProviders.length} permanently invalid providers`,
            deletedCount: deletedProviders.length,
            skippedCount: skippedProviders.length,
            remainingCount: remainingProviders.length,
            deletedProviders: deletedProviders.map(p => ({ uuid: p.uuid, customName: p.customName })),
            deletedCredentialFiles: cleanupResult.deletedCredentialFiles
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 批量刷新特定提供商类型的所有不健康节点的 UUID
 */
export async function handleRefreshUnhealthyUuids(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find unhealthy providers
        const providers = providerPools[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // Filter unhealthy providers and refresh their UUIDs
        const refreshedProviders = [];
        for (const provider of providers) {
            if (!provider.isHealthy) {
                const oldUuid = provider.uuid;
                const newUuid = generateUUID();
                provider.uuid = newUuid;
                refreshedProviders.push({
                    oldUuid,
                    newUuid,
                    customName: provider.customName
                });
            }
        }

        if (refreshedProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to refresh',
                refreshedCount: 0,
                totalCount: providers.length
            }));
            return true;
        }

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Refreshed UUIDs for ${refreshedProviders.length} unhealthy providers in ${providerType}`);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'refresh_unhealthy_uuids',
            filePath: filePath,
            providerType,
            refreshedCount: refreshedProviders.length,
            refreshedProviders: refreshedProviders.map(p => sanitizeProviderData(p)),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Successfully refreshed UUIDs for ${refreshedProviders.length} unhealthy providers`,
            refreshedCount: refreshedProviders.length,
            totalCount: providers.length,
            refreshedProviders
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 对特定提供商类型的所有提供商执行健康检查
 */
export async function handleHealthCheck(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        
        if (providers.length === 0) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'No providers found for this type' } }));
            return true;
        }

        // 只检测不健康的节点
        const unhealthyProviders = providers.filter(ps => !ps.config.isHealthy);
        
        if (unhealthyProviders.length === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                message: 'No unhealthy providers to check',
                successCount: 0,
                failCount: 0,
                totalCount: providers.length,
                results: []
            }));
            return true;
        }

        logger.info(`[UI API] Starting health check for ${unhealthyProviders.length} unhealthy providers in ${providerType} (total: ${providers.length})`);

        // 执行健康检测（检查所有未禁用的 unhealthy providers）
        const results = [];
        for (const providerStatus of unhealthyProviders) {
            const providerConfig = providerStatus.config;
            
            // 跳过已禁用的节点
            if (providerConfig.isDisabled) {
                logger.info(`[UI API] Skipping health check for disabled provider: ${providerConfig.uuid}`);
                continue;
            }

             try {
                const healthResult = await providerPoolManager._checkProviderHealth(providerType, providerConfig);
                
                if (healthResult.success) {
                    providerPoolManager.markProviderHealthy(providerType, providerConfig, false, healthResult.modelName);
                    results.push({
                        uuid: providerConfig.uuid,
                        success: true,
                        modelName: healthResult.modelName,
                        message: 'Healthy'
                    });
                } else {
                    // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                    const errorMessage = healthResult.errorMessage || 'Check failed';
                    const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                       /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                    
                    if (isAuthError) {
                        providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                        logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                    } else {
                        providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                    }
                    
                    providerStatus.config.lastHealthCheckTime = new Date().toISOString();
                    if (healthResult.modelName) {
                        providerStatus.config.lastHealthCheckModel = healthResult.modelName;
                    }
                    results.push({
                        uuid: providerConfig.uuid,
                        success: false,
                        modelName: healthResult.modelName,
                        message: errorMessage,
                        isAuthError: isAuthError
                    });
                }
            } catch (error) {
                const errorMessage = error.message || 'Unknown error';
                // 检查是否为认证错误（401/403），如果是则立即标记为不健康
                const isAuthError = /\b(401|403)\b/.test(errorMessage) ||
                                   /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(errorMessage);
                
                if (isAuthError) {
                    providerPoolManager.markProviderUnhealthyImmediately(providerType, providerConfig, errorMessage);
                    logger.info(`[UI API] Auth error detected for ${providerConfig.uuid}, immediately marked as unhealthy`);
                } else {
                    providerPoolManager.markProviderUnhealthy(providerType, providerConfig, errorMessage);
                }
                
                results.push({
                    uuid: providerConfig.uuid,
                    success: false,
                    message: errorMessage,
                    isAuthError: isAuthError
                });
            }
        }

        // 保存更新后的状态到文件
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        
        // 从 providerStatus 构建 providerPools 对象并保存
        const providerPools = {};
        for (const pType in providerPoolManager.providerStatus) {
            providerPools[pType] = providerPoolManager.providerStatus[pType].map(ps => ps.config);
        }
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');

        const successCount = results.filter(r => r.success === true).length;
        const failCount = results.filter(r => r.success === false).length;

        logger.info(`[UI API] Health check completed for ${providerType}: ${successCount} recovered, ${failCount} still unhealthy (checked ${unhealthyProviders.length} unhealthy nodes)`);

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'health_check',
            filePath: filePath,
            providerType,
            results: results.map(r => ({ ...r, message: sanitizeProviderData({ message: r.message }).message })),
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: `Health check completed: ${successCount} healthy, ${failCount} unhealthy`,
            successCount,
            failCount,
            totalCount: providers.length,
            results
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Health check error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

/**
 * 快速链接配置文件到对应的提供商
 * 支持单个文件路径或文件路径数组
 */
export async function handleSingleProviderHealthCheck(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        if (!providerPoolManager) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider pool manager not initialized' } }));
            return true;
        }

        const providers = providerPoolManager.providerStatus[providerType] || [];
        const providerStatus = providers.find(item => item.config?.uuid === providerUuid);

        if (!providerStatus) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        logger.info(`[UI API] Starting single health check for provider ${providerUuid} in ${providerType}`);

        const result = await runProviderHealthCheck(providerPoolManager, providerType, providerStatus);

        // 使用文件锁进行持久化，防止并发写入冲突
        const filePath = await withFileLock(async () => {
            return persistProviderStatusToFile(currentConfig, providerPoolManager);
        });

        broadcastEvent('config_update', {
            action: 'health_check_single',
            filePath,
            providerType,
            providerUuid,
            result: {
                ...result,
                message: sanitizeProviderData({ message: result.message }).message
            },
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            providerType,
            uuid: providerUuid,
            healthy: result.healthy,
            modelName: result.modelName || null,
            message: result.message,
            isAuthError: result.isAuthError || false
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Single health check error:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}

export async function handleQuickLinkProvider(req, res, currentConfig, providerPoolManager) {
    try {
        const body = await getRequestBody(req);
        const { filePath, filePaths } = body;

        // 支持单个文件路径或文件路径数组
        const pathsToLink = filePaths || (filePath ? [filePath] : []);

        if (!pathsToLink || pathsToLink.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'filePath or filePaths is required' } }));
            return true;
        }

        const poolsFilePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        
        // Load existing pools
        let providerPools = {};
        if (existsSync(poolsFilePath)) {
            try {
                const fileContent = readFileSync(poolsFilePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                logger.warn('[UI API] Failed to read existing provider pools:', readError.message);
            }
        }

        const results = [];
        const linkedProviders = [];

        // 处理每个文件路径
        for (const currentFilePath of pathsToLink) {
            const normalizedPath = currentFilePath.replace(/\\/g, '/').toLowerCase();
            
            // 根据文件路径自动识别提供商类型
            const providerMapping = detectProviderFromPath(normalizedPath);
            
            if (!providerMapping) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'Unable to identify provider type for config file'
                });
                continue;
            }

            const { providerType, credPathKey, defaultCheckModel, displayName } = providerMapping;

            // Ensure provider type array exists
            if (!providerPools[providerType]) {
                providerPools[providerType] = [];
            }

            // Check if already linked - 使用标准化路径进行比较
            const normalizedForComparison = currentFilePath.replace(/\\/g, '/');
            const isAlreadyLinked = providerPools[providerType].some(p => {
                const existingPath = p[credPathKey];
                if (!existingPath) return false;
                const normalizedExistingPath = existingPath.replace(/\\/g, '/');
                return normalizedExistingPath === normalizedForComparison ||
                       normalizedExistingPath === './' + normalizedForComparison ||
                       './' + normalizedExistingPath === normalizedForComparison;
            });

            if (isAlreadyLinked) {
                results.push({
                    filePath: currentFilePath,
                    success: false,
                    error: 'This config file is already linked',
                    providerType: providerType
                });
                continue;
            }

            // Create new provider config based on provider type
            const supportedModels = await inferSupportedModelsFromProviderConfig(providerType, {
                [credPathKey]: formatSystemPath(currentFilePath)
            });

            const newProvider = createProviderConfig({
                credPathKey,
                credPath: formatSystemPath(currentFilePath),
                defaultCheckModel,
                needsProjectId: providerMapping.needsProjectId,
                supportedModels
            });

            providerPools[providerType].push(newProvider);
            linkedProviders.push({ providerType, provider: newProvider });

            results.push({
                filePath: currentFilePath,
                success: true,
                providerType: providerType,
                displayName: displayName,
                provider: newProvider
            });

            logger.info(`[UI API] Quick linked config: ${currentFilePath} -> ${providerType}`);
        }

        // Save to file only if there were successful links
        const successCount = results.filter(r => r.success).length;
        if (successCount > 0) {
            await withFileLock(async () => {
                writeFileSync(poolsFilePath, JSON.stringify(providerPools, null, 2), 'utf-8');
                return poolsFilePath;
            });

            // Update provider pool manager if available
            if (providerPoolManager) {
                providerPoolManager.providerPools = providerPools;
                providerPoolManager.initializeProviderStatus();
            }

            // Broadcast update events
            broadcastEvent('config_update', {
                action: 'quick_link_batch',
                filePath: poolsFilePath,
                results: results,
                timestamp: new Date().toISOString()
            });

            for (const { providerType, provider } of linkedProviders) {
                broadcastEvent('provider_update', {
                    action: 'add',
                    providerType,
                    providerConfig: provider,
                    timestamp: new Date().toISOString()
                });
            }
        }

        const failCount = results.filter(r => !r.success).length;
        const message = successCount > 0
            ? `Successfully linked ${successCount} config file(s)${failCount > 0 ? `, ${failCount} failed` : ''}`
            : `Failed to link all ${failCount} config file(s)`;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: successCount > 0,
            message: message,
            successCount: successCount,
            failCount: failCount,
            results: results
        }));
        return true;
    } catch (error) {
        logger.error('[UI API] Quick link failed:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Link failed: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 刷新特定提供商的UUID
 */
export async function handleRefreshProviderUuid(req, res, currentConfig, providerPoolManager, providerType, providerUuid) {
    try {
        const filePath = currentConfig.PROVIDER_POOLS_FILE_PATH || 'configs/provider_pools.json';
        let providerPools = {};
        
        // Load existing pools
        if (existsSync(filePath)) {
            try {
                const fileContent = readFileSync(filePath, 'utf-8');
                providerPools = JSON.parse(fileContent);
            } catch (readError) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Provider pools file not found' } }));
                return true;
            }
        }

        // Find the provider
        const providers = providerPools[providerType] || [];
        const providerIndex = providers.findIndex(p => p.uuid === providerUuid);
        
        if (providerIndex === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Provider not found' } }));
            return true;
        }

        // Generate new UUID
        const oldUuid = providerUuid;
        const newUuid = generateUUID();
        
        // Update provider UUID
        providerPools[providerType][providerIndex].uuid = newUuid;

        // Save to file
        writeFileSync(filePath, JSON.stringify(providerPools, null, 2), 'utf-8');
        logger.info(`[UI API] Refreshed UUID for provider in ${providerType}: ${oldUuid} -> ${newUuid}`);
        invalidateServiceAdapter(providerType, oldUuid);
        invalidateServiceAdapter(providerType, newUuid);

        // Update provider pool manager if available
        if (providerPoolManager) {
            providerPoolManager.providerPools = providerPools;
            providerPoolManager.initializeProviderStatus();
        }

        // 广播更新事件
        broadcastEvent('config_update', {
            action: 'refresh_uuid',
            filePath: filePath,
            providerType,
            oldUuid,
            newUuid,
            timestamp: new Date().toISOString()
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            message: 'UUID refreshed successfully',
            oldUuid,
            newUuid,
            provider: sanitizeProviderData(providerPools[providerType][providerIndex])
        }));
        return true;
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
        return true;
    }
}
