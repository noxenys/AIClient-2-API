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
const CATALOG_VERSION = 1;

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
        return (providerConfig.CODEX_PLAN_TYPE || providerConfig.plan_type || providerConfig.CODEX_OAUTH_CREDS_FILE_PATH)
            ? 'plan_inference'
            : 'native_api';
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

function normalizeCatalogEntry(providerType, entry = {}, refreshIntervalMs = DEFAULT_CATALOG_REFRESH_INTERVAL_MS) {
    const normalizedEntry = {
        providerType,
        models: normalizeModelIds(entry.models),
        source: entry.source || 'fallback_seed',
        refreshedAt: entry.refreshedAt || null,
        staleAt: entry.staleAt || null,
        status: entry.status || 'unknown',
        successCount: Number(entry.successCount || 0),
        failCount: Number(entry.failCount || 0),
        sampledProviders: Array.isArray(entry.sampledProviders) ? entry.sampledProviders.filter(Boolean) : [],
        lastError: entry.lastError || null,
        errors: Array.isArray(entry.errors) ? entry.errors.filter(Boolean) : [],
        lastRefreshReason: entry.lastRefreshReason || null
    };

    const staleAtMs = normalizedEntry.staleAt ? Date.parse(normalizedEntry.staleAt) : NaN;
    normalizedEntry.isStale = Number.isFinite(staleAtMs) ? staleAtMs <= Date.now() : false;

    if (!normalizedEntry.staleAt && normalizedEntry.refreshedAt) {
        normalizedEntry.staleAt = new Date(Date.parse(normalizedEntry.refreshedAt) + refreshIntervalMs).toISOString();
        normalizedEntry.isStale = false;
    }

    return normalizedEntry;
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
            const providers = {};

            Object.entries(payload?.providers || {}).forEach(([providerType, entry]) => {
                providers[providerType] = normalizeCatalogEntry(providerType, entry, refreshIntervalMs);
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
        const entry = this.catalog?.providers?.[providerType];
        return entry ? normalizeCatalogEntry(providerType, entry, refreshIntervalMs) : null;
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
        const providers = {};

        this.getKnownProviderTypes(providerTypes).forEach(providerType => {
            const entry = this.catalog?.providers?.[providerType];
            if (entry) {
                providers[providerType] = normalizeCatalogEntry(providerType, entry, refreshIntervalMs);
            }
        });

        return {
            version: this.catalog?.version || CATALOG_VERSION,
            updatedAt: this.catalog?.updatedAt || null,
            refreshIntervalMs,
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
        const previousEntry = this.getProviderEntry(providerType);
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

            nextEntry = normalizeCatalogEntry(providerType, {
                models: mergedModels,
                source: sources.length === 1 ? sources[0] : 'multi_probe',
                refreshedAt,
                staleAt: new Date(Date.now() + refreshIntervalMs).toISOString(),
                status: 'ready',
                successCount: successfulResults.length,
                failCount: failedResults.length,
                sampledProviders: probeResults.map(result => result.uuid).filter(Boolean),
                lastError: failedResults[0]?.error || null,
                errors: failedResults.map(result => result.error).filter(Boolean),
                lastRefreshReason: reason
            }, refreshIntervalMs);
        } else {
            const fallbackModels = previousEntry?.models?.length > 0
                ? previousEntry.models
                : getProviderModels(providerType);
            const fallbackSource = previousEntry?.models?.length > 0
                ? previousEntry.source || 'cached'
                : 'fallback_seed';

            nextEntry = normalizeCatalogEntry(providerType, {
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
                lastRefreshReason: reason
            }, refreshIntervalMs);
        }

        this.catalog.providers[providerType] = nextEntry;
        this.catalog.updatedAt = refreshedAt;
        await this.persistCache();

        broadcastEvent('model_catalog_update', {
            action: 'refresh',
            providerType,
            modelCount: nextEntry.models.length,
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
