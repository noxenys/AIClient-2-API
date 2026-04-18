function fallbackTranslate(key, params = {}) {
    if (!params || typeof params !== 'object') {
        return key;
    }

    return String(key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
}

function fallbackFormatDateTime(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function fallbackFormatDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration) || duration < 0) {
        return '';
    }

    if (duration < 1000) {
        return `${duration} ms`;
    }

    const totalSeconds = Math.round(duration / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];

    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0) {
        parts.push(`${minutes}m`);
    }
    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds}s`);
    }

    return parts.join(' ');
}

function translateLabel(t, key, fallback, params = {}) {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
}

export function getProviderRuntimeState(provider = {}) {
    if (provider.state) return provider.state;
    if (provider.isDisabled) return 'disabled';
    if (provider.isHealthy) return 'healthy';
    return 'risky';
}

export function getProviderRuntimeMetaItems(provider = {}, {
    t = fallbackTranslate,
    formatDateTime = fallbackFormatDateTime,
    formatDuration = fallbackFormatDuration
} = {}) {
    const state = getProviderRuntimeState(provider);
    const items = [];
    const seenKeys = new Set();
    const pushItem = (key, label, value) => {
        if (seenKeys.has(key)) {
            return;
        }
        if (value === null || value === undefined || value === '') {
            return;
        }

        seenKeys.add(key);
        items.push({
            key,
            label,
            value: String(value)
        });
    };

    if (state === 'cooldown' && provider.cooldownUntil) {
        pushItem(
            'cooldownUntil',
            translateLabel(t, 'modal.provider.cooldownUntil', 'Cooldown until'),
            formatDateTime(provider.cooldownUntil)
        );
    }

    if (provider.cooldownRemainingMs !== null && provider.cooldownRemainingMs !== undefined) {
        pushItem(
            'cooldownRemaining',
            translateLabel(t, 'modal.provider.cooldownRemaining', 'Cooldown remaining'),
            formatDuration(provider.cooldownRemainingMs)
        );
    }

    if (provider.recoveryTime && provider.recoveryTime !== provider.cooldownUntil) {
        pushItem(
            'recoveryTime',
            translateLabel(t, 'modal.provider.recoveryTime', 'Recovery time'),
            formatDateTime(provider.recoveryTime)
        );
    }

    if (provider.stateScore !== null && provider.stateScore !== undefined) {
        pushItem(
            'stateScore',
            translateLabel(t, 'modal.provider.stateScore', 'State score'),
            provider.stateScore
        );
    }

    if (provider.schedulerScore !== null && provider.schedulerScore !== undefined) {
        pushItem(
            'schedulerScore',
            translateLabel(t, 'modal.provider.schedulerScore', 'Scheduler score'),
            provider.schedulerScore
        );
    }

    if (provider.schedulerRank !== null && provider.schedulerRank !== undefined) {
        pushItem(
            'schedulerRank',
            translateLabel(t, 'modal.provider.schedulerRank', 'Scheduler rank'),
            provider.schedulerRank
        );
    }

    if (provider.selectableRank !== null && provider.selectableRank !== undefined) {
        pushItem(
            'selectableRank',
            translateLabel(t, 'modal.provider.selectableRank', 'Selectable rank'),
            provider.selectableRank
        );
    }

    if (provider.schedulerDecision) {
        pushItem(
            'schedulerDecision',
            translateLabel(t, 'modal.provider.schedulerDecision', 'Scheduler decision'),
            provider.schedulerDecision
        );
    }

    if (provider.schedulerDecisionReason) {
        pushItem(
            'schedulerDecisionReason',
            translateLabel(t, 'modal.provider.schedulerDecisionReason', 'Decision reason'),
            provider.schedulerDecisionReason
        );
    }

    if (provider.schedulerPenaltySummary || (Array.isArray(provider.schedulerPenaltyBreakdown) && provider.schedulerPenaltyBreakdown.length > 0)) {
        const penaltyText = provider.schedulerPenaltySummary || provider.schedulerPenaltyBreakdown
            .map(item => `${item.label}: ${item.value}`)
            .join(' | ');
        pushItem(
            'schedulerPenalty',
            translateLabel(t, 'modal.provider.schedulerPenalty', 'Penalty'),
            penaltyText
        );
    }

    if (provider.recentHttpStatus) {
        pushItem(
            'recentHttpStatus',
            translateLabel(t, 'modal.provider.recentHttpStatus', 'Recent HTTP'),
            `HTTP ${provider.recentHttpStatus}`
        );
    }

    if (provider.recentFailureType) {
        pushItem(
            'recentFailureType',
            translateLabel(t, 'modal.provider.recentFailureType', 'Recent failure'),
            provider.recentFailureType
        );
    }

    if (provider.supportedModelsSource) {
        pushItem(
            'supportedModelsSource',
            translateLabel(t, 'modal.provider.supportedModelsSource', 'Model source'),
            provider.supportedModelsSource
        );
    }

    if (provider.supportedModelsUpdatedAt) {
        pushItem(
            'supportedModelsUpdatedAt',
            translateLabel(t, 'modal.provider.supportedModelsUpdatedAt', 'Model detected at'),
            formatDateTime(provider.supportedModelsUpdatedAt)
        );
    }

    if (provider.supportedModelsDetectionError) {
        pushItem(
            'supportedModelsDetectionError',
            translateLabel(t, 'modal.provider.supportedModelsDetectionError', 'Model detection error'),
            provider.supportedModelsDetectionError
        );
    }

    if (Number(provider.consecutiveFailures || 0) > 0) {
        pushItem(
            'consecutiveFailures',
            translateLabel(t, 'modal.provider.consecutiveFailures', 'Consecutive failures'),
            provider.consecutiveFailures
        );
    }

    if (Number(provider.activeRequests || 0) > 0 || Number(provider.waitingRequests || 0) > 0) {
        pushItem(
            'requestLoad',
            translateLabel(t, 'modal.provider.requestLoad', 'Request load'),
            `${Number(provider.activeRequests || 0)} active / ${Number(provider.waitingRequests || 0)} waiting`
        );
    }

    if (provider.lastStateReason) {
        pushItem(
            'reason',
            translateLabel(t, 'modal.provider.runtimeReason', 'State reason'),
            provider.lastStateReason
        );
    }

    return items;
}

export function getProviderRuntimeMetaText(provider = {}, options = {}) {
    return getProviderRuntimeMetaItems(provider, options)
        .map(item => `${item.label}: ${item.value}`)
        .join(' | ');
}

export function getProviderSummaryCooldownText(summary = {}, {
    t = fallbackTranslate,
    formatDateTime = fallbackFormatDateTime
} = {}) {
    const cooldownCount = Number(summary.cooldownCount || 0);
    if (!Number.isFinite(cooldownCount) || cooldownCount <= 0) {
        return '';
    }

    const summaryText = t('providers.cooldown.summary', { count: cooldownCount });
    if (!summary.nextCooldownUntil) {
        return summaryText;
    }

    return `${summaryText} · ${t('providers.cooldown.nextRecovery')}: ${formatDateTime(summary.nextCooldownUntil)}`;
}
