import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';

import {
    extractModelIdsFromNativeList,
    getProviderModels,
    normalizeModelIds
} from './provider-models.js';

const CODEX_PLAN_MODELS = {
    free: [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.4',
        'gpt-5.4-mini'
    ],
    plus: [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini'
    ],
    pro: [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.3-codex-spark',
        'gpt-5.4',
        'gpt-5.4-mini'
    ],
    team: [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.4',
        'gpt-5.4-mini'
    ],
    business: [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.4',
        'gpt-5.4-mini'
    ],
    go: [
        'gpt-5',
        'gpt-5-codex',
        'gpt-5-codex-mini',
        'gpt-5.1',
        'gpt-5.1-codex',
        'gpt-5.1-codex-mini',
        'gpt-5.1-codex-max',
        'gpt-5.2',
        'gpt-5.2-codex',
        'gpt-5.3-codex',
        'gpt-5.4',
        'gpt-5.4-mini'
    ]
};

const GROK_MODE_TO_MODEL_MAP = {
    auto: 'grok-4.20',
    fast: 'grok-4.20-fast',
    expert: 'grok-4.20-expert',
    heavy: 'grok-4.20-heavy'
};

function resolveFilePath(filePath) {
    if (!filePath || typeof filePath !== 'string') {
        return null;
    }

    return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function looksLikeJsonPath(value = '') {
    if (typeof value !== 'string') {
        return false;
    }

    const trimmed = value.trim();
    return trimmed.endsWith('.json') || trimmed.includes(path.sep) || trimmed.includes('/');
}

function parseJwtClaims(token) {
    if (!token || typeof token !== 'string') {
        return null;
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
        return null;
    }

    try {
        const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
        return JSON.parse(payload);
    } catch {
        return null;
    }
}

function extractCodexPlanTypeFromClaims(claims) {
    return String(
        claims?.['https://api.openai.com/auth']?.chatgpt_plan_type ||
        claims?.chatgpt_plan_type ||
        ''
    ).trim().toLowerCase();
}

export function getCodexModelsByPlanType(planType = '') {
    const normalizedPlan = String(planType || '').trim().toLowerCase();
    return normalizeModelIds(CODEX_PLAN_MODELS[normalizedPlan] || CODEX_PLAN_MODELS.pro);
}

async function readJsonFile(filePath) {
    if (!filePath) {
        return null;
    }

    const resolvedPath = resolveFilePath(filePath);
    if (!resolvedPath || !existsSync(resolvedPath)) {
        return null;
    }

    try {
        const content = await readFile(resolvedPath, 'utf8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

async function inferCodexModels(providerConfig = {}) {
    const explicitPlanType = String(
        providerConfig.CODEX_PLAN_TYPE ||
        providerConfig.plan_type ||
        ''
    ).trim().toLowerCase();

    if (explicitPlanType) {
        return getCodexModelsByPlanType(explicitPlanType);
    }

    const creds = await readJsonFile(providerConfig.CODEX_OAUTH_CREDS_FILE_PATH);
    if (!creds) {
        return [];
    }

    const filePlanType = String(creds.plan_type || '').trim().toLowerCase();
    if (filePlanType) {
        return getCodexModelsByPlanType(filePlanType);
    }

    const claims = parseJwtClaims(creds.id_token);
    const claimPlanType = extractCodexPlanTypeFromClaims(claims);
    if (claimPlanType) {
        return getCodexModelsByPlanType(claimPlanType);
    }

    return [];
}

function isModeAvailable(mode = {}) {
    const availability = mode?.availability;
    if (!availability || typeof availability !== 'object') {
        return true;
    }
    if (availability.available !== undefined) {
        return true;
    }

    return !(availability.unavailable || availability.requiresUpgrade || availability.comingSoon);
}

function mapGrokModeToModel(mode = {}) {
    const exact = GROK_MODE_TO_MODEL_MAP[String(mode.id || '').trim().toLowerCase()];
    if (exact) {
        return exact;
    }

    const raw = [
        mode.id,
        mode.title,
        mode.description,
        mode.badgeText,
        ...(Array.isArray(mode.tags) ? mode.tags : [])
    ].filter(Boolean).join(' ').toLowerCase();

    if (raw.includes('4.1') && raw.includes('thinking')) {
        return 'grok-4.1-thinking';
    }
    if (raw.includes('4.1') && raw.includes('mini')) {
        return 'grok-4.1-mini';
    }
    if (raw.includes('heavy')) {
        return 'grok-4.20-heavy';
    }
    if (raw.includes('expert')) {
        return 'grok-4.20-expert';
    }
    if (raw.includes('fast')) {
        return 'grok-4.20-fast';
    }
    if (raw.includes('auto') || raw.includes('default')) {
        return 'grok-4.20';
    }

    return null;
}

export function extractGrokModelsFromModesResponse(payload = {}) {
    const modes = Array.isArray(payload?.modes) ? payload.modes : [];
    const models = modes
        .filter(isModeAvailable)
        .map(mapGrokModeToModel)
        .filter(Boolean);

    return normalizeModelIds(models);
}

async function resolveGrokProviderConfig(providerConfig = {}) {
    const rawToken = providerConfig.GROK_COOKIE_TOKEN;
    if (rawToken && looksLikeJsonPath(rawToken)) {
        const fileConfig = await readJsonFile(rawToken);
        if (fileConfig && typeof fileConfig === 'object') {
            return {
                ...providerConfig,
                ...fileConfig
            };
        }
    }

    return providerConfig;
}

async function detectGrokModels(providerConfig = {}) {
    const resolvedConfig = await resolveGrokProviderConfig(providerConfig);
    if (!resolvedConfig.GROK_COOKIE_TOKEN) {
        return [];
    }

    try {
        const { GrokApiService } = await import('./grok/grok-core.js');
        const service = new GrokApiService({
            ...resolvedConfig,
            MODEL_PROVIDER: 'grok-custom'
        });
        const response = await service._request({
            url: `${service.baseUrl}/rest/modes`,
            data: { locale: 'en' },
            timeout: 30000
        });

        return extractGrokModelsFromModesResponse(response?.data);
    } catch {
        return [];
    }
}

export async function detectAvailableModelsForProvider(providerType, tempConfig = {}, options = {}) {
    if (providerType === 'openai-codex-oauth') {
        const codexModels = await inferCodexModels(tempConfig);
        if (codexModels.length > 0) {
            return codexModels;
        }
    }

    if (providerType === 'grok-custom') {
        const grokModels = await detectGrokModels(tempConfig);
        if (grokModels.length > 0) {
            return grokModels;
        }
        return normalizeModelIds(getProviderModels(providerType));
    }

    const serviceInstanceKey = options.instanceKey || `${providerType}${tempConfig.uuid || 'detect-models'}`;
    const serviceInstanceUuid = options.instanceKey
        ? (String(serviceInstanceKey).startsWith(providerType)
            ? String(serviceInstanceKey).slice(providerType.length)
            : String(serviceInstanceKey))
        : (tempConfig.uuid || 'detect-models');
    const adapterConfig = {
        ...tempConfig,
        MODEL_PROVIDER: tempConfig.MODEL_PROVIDER || providerType,
        uuid: serviceInstanceUuid
    };
    let models = [];
    let serviceInstances = null;

    try {
        const adapterModule = await import('./adapter.js');
        const { getServiceAdapter } = adapterModule;
        serviceInstances = adapterModule.serviceInstances;

        delete serviceInstances[serviceInstanceKey];
        const serviceAdapter = getServiceAdapter(adapterConfig);
        if (typeof serviceAdapter.listModels !== 'function') {
            throw new Error(`Provider ${providerType} does not support model detection`);
        }

        const nativeModels = await serviceAdapter.listModels();
        models = extractModelIdsFromNativeList(nativeModels, providerType);
    } finally {
        if (serviceInstances) {
            delete serviceInstances[serviceInstanceKey];
        }
    }

    return normalizeModelIds(models);
}

export async function inferSupportedModelsFromProviderConfig(providerType, providerConfig = {}) {
    if (providerType === 'openai-codex-oauth') {
        const codexModels = await inferCodexModels(providerConfig);
        if (codexModels.length > 0) {
            return codexModels;
        }
    }

    if (providerType === 'grok-custom') {
        const grokModels = await detectGrokModels(providerConfig);
        if (grokModels.length > 0) {
            return grokModels;
        }
        return normalizeModelIds(getProviderModels(providerType));
    }

    try {
        return await detectAvailableModelsForProvider(providerType, {
            ...providerConfig,
            MODEL_PROVIDER: providerType,
            uuid: providerConfig.uuid || `${providerType}-infer-models`
        });
    } catch {
        return [];
    }
}
