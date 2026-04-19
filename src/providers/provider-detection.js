import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';

import {
    extractModelIdsFromNativeList,
    getProviderModels,
    normalizeModelIds
} from './provider-models.js';

const BASE_CODEX_PLAN_MODELS = [
    'gpt-5.2',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini'
];
const CODEX_PRO_PLAN_MODELS = [
    ...BASE_CODEX_PLAN_MODELS,
    'gpt-5.3-codex-spark'
];
const CODEX_PLAN_MODELS = {
    free: BASE_CODEX_PLAN_MODELS,
    plus: BASE_CODEX_PLAN_MODELS,
    pro: CODEX_PRO_PLAN_MODELS,
    team: BASE_CODEX_PLAN_MODELS,
    business: BASE_CODEX_PLAN_MODELS,
    go: BASE_CODEX_PLAN_MODELS
};
const MODEL_SOURCE_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_SOURCE_ERROR_TTL_MS = 5 * 60 * 1000;
const MODEL_SOURCE_FETCH_TIMEOUT_MS = 15000;
const MODEL_SOURCE_FETCH_HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9'
};
const MODEL_SOURCE_CACHE = new Map();
const CODEX_OFFICIAL_MODEL_DOC_URLS = [
    'https://developers.openai.com/codex/models',
    'https://developers.openai.com/api/docs/models/all/'
];
const CODEX_OFFICIAL_MODEL_PATTERN = /\bgpt-5(?:\.\d+)?(?:-mini|-codex(?:-spark)?)?\b/g;
const KIRO_OFFICIAL_MODELS_URL = 'https://kiro.dev/docs/models/';
const KIRO_OFFICIAL_MODEL_PATTERN = /\bClaude\s+(Opus|Sonnet|Haiku)\s+(\d(?:\.\d)?)\b/gi;
const KIRO_DOC_MODEL_ID_MAP = {
    'Opus:4.7': ['claude-opus-4-7'],
    'Opus:4.6': ['claude-opus-4-6'],
    'Opus:4.5': ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
    'Sonnet:4.6': ['claude-sonnet-4-6'],
    'Sonnet:4.5': ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
    'Sonnet:4.0': ['claude-sonnet-4-20250514'],
    'Sonnet:4': ['claude-sonnet-4-20250514'],
    'Haiku:4.5': ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']
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

function getCachedModelSource(cacheKey) {
    const cachedEntry = MODEL_SOURCE_CACHE.get(cacheKey);
    if (!cachedEntry) {
        return null;
    }

    if (cachedEntry.expiresAt <= Date.now()) {
        MODEL_SOURCE_CACHE.delete(cacheKey);
        return null;
    }

    return cachedEntry.models;
}

function setCachedModelSource(cacheKey, models = [], ttlMs = MODEL_SOURCE_CACHE_TTL_MS) {
    MODEL_SOURCE_CACHE.set(cacheKey, {
        models: normalizeModelIds(models),
        expiresAt: Date.now() + ttlMs
    });
}

async function fetchText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_SOURCE_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: MODEL_SOURCE_FETCH_HEADERS,
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await response.text();
    } finally {
        clearTimeout(timeout);
    }
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

function extractModelIdsFromListPayload(payload = {}) {
    if (Array.isArray(payload)) {
        return normalizeModelIds(payload.map(item => item?.id || item?.name || item?.model || item));
    }

    if (Array.isArray(payload?.data)) {
        return normalizeModelIds(payload.data.map(item => item?.id || item?.name || item?.model));
    }

    if (Array.isArray(payload?.models)) {
        return normalizeModelIds(payload.models.map(item => item?.id || item?.name || item?.model || item));
    }

    return [];
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

function extractCodexModelsFromOfficialText(text = '') {
    return normalizeModelIds(text.match(CODEX_OFFICIAL_MODEL_PATTERN) || []);
}

async function detectCodexModelsFromOfficialDocs() {
    const cachedModels = getCachedModelSource('codex:official-docs');
    if (cachedModels) {
        return cachedModels;
    }

    for (const url of CODEX_OFFICIAL_MODEL_DOC_URLS) {
        try {
            const text = await fetchText(url);
            const models = extractCodexModelsFromOfficialText(text);
            if (models.length > 0) {
                setCachedModelSource('codex:official-docs', models);
                return models;
            }
        } catch {
            // Fallback to plan inference or builtin seeds below.
        }
    }

    setCachedModelSource('codex:official-docs', [], MODEL_SOURCE_ERROR_TTL_MS);
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

function extractKiroModelsFromOfficialText(text = '') {
    const models = [];

    for (const match of text.matchAll(KIRO_OFFICIAL_MODEL_PATTERN)) {
        const family = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
        const version = match[2];
        models.push(...(KIRO_DOC_MODEL_ID_MAP[`${family}:${version}`] || []));
    }

    return normalizeModelIds(models);
}

async function detectKiroModelsFromOfficialDocs() {
    const cachedModels = getCachedModelSource('kiro:official-docs');
    if (cachedModels) {
        return cachedModels;
    }

    try {
        const text = await fetchText(KIRO_OFFICIAL_MODELS_URL);
        const models = extractKiroModelsFromOfficialText(text);
        if (models.length > 0) {
            setCachedModelSource('kiro:official-docs', models);
            return models;
        }
    } catch {
        // Fallback to builtin seeds below.
    }

    setCachedModelSource('kiro:official-docs', [], MODEL_SOURCE_ERROR_TTL_MS);
    return [];
}

async function detectQwenModels(providerConfig = {}) {
    try {
        const { QwenApiService } = await import('./openai/qwen-core.js');
        const service = new QwenApiService({
            ...providerConfig,
            MODEL_PROVIDER: 'openai-qwen-oauth'
        });
        const response = await service.listModels();
        return extractModelIdsFromListPayload(response);
    } catch {
        return [];
    }
}

export async function detectAvailableModelsForProvider(providerType, tempConfig = {}, options = {}) {
    if (providerType === 'openai-codex-oauth') {
        const officialCodexModels = await detectCodexModelsFromOfficialDocs();
        if (officialCodexModels.length > 0) {
            const inferredCodexModels = await inferCodexModels(tempConfig);
            if (inferredCodexModels.length > 0) {
                const planFilteredModels = officialCodexModels.filter(model => inferredCodexModels.includes(model));
                if (planFilteredModels.length > 0) {
                    return planFilteredModels;
                }
            }

            return officialCodexModels;
        }

        const codexModels = await inferCodexModels(tempConfig);
        if (codexModels.length > 0) {
            return codexModels;
        }

        return normalizeModelIds(getProviderModels(providerType));
    }

    if (providerType === 'openai-qwen-oauth') {
        const qwenModels = await detectQwenModels(tempConfig);
        if (qwenModels.length > 0) {
            return qwenModels;
        }

        return normalizeModelIds(getProviderModels(providerType));
    }

    if (providerType === 'claude-kiro-oauth') {
        const kiroModels = await detectKiroModelsFromOfficialDocs();
        if (kiroModels.length > 0) {
            return kiroModels;
        }

        return normalizeModelIds(getProviderModels(providerType));
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
