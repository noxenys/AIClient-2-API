import { existsSync, readFileSync } from 'fs';
import { promises as fs } from 'fs';
import path from 'path';

import logger from '../utils/logger.js';
import { broadcastEvent } from '../ui-modules/event-broadcast.js';
import {
    getConfiguredSupportedModels,
    getProviderModels,
    normalizeModelIds
} from './provider-models.js';
import {
    classifyProviderFailure,
    inferProviderStateFromConfig,
    isProviderStateSelectable,
    normalizeProviderState
} from '../utils/provider-state.js';

const STATUS_STORE_VERSION = 1;
const DEFAULT_PERSIST_INTERVAL_MS = 10 * 1000;
const DEFAULT_RECENT_WINDOW_SIZE = 20;
const MAX_RECENT_WINDOW_SIZE = 50;

const STATUS_SEVERITY = {
    failing: 0,
    degraded: 1,
    healthy: 2,
    unknown: 3
};

const STREAM_INTERRUPTION_PATTERNS = [
    /stream resume diverged/i,
    /stream ended before completion marker/i,
    /completion marker/i,
    /stream interrupted/i,
    /stream closed unexpectedly/i,
    /incomplete stream/i
];

function clampInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(Math.max(parsed, min), max);
}

function resolveStatusFilePath(globalConfig = {}) {
    const configuredPath = globalConfig.MODEL_STATUS_CACHE_FILE_PATH || 'configs/model_status_cache.json';
    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.join(process.cwd(), configuredPath);
}

function createEmptyStore() {
    return {
        version: STATUS_STORE_VERSION,
        updatedAt: null,
        providers: {}
    };
}

function createEmptyEntry(providerType, modelId) {
    return {
        providerType,
        modelId,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        abortedCount: 0,
        streamCount: 0,
        streamSuccessCount: 0,
        streamFailureCount: 0,
        streamInterruptedCount: 0,
        unaryCount: 0,
        unarySuccessCount: 0,
        unaryFailureCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        lastLatencyMs: null,
        lastRequestAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastAbortAt: null,
        lastFailureType: null,
        lastHttpStatus: null,
        lastErrorMessage: null,
        lastNodeUuid: null,
        lastCustomName: null,
        statusCounts: {
            '401': 0,
            '403': 0,
            '429': 0,
            '5xx': 0
        },
        recentAttempts: []
    };
}

function normalizeRecentAttempt(attempt = {}) {
    const httpStatus = Number.parseInt(attempt.httpStatus, 10);
    const durationMs = Number.isFinite(Number(attempt.durationMs)) ? Math.max(0, Number(attempt.durationMs)) : null;

    return {
        timestamp: attempt.timestamp || null,
        success: attempt.success === true,
        aborted: attempt.aborted === true,
        isStream: attempt.isStream === true,
        interrupted: attempt.interrupted === true,
        durationMs,
        failureType: attempt.failureType || null,
        httpStatus: Number.isInteger(httpStatus) ? httpStatus : null
    };
}

function summarizeRecentAttempts(recentAttempts = []) {
    const summary = {
        observedCount: 0,
        totalCount: 0,
        successCount: 0,
        failureCount: 0,
        abortedCount: 0,
        streamInterruptedCount: 0,
        avgLatencyMs: null,
        successRate: null,
        httpStatusCounts: {
            '401': 0,
            '403': 0,
            '429': 0,
            '5xx': 0
        }
    };

    let latencyCount = 0;
    let totalLatencyMs = 0;

    recentAttempts.forEach(rawAttempt => {
        const attempt = normalizeRecentAttempt(rawAttempt);
        summary.observedCount += 1;

        if (attempt.aborted) {
            summary.abortedCount += 1;
        } else if (attempt.success) {
            summary.successCount += 1;
            summary.totalCount += 1;
        } else {
            summary.failureCount += 1;
            summary.totalCount += 1;
        }

        if (attempt.interrupted) {
            summary.streamInterruptedCount += 1;
        }

        if (attempt.durationMs !== null) {
            totalLatencyMs += attempt.durationMs;
            latencyCount += 1;
        }

        if (attempt.httpStatus === 401) summary.httpStatusCounts['401'] += 1;
        if (attempt.httpStatus === 403) summary.httpStatusCounts['403'] += 1;
        if (attempt.httpStatus === 429) summary.httpStatusCounts['429'] += 1;
        if (attempt.httpStatus !== null && attempt.httpStatus >= 500 && attempt.httpStatus <= 599) {
            summary.httpStatusCounts['5xx'] += 1;
        }
    });

    if (latencyCount > 0) {
        summary.avgLatencyMs = Math.round(totalLatencyMs / latencyCount);
    }

    if (summary.totalCount > 0) {
        summary.successRate = Number((summary.successCount / summary.totalCount).toFixed(4));
    }

    return summary;
}

function deriveModelHealthStatus(entry = {}, recentSummary = summarizeRecentAttempts()) {
    const observedTotal = recentSummary.totalCount;

    if (observedTotal === 0) {
        if (Number(entry.successCount || 0) > 0 && Number(entry.failureCount || 0) === 0) {
            return 'healthy';
        }

        if (Number(entry.failureCount || 0) > 0 && Number(entry.successCount || 0) === 0) {
            return 'failing';
        }

        return 'unknown';
    }

    if (recentSummary.failureCount === 0) {
        return 'healthy';
    }

    if (recentSummary.successCount === 0) {
        return 'failing';
    }

    const successRate = Number(recentSummary.successRate || 0);
    const hasAuthFailures = recentSummary.httpStatusCounts['401'] > 0 || recentSummary.httpStatusCounts['403'] > 0;
    const hasRateLimits = recentSummary.httpStatusCounts['429'] > 0;
    const hasServerFailures = recentSummary.httpStatusCounts['5xx'] > 0;
    const hasStreamInterruptions = recentSummary.streamInterruptedCount > 0;

    if (successRate < 0.5 || hasAuthFailures && successRate < 0.75) {
        return 'failing';
    }

    if (hasRateLimits || hasServerFailures || hasStreamInterruptions || successRate < 0.9) {
        return 'degraded';
    }

    return 'healthy';
}

function normalizeEntry(providerType, modelId, entry = {}, recentWindowSize = DEFAULT_RECENT_WINDOW_SIZE) {
    const normalized = {
        ...createEmptyEntry(providerType, modelId),
        ...entry,
        providerType,
        modelId,
        requestCount: Number(entry.requestCount || 0),
        successCount: Number(entry.successCount || 0),
        failureCount: Number(entry.failureCount || 0),
        abortedCount: Number(entry.abortedCount || 0),
        streamCount: Number(entry.streamCount || 0),
        streamSuccessCount: Number(entry.streamSuccessCount || 0),
        streamFailureCount: Number(entry.streamFailureCount || 0),
        streamInterruptedCount: Number(entry.streamInterruptedCount || 0),
        unaryCount: Number(entry.unaryCount || 0),
        unarySuccessCount: Number(entry.unarySuccessCount || 0),
        unaryFailureCount: Number(entry.unaryFailureCount || 0),
        totalLatencyMs: Number(entry.totalLatencyMs || 0),
        lastLatencyMs: Number.isFinite(Number(entry.lastLatencyMs)) ? Number(entry.lastLatencyMs) : null,
        lastRequestAt: entry.lastRequestAt || null,
        lastSuccessAt: entry.lastSuccessAt || null,
        lastFailureAt: entry.lastFailureAt || null,
        lastAbortAt: entry.lastAbortAt || null,
        lastFailureType: entry.lastFailureType || null,
        lastHttpStatus: Number.isInteger(Number(entry.lastHttpStatus)) ? Number(entry.lastHttpStatus) : null,
        lastErrorMessage: entry.lastErrorMessage || null,
        lastNodeUuid: entry.lastNodeUuid || null,
        lastCustomName: entry.lastCustomName || null,
        statusCounts: {
            '401': Number(entry?.statusCounts?.['401'] || 0),
            '403': Number(entry?.statusCounts?.['403'] || 0),
            '429': Number(entry?.statusCounts?.['429'] || 0),
            '5xx': Number(entry?.statusCounts?.['5xx'] || 0)
        },
        recentAttempts: Array.isArray(entry.recentAttempts)
            ? entry.recentAttempts.slice(-recentWindowSize).map(normalizeRecentAttempt)
            : []
    };

    normalized.avgLatencyMs = normalized.requestCount > 0
        ? Math.round(normalized.totalLatencyMs / Math.max(1, normalized.requestCount))
        : 0;
    normalized.recentSummary = summarizeRecentAttempts(normalized.recentAttempts);
    normalized.status = deriveModelHealthStatus(normalized, normalized.recentSummary);
    normalized.successRate = normalized.requestCount > 0
        ? Number((normalized.successCount / normalized.requestCount).toFixed(4))
        : null;

    return normalized;
}

function buildProviderSummary(items = []) {
    const summary = {
        totalModels: items.length,
        healthyCount: 0,
        degradedCount: 0,
        failingCount: 0,
        unknownCount: 0,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        abortedCount: 0,
        streamInterruptedCount: 0,
        recent401Count: 0,
        recent403Count: 0,
        recent429Count: 0,
        recent5xxCount: 0
    };

    items.forEach(item => {
        if (item.status === 'healthy') summary.healthyCount += 1;
        else if (item.status === 'degraded') summary.degradedCount += 1;
        else if (item.status === 'failing') summary.failingCount += 1;
        else summary.unknownCount += 1;

        summary.requestCount += Number(item.requestCount || 0);
        summary.successCount += Number(item.successCount || 0);
        summary.failureCount += Number(item.failureCount || 0);
        summary.abortedCount += Number(item.abortedCount || 0);
        summary.streamInterruptedCount += Number(item.streamInterruptedCount || 0);
        summary.recent401Count += Number(item.recentSummary?.httpStatusCounts?.['401'] || 0);
        summary.recent403Count += Number(item.recentSummary?.httpStatusCounts?.['403'] || 0);
        summary.recent429Count += Number(item.recentSummary?.httpStatusCounts?.['429'] || 0);
        summary.recent5xxCount += Number(item.recentSummary?.httpStatusCounts?.['5xx'] || 0);
    });

    summary.successRate = summary.requestCount > 0
        ? Number((summary.successCount / summary.requestCount).toFixed(4))
        : null;

    return summary;
}

function classifyModelFailure(errorMessage = '', { isStream = false, httpStatus = null } = {}) {
    const normalizedMessage = String(errorMessage || '').trim();
    if (!normalizedMessage && httpStatus === null) {
        return 'unknown';
    }

    if (isStream && STREAM_INTERRUPTION_PATTERNS.some(pattern => pattern.test(normalizedMessage))) {
        return 'stream_interrupted';
    }

    if (httpStatus === 401 || httpStatus === 403) {
        return 'auth';
    }
    if (httpStatus === 429) {
        return 'rate_limit';
    }
    if (httpStatus !== null && httpStatus >= 500 && httpStatus <= 599) {
        return 'upstream';
    }

    return classifyProviderFailure(normalizedMessage) || 'unknown';
}

function extractHttpStatus(errorMessage = '', explicitStatus = null) {
    if (Number.isInteger(Number(explicitStatus))) {
        return Number(explicitStatus);
    }

    const match = String(errorMessage || '').match(/\b(401|403|429|500|502|503|504)\b/);
    return match ? Number(match[1]) : null;
}

export class ModelStatusManager {
    constructor({
        globalConfig = {},
        providerPoolManager = null,
        providerCatalogManager = null
    } = {}) {
        this.globalConfig = globalConfig;
        this.providerPoolManager = providerPoolManager;
        this.providerCatalogManager = providerCatalogManager;
        this.store = createEmptyStore();
        this.persistTimer = null;
        this.loaded = false;
        this.dirty = false;
    }

    updateContext({
        globalConfig,
        providerPoolManager,
        providerCatalogManager
    } = {}) {
        if (globalConfig) {
            this.globalConfig = globalConfig;
        }
        if (providerPoolManager) {
            this.providerPoolManager = providerPoolManager;
        }
        if (providerCatalogManager) {
            this.providerCatalogManager = providerCatalogManager;
        }
    }

    getPersistIntervalMs() {
        return clampInteger(
            this.globalConfig?.MODEL_STATUS_PERSIST_INTERVAL_MS,
            DEFAULT_PERSIST_INTERVAL_MS,
            { min: 1000, max: 5 * 60 * 1000 }
        );
    }

    getRecentWindowSize() {
        return clampInteger(
            this.globalConfig?.MODEL_STATUS_RECENT_WINDOW_SIZE,
            DEFAULT_RECENT_WINDOW_SIZE,
            { min: 5, max: MAX_RECENT_WINDOW_SIZE }
        );
    }

    getStatusFilePath() {
        return resolveStatusFilePath(this.globalConfig);
    }

    async loadCache() {
        if (this.loaded) {
            return this.store;
        }

        const filePath = this.getStatusFilePath();
        if (!existsSync(filePath)) {
            this.loaded = true;
            return this.store;
        }

        try {
            const payload = JSON.parse(readFileSync(filePath, 'utf8'));
            const recentWindowSize = this.getRecentWindowSize();
            const providers = {};

            Object.entries(payload?.providers || {}).forEach(([providerType, models]) => {
                providers[providerType] = {};
                Object.entries(models || {}).forEach(([modelId, entry]) => {
                    providers[providerType][modelId] = normalizeEntry(providerType, modelId, entry, recentWindowSize);
                });
            });

            this.store = {
                version: payload?.version || STATUS_STORE_VERSION,
                updatedAt: payload?.updatedAt || null,
                providers
            };
        } catch (error) {
            logger.warn(`[ModelStatus] Failed to load cache from ${filePath}: ${error.message}`);
            this.store = createEmptyStore();
        }

        this.loaded = true;
        return this.store;
    }

    async persistCache() {
        if (!this.dirty) {
            return;
        }

        const filePath = this.getStatusFilePath();
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(this.store, null, 2), 'utf8');
        this.dirty = false;
    }

    async start() {
        await this.loadCache();

        if (this.persistTimer) {
            clearInterval(this.persistTimer);
        }

        this.persistTimer = setInterval(() => {
            void this.persistCache().catch(error => {
                logger.warn(`[ModelStatus] Failed to persist cache: ${error.message}`);
            });
        }, this.getPersistIntervalMs());

        if (this.persistTimer.unref) {
            this.persistTimer.unref();
        }
    }

    async stop() {
        if (this.persistTimer) {
            clearInterval(this.persistTimer);
            this.persistTimer = null;
        }

        await this.persistCache().catch(error => {
            logger.warn(`[ModelStatus] Failed to persist cache during shutdown: ${error.message}`);
        });
    }

    _markDirty() {
        this.store.updatedAt = new Date().toISOString();
        this.dirty = true;
    }

    _ensureEntry(providerType, modelId) {
        if (!this.store.providers[providerType]) {
            this.store.providers[providerType] = {};
        }

        const recentWindowSize = this.getRecentWindowSize();
        const existing = this.store.providers[providerType][modelId];
        const normalized = normalizeEntry(providerType, modelId, existing || createEmptyEntry(providerType, modelId), recentWindowSize);
        this.store.providers[providerType][modelId] = normalized;
        return normalized;
    }

    _appendRecentAttempt(entry, attempt) {
        const recentWindowSize = this.getRecentWindowSize();
        const attempts = [...(Array.isArray(entry.recentAttempts) ? entry.recentAttempts : []), normalizeRecentAttempt(attempt)];
        entry.recentAttempts = attempts.slice(-recentWindowSize);
        entry.recentSummary = summarizeRecentAttempts(entry.recentAttempts);
        entry.status = deriveModelHealthStatus(entry, entry.recentSummary);
        entry.successRate = entry.requestCount > 0
            ? Number((entry.successCount / entry.requestCount).toFixed(4))
            : null;
        entry.avgLatencyMs = entry.requestCount > 0
            ? Math.round(entry.totalLatencyMs / Math.max(1, entry.requestCount))
            : 0;
    }

    _getKnownProviderTypes(providerTypes = null) {
        if (Array.isArray(providerTypes) && providerTypes.length > 0) {
            return [...new Set(providerTypes.map(type => String(type || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
        }

        return [...new Set([
            ...Object.keys(this.store?.providers || {}),
            ...Object.keys(this.providerPoolManager?.providerPools || {})
        ])].sort((a, b) => a.localeCompare(b));
    }

    _nodeSupportsModel(providerType, providerConfig = {}, modelId = '') {
        const configuredModels = normalizeModelIds(getConfiguredSupportedModels(providerType, providerConfig));
        if (configuredModels.length > 0) {
            return configuredModels.includes(modelId);
        }

        const excludedModels = normalizeModelIds(providerConfig?.notSupportedModels || []);
        if (excludedModels.includes(modelId)) {
            return false;
        }

        const catalogModels = normalizeModelIds(this.providerCatalogManager?.getProviderModels(providerType) || []);
        if (catalogModels.length > 0) {
            return catalogModels.includes(modelId);
        }

        return normalizeModelIds(getProviderModels(providerType)).includes(modelId);
    }

    _getKnownModelIds(providerType) {
        const storeModels = Object.keys(this.store?.providers?.[providerType] || {});
        const runtimeProviders = Array.isArray(this.providerPoolManager?.providerStatus?.[providerType])
            ? this.providerPoolManager.providerStatus[providerType]
            : [];
        const configuredModels = normalizeModelIds(runtimeProviders.flatMap(providerStatus =>
            getConfiguredSupportedModels(providerType, providerStatus?.config)
        ));
        const catalogModels = normalizeModelIds(this.providerCatalogManager?.getProviderModels(providerType) || []);
        const knownModels = normalizeModelIds([...storeModels, ...configuredModels, ...catalogModels]);

        if (knownModels.length > 0) {
            return knownModels;
        }

        return normalizeModelIds(getProviderModels(providerType));
    }

    _buildRuntimeSummary(providerType, modelId) {
        const runtimeProviders = Array.isArray(this.providerPoolManager?.providerStatus?.[providerType])
            ? this.providerPoolManager.providerStatus[providerType]
            : [];
        const snapshot = this.providerPoolManager?.getProviderSelectionSnapshot
            ? this.providerPoolManager.getProviderSelectionSnapshot(providerType)
            : new Map();

        const stateCounts = {
            healthy: 0,
            cooldown: 0,
            risky: 0,
            banned: 0,
            disabled: 0,
            unknown: 0
        };

        const supportingProviders = runtimeProviders.filter(providerStatus =>
            this._nodeSupportsModel(providerType, providerStatus?.config, modelId)
        );

        supportingProviders.forEach(providerStatus => {
            const runtimeState = normalizeProviderState(
                providerStatus?.config?.state,
                inferProviderStateFromConfig(providerStatus?.config || {})
            );
            if (Object.prototype.hasOwnProperty.call(stateCounts, runtimeState)) {
                stateCounts[runtimeState] += 1;
            } else {
                stateCounts.unknown += 1;
            }
        });

        const selectableProviders = supportingProviders
            .map(providerStatus => ({
                uuid: providerStatus.uuid,
                snapshot: snapshot.get(providerStatus.uuid) || null
            }))
            .filter(item => item.snapshot?.isSelectionCandidate)
            .sort((left, right) => {
                const leftRank = left.snapshot?.schedulerRank ?? Number.MAX_SAFE_INTEGER;
                const rightRank = right.snapshot?.schedulerRank ?? Number.MAX_SAFE_INTEGER;
                return leftRank - rightRank;
            });

        return {
            totalNodeCount: runtimeProviders.length,
            supportingNodeCount: supportingProviders.length,
            selectableNodeCount: selectableProviders.length,
            primaryCandidateUuid: selectableProviders[0]?.uuid || null,
            stateCounts
        };
    }

    _decorateEntry(providerType, modelId) {
        const entry = normalizeEntry(providerType, modelId, this.store?.providers?.[providerType]?.[modelId] || {}, this.getRecentWindowSize());
        const catalogEntry = this.providerCatalogManager?.getProviderEntry(providerType) || null;
        return {
            ...entry,
            runtime: this._buildRuntimeSummary(providerType, modelId),
            catalogStatus: catalogEntry?.status || 'unknown',
            catalogSource: catalogEntry?.source || '',
            catalogRefreshedAt: catalogEntry?.refreshedAt || null
        };
    }

    getStatusPayload(providerTypes = null) {
        const providers = {};
        const knownTypes = this._getKnownProviderTypes(providerTypes);

        knownTypes.forEach(providerType => {
            const items = this._getKnownModelIds(providerType)
                .map(modelId => this._decorateEntry(providerType, modelId))
                .sort((left, right) => {
                    const severityDiff = (STATUS_SEVERITY[left.status] ?? 99) - (STATUS_SEVERITY[right.status] ?? 99);
                    if (severityDiff !== 0) {
                        return severityDiff;
                    }

                    const leftRequests = Number(left.requestCount || 0);
                    const rightRequests = Number(right.requestCount || 0);
                    if (leftRequests !== rightRequests) {
                        return rightRequests - leftRequests;
                    }

                    return String(left.modelId || '').localeCompare(String(right.modelId || ''));
                });

            providers[providerType] = {
                providerType,
                summary: buildProviderSummary(items),
                items,
                byModel: Object.fromEntries(items.map(item => [item.modelId, item]))
            };
        });

        return {
            version: this.store?.version || STATUS_STORE_VERSION,
            updatedAt: this.store?.updatedAt || null,
            recentWindowSize: this.getRecentWindowSize(),
            persistIntervalMs: this.getPersistIntervalMs(),
            filePath: this.globalConfig?.MODEL_STATUS_CACHE_FILE_PATH || 'configs/model_status_cache.json',
            providers
        };
    }

    _broadcastUpdate(action, providerType, modelId, entry) {
        broadcastEvent('model_status_update', {
            action,
            providerType,
            modelId,
            status: entry.status,
            requestCount: entry.requestCount,
            successCount: entry.successCount,
            failureCount: entry.failureCount,
            successRate: entry.successRate,
            lastFailureType: entry.lastFailureType,
            lastHttpStatus: entry.lastHttpStatus,
            timestamp: new Date().toISOString()
        });
    }

    recordSuccess({
        providerType,
        modelId,
        isStream = false,
        durationMs = null,
        pooluuid = null,
        customName = null
    } = {}) {
        if (!providerType || !modelId) {
            return;
        }

        const entry = this._ensureEntry(providerType, modelId);
        const timestamp = new Date().toISOString();
        const latency = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : null;

        entry.requestCount += 1;
        entry.successCount += 1;
        entry.lastRequestAt = timestamp;
        entry.lastSuccessAt = timestamp;
        entry.lastFailureType = null;
        entry.lastHttpStatus = null;
        entry.lastErrorMessage = null;
        entry.lastNodeUuid = pooluuid || entry.lastNodeUuid || null;
        entry.lastCustomName = customName || entry.lastCustomName || null;

        if (isStream) {
            entry.streamCount += 1;
            entry.streamSuccessCount += 1;
        } else {
            entry.unaryCount += 1;
            entry.unarySuccessCount += 1;
        }

        if (latency !== null) {
            entry.totalLatencyMs += latency;
            entry.lastLatencyMs = latency;
        }

        this._appendRecentAttempt(entry, {
            timestamp,
            success: true,
            isStream,
            durationMs: latency
        });
        this._markDirty();
        this._broadcastUpdate('success', providerType, modelId, entry);
    }

    recordFailure({
        providerType,
        modelId,
        isStream = false,
        durationMs = null,
        errorMessage = '',
        httpStatus = null,
        pooluuid = null,
        customName = null
    } = {}) {
        if (!providerType || !modelId) {
            return;
        }

        const entry = this._ensureEntry(providerType, modelId);
        const timestamp = new Date().toISOString();
        const latency = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : null;
        const normalizedStatus = extractHttpStatus(errorMessage, httpStatus);
        const failureType = classifyModelFailure(errorMessage, {
            isStream,
            httpStatus: normalizedStatus
        });
        const interrupted = failureType === 'stream_interrupted';

        entry.requestCount += 1;
        entry.failureCount += 1;
        entry.lastRequestAt = timestamp;
        entry.lastFailureAt = timestamp;
        entry.lastFailureType = failureType;
        entry.lastHttpStatus = normalizedStatus;
        entry.lastErrorMessage = String(errorMessage || '').trim() || null;
        entry.lastNodeUuid = pooluuid || entry.lastNodeUuid || null;
        entry.lastCustomName = customName || entry.lastCustomName || null;

        if (isStream) {
            entry.streamCount += 1;
            entry.streamFailureCount += 1;
            if (interrupted) {
                entry.streamInterruptedCount += 1;
            }
        } else {
            entry.unaryCount += 1;
            entry.unaryFailureCount += 1;
        }

        if (latency !== null) {
            entry.totalLatencyMs += latency;
            entry.lastLatencyMs = latency;
        }

        if (normalizedStatus === 401) entry.statusCounts['401'] += 1;
        if (normalizedStatus === 403) entry.statusCounts['403'] += 1;
        if (normalizedStatus === 429) entry.statusCounts['429'] += 1;
        if (normalizedStatus !== null && normalizedStatus >= 500 && normalizedStatus <= 599) {
            entry.statusCounts['5xx'] += 1;
        }

        this._appendRecentAttempt(entry, {
            timestamp,
            success: false,
            isStream,
            interrupted,
            durationMs: latency,
            failureType,
            httpStatus: normalizedStatus
        });
        this._markDirty();
        this._broadcastUpdate('failure', providerType, modelId, entry);
    }

    recordAbort({
        providerType,
        modelId,
        isStream = false,
        durationMs = null,
        pooluuid = null,
        customName = null
    } = {}) {
        if (!providerType || !modelId) {
            return;
        }

        const entry = this._ensureEntry(providerType, modelId);
        const timestamp = new Date().toISOString();
        const latency = Number.isFinite(Number(durationMs)) ? Math.max(0, Number(durationMs)) : null;

        entry.requestCount += 1;
        entry.abortedCount += 1;
        entry.lastRequestAt = timestamp;
        entry.lastAbortAt = timestamp;
        entry.lastNodeUuid = pooluuid || entry.lastNodeUuid || null;
        entry.lastCustomName = customName || entry.lastCustomName || null;

        if (isStream) {
            entry.streamCount += 1;
        } else {
            entry.unaryCount += 1;
        }

        if (latency !== null) {
            entry.totalLatencyMs += latency;
            entry.lastLatencyMs = latency;
        }

        this._appendRecentAttempt(entry, {
            timestamp,
            aborted: true,
            isStream,
            durationMs: latency
        });
        this._markDirty();
        this._broadcastUpdate('aborted', providerType, modelId, entry);
    }
}
