export const PROVIDER_STATES = Object.freeze({
    HEALTHY: 'healthy',
    COOLDOWN: 'cooldown',
    RISKY: 'risky',
    BANNED: 'banned',
    DISABLED: 'disabled'
});

const VALID_PROVIDER_STATES = new Set(Object.values(PROVIDER_STATES));

export function normalizeProviderState(state, fallback = PROVIDER_STATES.HEALTHY) {
    return VALID_PROVIDER_STATES.has(state) ? state : fallback;
}

export function classifyProviderFailure(errorMessage = '') {
    const message = String(errorMessage || '').trim();
    if (!message) {
        return null;
    }

    if (
        (/\b429\b/.test(message) || /rate limit|too many requests|quota/i.test(message)) &&
        !/please re-authenticate/i.test(message)
    ) {
        return 'rate_limit';
    }

    if (
        /\b(401|403)\b/.test(message) ||
        /\b(Unauthorized|Forbidden|AccessDenied|InvalidToken|ExpiredToken)\b/i.test(message) ||
        /please re-authenticate/i.test(message)
    ) {
        return 'auth';
    }

    if (
        /\b(500|502|503|504)\b/.test(message) ||
        /bad gateway|service unavailable|internal server error|gateway timeout/i.test(message)
    ) {
        return 'upstream';
    }

    if (
        /timeout|timed out|network|econnreset|socket hang up|fetch failed|connection reset/i.test(message)
    ) {
        return 'network';
    }

    return 'unknown';
}

export function getProviderStateScore(state, config = {}) {
    const normalizedState = normalizeProviderState(state);
    const baseScoreMap = {
        [PROVIDER_STATES.HEALTHY]: 100,
        [PROVIDER_STATES.RISKY]: 60,
        [PROVIDER_STATES.COOLDOWN]: 0,
        [PROVIDER_STATES.BANNED]: 0,
        [PROVIDER_STATES.DISABLED]: 0
    };

    const consecutiveFailures = Number(config.consecutiveFailures || 0);
    const usagePenalty = Math.min(Number(config.usageCount || 0), 50);
    const failurePenalty = Math.min(consecutiveFailures * 5, 30);

    return Math.max(0, (baseScoreMap[normalizedState] || 0) - failurePenalty - usagePenalty);
}

export function isProviderStateSelectable(state) {
    const normalizedState = normalizeProviderState(state);
    return normalizedState === PROVIDER_STATES.HEALTHY || normalizedState === PROVIDER_STATES.RISKY;
}

export function getCooldownUntil(now = Date.now(), cooldownMs = 15 * 60 * 1000) {
    return new Date(now + cooldownMs).toISOString();
}

export function inferProviderStateFromConfig(config = {}, now = Date.now()) {
    if (config.isDisabled) {
        return PROVIDER_STATES.DISABLED;
    }

    const persistedState = normalizeProviderState(config.state, null);
    if (persistedState) {
        if (persistedState === PROVIDER_STATES.COOLDOWN && config.cooldownUntil) {
            const cooldownUntil = new Date(config.cooldownUntil).getTime();
            if (Number.isFinite(cooldownUntil) && cooldownUntil <= now) {
                return PROVIDER_STATES.HEALTHY;
            }
        }
        return persistedState;
    }

    const failureType = classifyProviderFailure(config.lastErrorMessage || '');
    if (failureType === 'auth') {
        return PROVIDER_STATES.BANNED;
    }
    if (failureType === 'rate_limit') {
        return PROVIDER_STATES.COOLDOWN;
    }

    if (config.isHealthy === false) {
        return PROVIDER_STATES.RISKY;
    }

    return PROVIDER_STATES.HEALTHY;
}
