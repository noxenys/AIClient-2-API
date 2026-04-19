import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';

import { getRegisteredProviders } from './adapter.js';
import { detectAvailableModelsForProvider } from './provider-detection.js';
import { getProviderModels, normalizeModelIds } from './provider-models.js';
import logger from '../utils/logger.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';

const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CATALOG_SAMPLE_LIMIT = 3;
const MAX_CATALOG_SAMPLE_LIMIT = 10;
const DEFAULT_ERROR_REFRESH_DELAY_MS = 5000;
const DEFAULT_MODEL_MISSING_THRESHOLD = 2;
const CATALOG_VERSION = 2;
const MODEL_OBSERVATION_STATUS = new Set(['active', 'missing', 'removed']);

const MODEL_REFRESH_ERROR_PATTERNS = [
    /\bmodel[_\s-]?not[_\s-]?found\b/i,
    /\bunsupported[_\s-]?model\b/i,
    /\binvalid[_\s-]?model\b/i,
    /\bunknown[_\s-]?model\b/i,
    /\bno such model\b/i,
    /\bmodel .* does not exist\b/i,
    /\bdeprecated\b/i
];

function clampInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function resolveCatalogFilePath(globalConfig = {}) {
    const configuredPath = globalConfig.PROVIDER_CATALOG_CACHE_FILE_PATH || 'configs/provider_catalog_cache.json';
    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(process.cwd(), configuredPath);
}

function inferCatalogSource(providerType, providerConfig = {}) {
    if (providerType === 'openai-codex-oauth') {
        return 'official_docs_or_plan';
    }

    if (providerType === 'claude-kiro-oauth') {
        return 'official_docs';
    }

    if (providerType === 'openai-qwen-oauth') {
        return 'live_models_api';
    }

    if (providerType === 'grok-custom') {
        return providerConfig.GROK_COOKIE_TOKEN ? 'grok_modes' : 'fallback_seed';
    }

    return 'native_api';
}

function buildEmptyCatalog() {
    return {
        version: CATALOG_VERSION,
        updatedAt: null,
        providers: {}
    };
}

function normalizeObservationStatus(status = 'active') {
    const normalizedStatus = String(status || 'active').trim().toLowerCase();
    return MODEL_OBSERVATION_STATUS.has(normalizedStatus) ? normalizedStatus : 'active';
}

function buildModelObservation(modelId, observation = {}, fallbackTimestamp = null) {
    const lastSeenAt = observation.lastSeenAt || fallbackTimestamp || null;
    const firstSeenAt = observation.firstSeenAt || lastSeenAt || fallbackTimestamp || null;
    const status = normalizeObservationStatus(observation.status || (observation.removedAt ? 'removed' : 'active'));

    return {
        modelId,
        firstSeenAt,
        lastSeenAt,
        seenCount: Math.max(0, Number(observation.seenCount || 0)),
        lastMissingAt: observation.lastMissingAt || null,
        missingCount: Math.max(0, Number(observation.missingCount || 0)),
        removedAt: observation.removedAt || null,
        status
    };
}

function buildObservationsMap(entry = {}) {
    const fallbackTimestamp = entry.lastSuccessfulRefreshedAt || entry.refreshedAt || null;
    const byModel = {};
    const rawByModel = entry?.observations?.byModel;

    if (rawByModel && typeof rawByModel === 'object') {
        Object.entries(rawByModel).forEach(([modelId, observation]) => {
            const normalizedModelId = String(modelId || '').trim();
            if (!normalizedModelId) {
                return;
            }

            byModel[normalizedModelId] = buildModelObservation(normalizedModelId, observation, fallbackTimestamp);
        });
    }

    normalizeModelIds(entry.models).forEach(modelId => {
        if (!byModel[modelId]) {
            byModel[modelId] = buildModelObservation(modelId, {
                firstSeenAt: fallbackTimestamp,
                lastSeenAt: fallbackTimestamp,
                seenCount: 1,
                missingCount: 0,
                status: 'active'
            }, fallbackTimestamp);
        }
    });

    normalizeModelIds(entry.removedModels).forEach(modelId => {
        if (!byModel[modelId]) {
            byModel[modelId] = buildModelObservation(modelId, {
                firstSeenAt: fallbackTimestamp,
                lastMissingAt: fallbackTimestamp,
                missingCount: Number(entry.missingThreshold || DEFAULT_MODEL_MISSING_THRESHOLD),
                removedAt: fallbackTimestamp,
                status: 'removed'
            }, fallbackTimestamp);
        }
    });

    return byModel;
}

function deriveCatalogModelsFromObservations(byModel = {}) {
    return normalizeModelIds(
        Object.values(byModel)
            .filter(observation => observation.status !== 'removed')
            .map(observation => observation.modelId)
    );
}

function buildObservationSummary(byModel = {}) {
    return Object.values(byModel).reduce((summary, observation) => {
        if (observation.status === 'active') {
            summary.activeModelCount++;
        } else if (observation.status === 'missing') {
            summary.pendingRemovalCount++;
        } else if (observation.status === 'removed') {
            summary.removedModelCount++;
        }

        return summary;
    }, {
        activeModelCount: 0,
        pendingRemovalCount: 0,
        removedModelCount: 0
    });
}

function normalizeCatalogEntry(
    providerType,
    entry = {},
    refreshIntervalMs = DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
    missingThreshold = DEFAULT_MODEL_MISSING_THRESHOLD
) {
    const normalizedThreshold = clampInteger(
        entry.missingThreshold,
        missingThreshold,
        { min: 1, max: 30 }
    );
    const observationsByModel = buildObservationsMap(entry);
    const models = deriveCatalogModelsFromObservations(observationsByModel);
    const summary = buildObservationSummary(observationsByModel);
    const normalizedEntry = {
        providerType,
        models,
        lastDetectedModels: normalizeModelIds(entry.lastDetectedModels || models),
        addedModels: normalizeModelIds(entry.addedModels),
        removedModels: normalizeModelIds(entry.removedModels),
        source: entry.source || 'fallback_seed',
        refreshedAt: entry.refreshedAt || null,
        lastSuccessfulRefreshedAt: entry.lastSuccessfulRefreshedAt || entry.refreshedAt || null,
        staleAt: entry.staleAt || null,
        status: entry.status || 'unknown',
        successCount: Number(entry.successCount || 0),
        failCount: Number(entry.failCount || 0),
        sampledProviders: Array.isArray(entry.sampledProviders) ? entry.sampledProviders.filter(Boolean) : [],
        lastError: entry.lastError || null,
        errors: Array.isArray(entry.errors) ? entry.errors.filter(Boolean) : [],
        lastRefreshReason: entry.lastRefreshReason || null,
        missingThreshold: normalizedThreshold,
        activeModelCount: summary.activeModelCount,
        pendingRemovalCount: summary.pendingRemovalCount,
        removedModelCount: summary.removedModelCount,
        observations: {
            byModel: observationsByModel
        }
    };

    const staleAtMs = normalizedEntry.staleAt ? Date.parse(normalizedEntry.staleAt) : NaN;
    normalizedEntry.isStale = Number.isFinite(staleAtMs) ? staleAtMs <= Date.now() : false;

    if (!normalizedEntry.staleAt && normalizedEntry.refreshedAt) {
        normalizedEntry.staleAt = new Date(Date.parse(normalizedEntry.refreshedAt) + refreshIntervalMs).toISOString();
        normalizedEntry.isStale = false;
    }

    return normalizedEntry;
}

function cloneObservationMap(byModel = {}) {
    const clonedMap = {};

    Object.entries(byModel).forEach(([modelId, observation]) => {
        clonedMap[modelId] = buildModelObservation(modelId, observation, observation?.lastSeenAt || observation?.firstSeenAt || null);
    });

    return clonedMap;
}

function buildNextObservationMap(previousEntry, detectedModels = [], refreshedAt, missingThreshold) {
    const previousObservations = cloneObservationMap(previousEntry?.observations?.byModel || {});
    const nextObservations = cloneObservationMap(previousEntry?.observations?.byModel || {});
    const detectedSet = new Set(detectedModels);
    const addedModels = [];
    const removedModels = [];

    detectedModels.forEach(modelId => {
        const previousObservation = previousObservations[modelId];
        const wasRemoved = previousObservation?.status === 'removed';

        nextObservations[modelId] = buildModelObservation(modelId, {
            firstSeenAt: previousObservation?.firstSeenAt || refreshedAt,
            lastSeenAt: refreshedAt,
            seenCount: Number(previousObservation?.seenCount || 0) + 1,
            lastMissingAt: previousObservation?.lastMissingAt || null,
            missingCount: 0,
            removedAt: null,
            status: 'active'
        }, refreshedAt);

        if (!previousObservation || wasRemoved) {
            addedModels.push(modelId);
        }
    });

    Object.entries(previousObservations).forEach(([modelId, previousObservation]) => {
        if (detectedSet.has(modelId)) {
            return;
        }

        if (previousObservation.status === 'removed') {
            nextObservations[modelId] = buildModelObservation(modelId, previousObservation, refreshedAt);
            return;
        }

        const nextMissingCount = Number(previousObservation.missingCount || 0) + 1;
        const nextStatus = nextMissingCount >= missingThreshold ? 'removed' : 'missing';

        nextObservations[modelId] = buildModelObservation(modelId, {
            ...previousObservation,
            lastMissingAt: refreshedAt,
            missingCount: nextMissingCount,
            removedAt: nextStatus === 'removed' ? refreshedAt : null,
            status: nextStatus
        }, refreshedAt);

        if (nextStatus === 'removed') {
            removedModels.push(modelId);
        }
    });

    return {
        byModel: nextObservations,
        addedModels: normalizeModelIds(addedModels),
        removedModels: normalizeModelIds(removedModels)
    };
}

export function isModelCatalogRefreshError(message = '') {
    const normalizedMessage = String(message || '').trim();
    if (!normalizedMessage) {
        return false;
    }

    return MODEL_REFRESH_ERROR_PATTERNS.some(pattern => pattern.test(normalizedMessage));
}

export class ProviderCatalogManager {
    constructor({
        globalConfig = {},
        providerPoolManager = null
    } = {}) {
        this.globalConfig = globalConfig;
        this.providerPoolManager = providerPoolManager;
        this.catalog = buildEmptyCatalog();
        this.refreshTimer = null;
        this.pendingRefreshTimers = {};
        this.loaded = false;
        this.started = false;
    }

    updateContext({
        globalConfig,
        providerPoolManager
    } = {}) {
        if (globalConfig) {
            this.globalConfig = globalConfig;
        }

        if (providerPoolManager) {
            this.providerPoolManager = providerPoolManager;
        }
    }

    getRefreshIntervalMs() {
        return clampInteger(
            this.globalConfig?.PROVIDER_CATALOG_REFRESH_INTERVAL_MS,
            DEFAULT_CATALOG_REFRESH_INTERVAL_MS,
            { min: 60 * 1000, max: 7 * 24 * 60 * 60 * 1000 }
        );
    }

    getSampleLimit() {
        return clampInteger(
            this.globalConfig?.PROVIDER_CATALOG_SAMPLE_LIMIT,
            DEFAULT_CATALOG_SAMPLE_LIMIT,
            { min: 1, max: MAX_CATALOG_SAMPLE_LIMIT }
        );
    }

    getErrorRefreshDelayMs() {
        return clampInteger(
            this.globalConfig?.PROVIDER_CATALOG_ERROR_REFRESH_DELAY_MS,
            DEFAULT_ERROR_REFRESH_DELAY_MS,
            { min: 0, max: 60 * 1000 }
        );
    }

    getModelMissingThreshold() {
        return clampInteger(
            this.globalConfig?.PROVIDER_CATALOG_MODEL_MISSING_THRESHOLD,
            DEFAULT_MODEL_MISSING_THRESHOLD,
            { min: 1, max: 30 }
        );
    }

    getCatalogFilePath() {
        return resolveCatalogFilePath(this.globalConfig);
    }

    async loadCache() {
        if (this.loaded) {
            return this.catalog;
        }

        const filePath = this.getCatalogFilePath();
        if (!existsSync(filePath)) {
            this.loaded = true;
            return this.catalog;
        }

        try {
            const payload = JSON.parse(readFileSync(filePath, 'utf8'));
            const refreshIntervalMs = this.getRefreshIntervalMs();
            const missingThreshold = this.getModelMissingThreshold();
            const providers = {};

            Object.entries(payload?.providers || {}).forEach(([providerType, entry]) => {
                providers[providerType] = normalizeCatalogEntry(providerType, entry, refreshIntervalMs, missingThreshold);
            });

            this.catalog = {
                version: payload?.version || CATALOG_VERSION,
                updatedAt: payload?.updatedAt || null,
                providers
            };
        } catch (error) {
            logger.warn(`[ModelCatalog] Failed to load cache from ${filePath}: ${error.message}`);
            this.catalog = buildEmptyCatalog();
        }

        this.loaded = true;
        return this.catalog;
    }

    async persistCache() {
        const filePath = this.getCatalogFilePath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(this.catalog, null, 2), 'utf8');
    }

    getKnownProviderTypes(providerTypes = null) {
        if (Array.isArray(providerTypes) && providerTypes.length > 0) {
            return [...new Set(providerTypes.map(type => String(type || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        }

        return [...new Set([
            ...getRegisteredProviders(),
            ...Object.keys(this.providerPoolManager?.providerPools || {}),
            ...Object.keys(this.catalog?.providers || {})
        ])].sort((a, b) => a.localeCompare(b));
    }

    getProviderEntry(providerType) {
        const refreshIntervalMs = this.getRefreshIntervalMs();
        const missingThreshold = this.getModelMissingThreshold();
        const entry = this.catalog?.providers?.[providerType];
        return entry ? normalizeCatalogEntry(providerType, entry, refreshIntervalMs, missingThreshold) : null;
    }

    getProviderModels(providerType) {
        return this.getProviderEntry(providerType)?.models || [];
    }

    getProviderModelMap(providerTypes = null) {
        const result = {};
        this.getKnownProviderTypes(providerTypes).forEach(providerType => {
            const models = this.getProviderModels(providerType);
            if (models.length > 0) {
                result[providerType] = models;
            }
        });
        return result;
    }

    getCatalogPayload(providerTypes = null) {
        const refreshIntervalMs = this.getRefreshIntervalMs();
        const missingThreshold = this.getModelMissingThreshold();
        const providers = {};

        this.getKnownProviderTypes(providerTypes).forEach(providerType => {
            const entry = this.catalog?.providers?.[providerType];
            if (entry) {
                providers[providerType] = normalizeCatalogEntry(providerType, entry, refreshIntervalMs, missingThreshold);
            }
        });

        return {
            version: this.catalog?.version || CATALOG_VERSION,
            updatedAt: this.catalog?.updatedAt || null,
            refreshIntervalMs,
            modelMissingThreshold: missingThreshold,
            filePath: this.globalConfig?.PROVIDER_CATALOG_CACHE_FILE_PATH || 'configs/provider_catalog_cache.json',
            providers
        };
    }

    _buildGlobalProbeCandidate(providerType) {
        const configuredProviders = Array.isArray(this.globalConfig?.DEFAULT_MODEL_PROVIDERS)
            ? this.globalConfig.DEFAULT_MODEL_PROVIDERS
            : [this.globalConfig?.MODEL_PROVIDER].filter(Boolean);

        const canProbeFromGlobalConfig = configuredProviders.some(current =>
            current === providerType || String(providerType).startsWith(`${current}-`)
        );

        if (!canProbeFromGlobalConfig) {
            return null;
        }

        return {
            ...this.globalConfig,
            MODEL_PROVIDER: providerType,
            uuid: `${providerType}-catalog-global`
        };
    }

    _getProbeCandidates(providerType) {
        const sampleLimit = this.getSampleLimit();
        const pool = Array.isArray(this.providerPoolManager?.providerPools?.[providerType])
            ? this.providerPoolManager.providerPools[providerType]
            : [];

        const pooledCandidates = [...pool]
            .filter(provider => !provider?.isDisabled)
            .sort((left, right) => {
                const leftHealthy = left?.isHealthy !== false ? 1 : 0;
                const rightHealthy = right?.isHealthy !== false ? 1 : 0;
                if (leftHealthy !== rightHealthy) {
                    return rightHealthy - leftHealthy;
                }

                return String(left?.uuid || '').localeCompare(String(right?.uuid || ''));
            })
            .slice(0, sampleLimit)
            .map((provider, index) => ({
                ...this.globalConfig,
                ...provider,
                MODEL_PROVIDER: providerType,
                uuid: provider.uuid || `${providerType}-catalog-${index}`
            }));

        if (pooledCandidates.length > 0) {
            return pooledCandidates;
        }

        const globalCandidate = this._buildGlobalProbeCandidate(providerType);
        return globalCandidate ? [globalCandidate] : [];
    }

    async _probeProviderModels(providerType, providerConfig, index = 0) {
        const instanceUuid = providerConfig.uuid || `${providerType}-catalog-${index}`;
        const tempConfig = {
            ...providerConfig,
            MODEL_PROVIDER: providerType,
            uuid: instanceUuid
        };

        try {
            const models = await detectAvailableModelsForProvider(providerType, tempConfig, {
                instanceKey: `${providerType}${instanceUuid}-catalog`
            });

            return {
                success: true,
                uuid: instanceUuid,
                models: normalizeModelIds(models),
                source: inferCatalogSource(providerType, tempConfig)
            };
        } catch (error) {
            return {
                success: false,
                uuid: instanceUuid,
                models: [],
                source: 'error',
                error: error.message || String(error)
            };
        }
    }

    async refreshProviderCatalog(providerType, {
        reason = 'manual'
    } = {}) {
        await this.loadCache();

        const refreshIntervalMs = this.getRefreshIntervalMs();
        const missingThreshold = this.getModelMissingThreshold();
        const previousEntry = this.getProviderEntry(providerType);
        if (reason === 'startup' &&
            providerType === 'grok-custom' &&
            previousEntry?.models?.length > 0 &&
            previousEntry.isStale === false) {
            return previousEntry;
        }
        const probeCandidates = this._getProbeCandidates(providerType);
        const probeResults = await Promise.all(
            probeCandidates.map((providerConfig, index) => this._probeProviderModels(providerType, providerConfig, index))
        );

        const successfulResults = probeResults.filter(result => result.success && result.models.length > 0);
        const failedResults = probeResults.filter(result => !result.success);
        const refreshedAt = new Date().toISOString();

        let nextEntry;
        if (successfulResults.length > 0) {
            const mergedModels = normalizeModelIds(successfulResults.flatMap(result => result.models));
            const sources = [...new Set(successfulResults.map(result => result.source))];
            const { byModel, addedModels, removedModels } = buildNextObservationMap(
                previousEntry,
                mergedModels,
                refreshedAt,
                missingThreshold
            );

            nextEntry = normalizeCatalogEntry(providerType, {
                models: deriveCatalogModelsFromObservations(byModel),
                lastDetectedModels: mergedModels,
                addedModels,
                removedModels,
                observations: {
                    byModel
                },
                source: sources.length === 1 ? sources[0] : 'multi_probe',
                refreshedAt,
                lastSuccessfulRefreshedAt: refreshedAt,
                staleAt: new Date(Date.now() + refreshIntervalMs).toISOString(),
                status: 'ready',
                successCount: successfulResults.length,
                failCount: failedResults.length,
                sampledProviders: probeResults.map(result => result.uuid).filter(Boolean),
                lastError: failedResults[0]?.error || null,
                errors: failedResults.map(result => result.error).filter(Boolean),
                lastRefreshReason: reason,
                missingThreshold
            }, refreshIntervalMs, missingThreshold);
        } else {
            const fallbackModels = previousEntry?.models?.length > 0
                ? previousEntry.models
                : getProviderModels(providerType);
            const fallbackSource = previousEntry?.models?.length > 0
                ? previousEntry.source || 'cached'
                : 'fallback_seed';

            nextEntry = normalizeCatalogEntry(providerType, {
                ...(previousEntry || {}),
                models: fallbackModels,
                source: fallbackSource,
                refreshedAt,
                staleAt: previousEntry?.staleAt || new Date(Date.now() + refreshIntervalMs).toISOString(),
                status: previousEntry?.models?.length > 0 ? 'stale' : 'fallback',
                successCount: 0,
                failCount: failedResults.length,
                sampledProviders: probeResults.map(result => result.uuid).filter(Boolean),
                lastError: failedResults[0]?.error || null,
                errors: failedResults.map(result => result.error).filter(Boolean),
                lastRefreshReason: reason,
                missingThreshold
            }, refreshIntervalMs, missingThreshold);
        }

        this.catalog.providers[providerType] = nextEntry;
        this.catalog.updatedAt = refreshedAt;
        await this.persistCache();

        broadcastEvent('model_catalog_update', {
            action: 'refresh',
            providerType,
            modelCount: nextEntry.models.length,
            activeModelCount: nextEntry.activeModelCount,
            pendingRemovalCount: nextEntry.pendingRemovalCount,
            removedModelCount: nextEntry.removedModelCount,
            addedModels: nextEntry.addedModels,
            removedModels: nextEntry.removedModels,
            missingThreshold: nextEntry.missingThreshold,
            source: nextEntry.source,
            status: nextEntry.status,
            reason,
            timestamp: refreshedAt
        });

        return nextEntry;
    }

    async refreshAllCatalogs({
        providerTypes = null,
        reason = 'manual'
    } = {}) {
        const results = [];

        for (const providerType of this.getKnownProviderTypes(providerTypes)) {
            results.push(await this.refreshProviderCatalog(providerType, { reason }));
        }

        return results;
    }

    scheduleRefresh(providerType, {
        reason = 'error_trigger',
        delayMs = this.getErrorRefreshDelayMs()
    } = {}) {
        if (!providerType) {
            return;
        }

        if (this.pendingRefreshTimers[providerType]) {
            clearTimeout(this.pendingRefreshTimers[providerType]);
        }

        this.pendingRefreshTimers[providerType] = setTimeout(() => {
            delete this.pendingRefreshTimers[providerType];
            void this.refreshProviderCatalog(providerType, { reason }).catch(error => {
                logger.warn(`[ModelCatalog] Failed scheduled refresh for ${providerType}: ${error.message}`);
            });
        }, Math.max(0, Number(delayMs) || 0));
    }

    async start({
        startupRun = this.globalConfig?.PROVIDER_CATALOG_STARTUP_REFRESH !== false
    } = {}) {
        await this.loadCache();

        const refreshIntervalMs = this.getRefreshIntervalMs();
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
        }

        this.refreshTimer = setInterval(() => {
            void this.refreshAllCatalogs({ reason: 'interval' }).catch(error => {
                logger.warn(`[ModelCatalog] Interval refresh failed: ${error.message}`);
            });
        }, refreshIntervalMs);

        this.started = true;

        if (startupRun) {
            void this.refreshAllCatalogs({ reason: 'startup' }).catch(error => {
                logger.warn(`[ModelCatalog] Startup refresh failed: ${error.message}`);
            });
        }
    }

    stop() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }

        Object.values(this.pendingRefreshTimers).forEach(timer => clearTimeout(timer));
        this.pendingRefreshTimers = {};
        this.started = false;
    }
}
