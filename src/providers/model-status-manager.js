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

const STATUS_STORE_VERSION = 2;
const DEFAULT_PERSIST_INTERVAL_MS = 10 * 1000;
const DEFAULT_RECENT_WINDOW_SIZE = 20;
const MAX_RECENT_WINDOW_SIZE = 50;
const DEFAULT_TIMELINE_WINDOW_HOURS = 24;
const MAX_TIMELINE_WINDOW_HOURS = 7 * 24;
const DEFAULT_TIMELINE_BUCKET_MINUTES = 60;
const MAX_TIMELINE_BUCKET_MINUTES = 24 * 60;

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

function createUsageMetrics() {
    return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0
    };
}

function normalizeUsageMetrics(usage = {}) {
    return {
        promptTokens: Number(usage?.promptTokens || 0),
        completionTokens: Number(usage?.completionTokens || 0),
        totalTokens: Number(usage?.totalTokens || 0),
        cachedTokens: Number(usage?.cachedTokens || 0)
    };
}

function mergeUsageMetrics(baseUsage = {}, nextUsage = {}) {
    const base = normalizeUsageMetrics(baseUsage);
    const next = normalizeUsageMetrics(nextUsage);

    return {
        promptTokens: base.promptTokens + next.promptTokens,
        completionTokens: base.completionTokens + next.completionTokens,
        totalTokens: base.totalTokens + next.totalTokens,
        cachedTokens: base.cachedTokens + next.cachedTokens
    };
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
        ...createUsageMetrics(),
        statusCounts: {
            '401': 0,
            '403': 0,
            '429': 0,
            '5xx': 0
        },
        recentAttempts: [],
        timelineBuckets: {}
    };
}

function normalizeRecentAttempt(attempt = {}) {
    const httpStatus = Number.parseInt(attempt.httpStatus, 10);
    const durationMs = Number.isFinite(Number(attempt.durationMs)) ? Math.max(0, Number(attempt.durationMs)) : null;
    const usage = normalizeUsageMetrics(attempt);

    return {
        timestamp: attempt.timestamp || null,
        success: attempt.success === true,
        aborted: attempt.aborted === true,
        isStream: attempt.isStream === true,
        interrupted: attempt.interrupted === true,
        durationMs,
        failureType: attempt.failureType || null,
        httpStatus: Number.isInteger(httpStatus) ? httpStatus : null,
        ...usage
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
        ...createUsageMetrics(),
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

        summary.promptTokens += Number(attempt.promptTokens || 0);
        summary.completionTokens += Number(attempt.completionTokens || 0);
        summary.totalTokens += Number(attempt.totalTokens || 0);
        summary.cachedTokens += Number(attempt.cachedTokens || 0);

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

function createEmptyTimelineBucket(startedAt = null, endedAt = null) {
    return {
        startedAt,
        endedAt,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        abortedCount: 0,
        streamInterruptedCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: null,
        successRate: null,
        lastFailureType: null,
        lastHttpStatus: null,
        ...createUsageMetrics(),
        httpStatusCounts: {
            '401': 0,
            '403': 0,
            '429': 0,
            '5xx': 0
        },
        grade: 'no_data'
    };
}

function deriveTimelineBucketGrade(bucket = {}) {
    const successCount = Number(bucket.successCount || 0);
    const failureCount = Number(bucket.failureCount || 0);
    const totalCount = successCount + failureCount;
    if (totalCount === 0) {
        return 'no_data';
    }

    const successRate = totalCount > 0 ? successCount / totalCount : 0;
    const hasAuthFailures = Number(bucket?.httpStatusCounts?.['401'] || 0) > 0 || Number(bucket?.httpStatusCounts?.['403'] || 0) > 0;
    const hasRateLimits = Number(bucket?.httpStatusCounts?.['429'] || 0) > 0;
    const hasServerFailures = Number(bucket?.httpStatusCounts?.['5xx'] || 0) > 0;
    const hasStreamInterruptions = Number(bucket.streamInterruptedCount || 0) > 0;

    if ((hasAuthFailures && successRate < 0.8) || successRate < 0.2) {
        return 'error';
    }

    if (successRate < 0.6 || (hasServerFailures && successRate < 0.8)) {
        return 'poor';
    }

    if (successRate < 0.8 || hasRateLimits || hasStreamInterruptions) {
        return 'fair';
    }

    if (successRate < 0.95) {
        return 'good';
    }

    return 'excellent';
}

function normalizeTimelineBucket(bucket = {}, startedAt = null, endedAt = null) {
    const normalized = {
        ...createEmptyTimelineBucket(startedAt, endedAt),
        ...bucket,
        startedAt: bucket.startedAt || startedAt,
        endedAt: bucket.endedAt || endedAt,
        requestCount: Number(bucket.requestCount || 0),
        successCount: Number(bucket.successCount || 0),
        failureCount: Number(bucket.failureCount || 0),
        abortedCount: Number(bucket.abortedCount || 0),
        streamInterruptedCount: Number(bucket.streamInterruptedCount || 0),
        totalLatencyMs: Number(bucket.totalLatencyMs || 0),
        lastFailureType: bucket.lastFailureType || null,
        lastHttpStatus: Number.isInteger(Number(bucket.lastHttpStatus)) ? Number(bucket.lastHttpStatus) : null,
        ...normalizeUsageMetrics(bucket),
        httpStatusCounts: {
            '401': Number(bucket?.httpStatusCounts?.['401'] || 0),
            '403': Number(bucket?.httpStatusCounts?.['403'] || 0),
            '429': Number(bucket?.httpStatusCounts?.['429'] || 0),
            '5xx': Number(bucket?.httpStatusCounts?.['5xx'] || 0)
        }
    };

    const effectiveTotal = normalized.successCount + normalized.failureCount;
    normalized.avgLatencyMs = normalized.requestCount > 0
        ? Math.round(normalized.totalLatencyMs / Math.max(1, normalized.requestCount))
        : null;
    normalized.successRate = effectiveTotal > 0
        ? Number((normalized.successCount / effectiveTotal).toFixed(4))
        : null;
    normalized.grade = deriveTimelineBucketGrade(normalized);

    return normalized;
}

function updateTimelineBucketAttempt(bucket = {}, attempt = {}) {
    const normalizedAttempt = normalizeRecentAttempt(attempt);

    bucket.requestCount += 1;
    if (normalizedAttempt.aborted) {
        bucket.abortedCount += 1;
    } else if (normalizedAttempt.success) {
        bucket.successCount += 1;
    } else {
        bucket.failureCount += 1;
        bucket.lastFailureType = normalizedAttempt.failureType || bucket.lastFailureType || null;
        bucket.lastHttpStatus = normalizedAttempt.httpStatus ?? bucket.lastHttpStatus ?? null;
    }

    if (normalizedAttempt.interrupted) {
        bucket.streamInterruptedCount += 1;
    }

    if (normalizedAttempt.httpStatus === 401) bucket.httpStatusCounts['401'] += 1;
    if (normalizedAttempt.httpStatus === 403) bucket.httpStatusCounts['403'] += 1;
    if (normalizedAttempt.httpStatus === 429) bucket.httpStatusCounts['429'] += 1;
    if (normalizedAttempt.httpStatus !== null && normalizedAttempt.httpStatus >= 500 && normalizedAttempt.httpStatus <= 599) {
        bucket.httpStatusCounts['5xx'] += 1;
    }

    bucket.totalLatencyMs += Number(normalizedAttempt.durationMs || 0);
    const usage = normalizeUsageMetrics(normalizedAttempt);
    bucket.promptTokens += usage.promptTokens;
    bucket.completionTokens += usage.completionTokens;
    bucket.totalTokens += usage.totalTokens;
    bucket.cachedTokens += usage.cachedTokens;

    return normalizeTimelineBucket(bucket);
}

function pruneTimelineBuckets(rawBuckets = {}, {
    bucketMinutes = DEFAULT_TIMELINE_BUCKET_MINUTES,
    windowHours = DEFAULT_TIMELINE_WINDOW_HOURS,
    now = Date.now()
} = {}) {
    const bucketMs = bucketMinutes * 60 * 1000;
    const totalBuckets = Math.max(1, Math.ceil(windowHours * 60 / bucketMinutes));
    const currentBucketStart = Math.floor(now / bucketMs) * bucketMs;
    const earliestBucketStart = currentBucketStart - ((totalBuckets - 1) * bucketMs);

    return Object.fromEntries(
        Object.entries(rawBuckets || {}).filter(([bucketKey]) => {
            const bucketStart = Number(bucketKey);
            return Number.isFinite(bucketStart) && bucketStart >= earliestBucketStart && bucketStart <= currentBucketStart;
        })
    );
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

function normalizeEntry(
    providerType,
    modelId,
    entry = {},
    recentWindowSize = DEFAULT_RECENT_WINDOW_SIZE,
    {
        timelineBucketMinutes = DEFAULT_TIMELINE_BUCKET_MINUTES,
        timelineWindowHours = DEFAULT_TIMELINE_WINDOW_HOURS
    } = {}
) {
    const prunedTimelineBuckets = pruneTimelineBuckets(entry.timelineBuckets, {
        bucketMinutes: timelineBucketMinutes,
        windowHours: timelineWindowHours
    });
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
        ...normalizeUsageMetrics(entry),
        statusCounts: {
            '401': Number(entry?.statusCounts?.['401'] || 0),
            '403': Number(entry?.statusCounts?.['403'] || 0),
            '429': Number(entry?.statusCounts?.['429'] || 0),
            '5xx': Number(entry?.statusCounts?.['5xx'] || 0)
        },
        recentAttempts: Array.isArray(entry.recentAttempts)
            ? entry.recentAttempts.slice(-recentWindowSize).map(normalizeRecentAttempt)
            : [],
        timelineBuckets: Object.fromEntries(
            Object.entries(prunedTimelineBuckets).map(([bucketKey, bucketValue]) => [
                bucketKey,
                normalizeTimelineBucket(bucketValue)
            ])
        )
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

function buildTimelineSummary(timeline = []) {
    const summary = {
        bucketCount: Array.isArray(timeline) ? timeline.length : 0,
        activeBucketCount: 0,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        abortedCount: 0,
        streamInterruptedCount: 0,
        avgLatencyMs: null,
        successRate: null,
        grade: 'no_data',
        ...createUsageMetrics(),
        httpStatusCounts: {
            '401': 0,
            '403': 0,
            '429': 0,
            '5xx': 0
        }
    };

    let totalLatencyMs = 0;

    (Array.isArray(timeline) ? timeline : []).forEach(bucket => {
        summary.requestCount += Number(bucket.requestCount || 0);
        summary.successCount += Number(bucket.successCount || 0);
        summary.failureCount += Number(bucket.failureCount || 0);
        summary.abortedCount += Number(bucket.abortedCount || 0);
        summary.streamInterruptedCount += Number(bucket.streamInterruptedCount || 0);
        summary.promptTokens += Number(bucket.promptTokens || 0);
        summary.completionTokens += Number(bucket.completionTokens || 0);
        summary.totalTokens += Number(bucket.totalTokens || 0);
        summary.cachedTokens += Number(bucket.cachedTokens || 0);
        summary.httpStatusCounts['401'] += Number(bucket?.httpStatusCounts?.['401'] || 0);
        summary.httpStatusCounts['403'] += Number(bucket?.httpStatusCounts?.['403'] || 0);
        summary.httpStatusCounts['429'] += Number(bucket?.httpStatusCounts?.['429'] || 0);
        summary.httpStatusCounts['5xx'] += Number(bucket?.httpStatusCounts?.['5xx'] || 0);
        totalLatencyMs += Number(bucket.totalLatencyMs || 0);

        if (Number(bucket.requestCount || 0) > 0) {
            summary.activeBucketCount += 1;
        }
    });

    const effectiveTotal = summary.successCount + summary.failureCount;
    summary.avgLatencyMs = summary.requestCount > 0
        ? Math.round(totalLatencyMs / Math.max(1, summary.requestCount))
        : null;
    summary.successRate = effectiveTotal > 0
        ? Number((summary.successCount / effectiveTotal).toFixed(4))
        : null;
    summary.grade = deriveTimelineBucketGrade(summary);

    return summary;
}

function buildTimeline(entry = {}, {
    bucketMinutes = DEFAULT_TIMELINE_BUCKET_MINUTES,
    windowHours = DEFAULT_TIMELINE_WINDOW_HOURS,
    now = Date.now()
} = {}) {
    const bucketMs = bucketMinutes * 60 * 1000;
    const totalBuckets = Math.max(1, Math.ceil(windowHours * 60 / bucketMinutes));
    const currentBucketStart = Math.floor(now / bucketMs) * bucketMs;
    const earliestBucketStart = currentBucketStart - ((totalBuckets - 1) * bucketMs);
    const timeline = [];

    for (let index = 0; index < totalBuckets; index += 1) {
        const bucketStart = earliestBucketStart + (index * bucketMs);
        const bucketEnd = bucketStart + bucketMs;
        const bucketKey = String(bucketStart);
        const normalizedBucket = normalizeTimelineBucket(
            entry?.timelineBuckets?.[bucketKey],
            new Date(bucketStart).toISOString(),
            new Date(bucketEnd).toISOString()
        );

        timeline.push({
            id: bucketKey,
            index,
            startedAt: normalizedBucket.startedAt,
            endedAt: normalizedBucket.endedAt,
            isCurrent: bucketStart === currentBucketStart,
            ...normalizedBucket
        });
    }

    return timeline;
}

function buildProviderDashboardSummary(items = []) {
    const summary = {
        totalModels: items.length,
        activeModels: 0,
        excellentCount: 0,
        goodCount: 0,
        fairCount: 0,
        poorCount: 0,
        errorCount: 0,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        abortedCount: 0,
        streamInterruptedCount: 0,
        avgLatencyMs: null,
        successRate: null,
        highQualityCount: 0,
        ...createUsageMetrics(),
        httpStatusCounts: {
            '401': 0,
            '403': 0,
            '429': 0,
            '5xx': 0
        }
    };

    let totalLatencyMs = 0;

    items.forEach(item => {
        const timelineSummary = item.timelineSummary || {};
        const grade = String(timelineSummary.grade || 'no_data');
        summary.requestCount += Number(timelineSummary.requestCount || 0);
        summary.successCount += Number(timelineSummary.successCount || 0);
        summary.failureCount += Number(timelineSummary.failureCount || 0);
        summary.abortedCount += Number(timelineSummary.abortedCount || 0);
        summary.streamInterruptedCount += Number(timelineSummary.streamInterruptedCount || 0);
        summary.promptTokens += Number(timelineSummary.promptTokens || 0);
        summary.completionTokens += Number(timelineSummary.completionTokens || 0);
        summary.totalTokens += Number(timelineSummary.totalTokens || 0);
        summary.cachedTokens += Number(timelineSummary.cachedTokens || 0);
        summary.httpStatusCounts['401'] += Number(timelineSummary?.httpStatusCounts?.['401'] || 0);
        summary.httpStatusCounts['403'] += Number(timelineSummary?.httpStatusCounts?.['403'] || 0);
        summary.httpStatusCounts['429'] += Number(timelineSummary?.httpStatusCounts?.['429'] || 0);
        summary.httpStatusCounts['5xx'] += Number(timelineSummary?.httpStatusCounts?.['5xx'] || 0);
        totalLatencyMs += Number(timelineSummary.avgLatencyMs || 0) * Number(timelineSummary.requestCount || 0);

        if (Number(timelineSummary.requestCount || 0) > 0) {
            summary.activeModels += 1;
        }

        if (grade === 'excellent') summary.excellentCount += 1;
        else if (grade === 'good') summary.goodCount += 1;
        else if (grade === 'fair') summary.fairCount += 1;
        else if (grade === 'poor') summary.poorCount += 1;
        else if (grade === 'error') summary.errorCount += 1;
    });

    summary.highQualityCount = summary.excellentCount + summary.goodCount;

    const effectiveTotal = summary.successCount + summary.failureCount;
    summary.avgLatencyMs = summary.requestCount > 0
        ? Math.round(totalLatencyMs / Math.max(1, summary.requestCount))
        : null;
    summary.successRate = effectiveTotal > 0
        ? Number((summary.successCount / effectiveTotal).toFixed(4))
        : null;

    return summary;
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
        ...createUsageMetrics(),
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
        summary.promptTokens += Number(item.promptTokens || 0);
        summary.completionTokens += Number(item.completionTokens || 0);
        summary.totalTokens += Number(item.totalTokens || 0);
        summary.cachedTokens += Number(item.cachedTokens || 0);
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

    getTimelineWindowHours() {
        return clampInteger(
            this.globalConfig?.MODEL_STATUS_TIMELINE_WINDOW_HOURS,
            DEFAULT_TIMELINE_WINDOW_HOURS,
            { min: 1, max: MAX_TIMELINE_WINDOW_HOURS }
        );
    }

    getTimelineBucketMinutes() {
        return clampInteger(
            this.globalConfig?.MODEL_STATUS_TIMELINE_BUCKET_MINUTES,
            DEFAULT_TIMELINE_BUCKET_MINUTES,
            { min: 5, max: MAX_TIMELINE_BUCKET_MINUTES }
        );
    }

    _getTimelineOptions(now = Date.now()) {
        return {
            timelineWindowHours: this.getTimelineWindowHours(),
            timelineBucketMinutes: this.getTimelineBucketMinutes(),
            now
        };
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
            const timelineOptions = this._getTimelineOptions();
            const providers = {};

            Object.entries(payload?.providers || {}).forEach(([providerType, models]) => {
                providers[providerType] = {};
                Object.entries(models || {}).forEach(([modelId, entry]) => {
                    providers[providerType][modelId] = normalizeEntry(providerType, modelId, entry, recentWindowSize, timelineOptions);
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
        const timelineOptions = this._getTimelineOptions();
        const existing = this.store.providers[providerType][modelId];
        const normalized = normalizeEntry(
            providerType,
            modelId,
            existing || createEmptyEntry(providerType, modelId),
            recentWindowSize,
            timelineOptions
        );
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

    _appendTimelineAttempt(entry, attempt) {
        const timelineOptions = this._getTimelineOptions();
        const bucketMinutes = timelineOptions.timelineBucketMinutes;
        const bucketMs = bucketMinutes * 60 * 1000;
        const attemptTimestamp = Date.parse(attempt?.timestamp || '');
        const effectiveTimestamp = Number.isFinite(attemptTimestamp) ? attemptTimestamp : Date.now();
        const bucketStartMs = Math.floor(effectiveTimestamp / bucketMs) * bucketMs;
        const bucketKey = String(bucketStartMs);
        const existingBucket = normalizeTimelineBucket(
            entry.timelineBuckets?.[bucketKey],
            new Date(bucketStartMs).toISOString(),
            new Date(bucketStartMs + bucketMs).toISOString()
        );
        const updatedBucket = updateTimelineBucketAttempt(existingBucket, attempt);

        entry.timelineBuckets = pruneTimelineBuckets({
            ...(entry.timelineBuckets || {}),
            [bucketKey]: updatedBucket
        }, {
            bucketMinutes,
            windowHours: timelineOptions.timelineWindowHours,
            now: effectiveTimestamp
        });
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
        const timelineOptions = this._getTimelineOptions();
        const entry = normalizeEntry(
            providerType,
            modelId,
            this.store?.providers?.[providerType]?.[modelId] || {},
            this.getRecentWindowSize(),
            timelineOptions
        );
        const timeline = buildTimeline(entry, {
            bucketMinutes: timelineOptions.timelineBucketMinutes,
            windowHours: timelineOptions.timelineWindowHours
        });
        const timelineSummary = buildTimelineSummary(timeline);
        const catalogEntry = this.providerCatalogManager?.getProviderEntry(providerType) || null;
        return {
            ...entry,
            timeline,
            timelineSummary,
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

                    const leftRequests = Number(left.timelineSummary?.requestCount || left.requestCount || 0);
                    const rightRequests = Number(right.timelineSummary?.requestCount || right.requestCount || 0);
                    if (leftRequests !== rightRequests) {
                        return rightRequests - leftRequests;
                    }

                    return String(left.modelId || '').localeCompare(String(right.modelId || ''));
                });

            providers[providerType] = {
                providerType,
                summary: buildProviderSummary(items),
                dashboardSummary: buildProviderDashboardSummary(items),
                items,
                byModel: Object.fromEntries(items.map(item => [item.modelId, item]))
            };
        });

        return {
            version: this.store?.version || STATUS_STORE_VERSION,
            updatedAt: this.store?.updatedAt || null,
            recentWindowSize: this.getRecentWindowSize(),
            timelineWindowHours: this.getTimelineWindowHours(),
            timelineBucketMinutes: this.getTimelineBucketMinutes(),
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
        customName = null,
        usage = null
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
        Object.assign(entry, mergeUsageMetrics(entry, usage));

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
            durationMs: latency,
            ...normalizeUsageMetrics(usage)
        });
        this._appendTimelineAttempt(entry, {
            timestamp,
            success: true,
            isStream,
            durationMs: latency,
            ...normalizeUsageMetrics(usage)
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
        customName = null,
        usage = null
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
        Object.assign(entry, mergeUsageMetrics(entry, usage));

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
            httpStatus: normalizedStatus,
            ...normalizeUsageMetrics(usage)
        });
        this._appendTimelineAttempt(entry, {
            timestamp,
            success: false,
            isStream,
            interrupted,
            durationMs: latency,
            failureType,
            httpStatus: normalizedStatus,
            ...normalizeUsageMetrics(usage)
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
        customName = null,
        usage = null
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
        Object.assign(entry, mergeUsageMetrics(entry, usage));

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
            durationMs: latency,
            ...normalizeUsageMetrics(usage)
        });
        this._appendTimelineAttempt(entry, {
            timestamp,
            aborted: true,
            isStream,
            durationMs: latency,
            ...normalizeUsageMetrics(usage)
        });
        this._markDirty();
        this._broadcastUpdate('aborted', providerType, modelId, entry);
    }
}
