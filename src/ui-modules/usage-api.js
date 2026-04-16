import { CONFIG } from '../core/config-manager.js';
import logger from '../utils/logger.js';
import { serviceInstances, getServiceAdapter } from '../providers/adapter.js';
import { formatKiroUsage, formatGeminiUsage, formatAntigravityUsage, formatCodexUsage, formatGrokUsage } from '../services/usage-service.js';
import { readUsageCache, writeUsageCache, readProviderUsageCache, updateProviderUsageCache } from './usage-cache.js';
import { PROVIDER_MAPPINGS } from '../utils/provider-utils.js';
import { isProviderStateSelectable } from '../utils/provider-state.js';
import path from 'path';

const supportedProviders = ['claude-kiro-oauth', 'gemini-cli-oauth', 'gemini-antigravity', 'openai-codex-oauth', 'grok-custom'];
const DEFAULT_USAGE_QUERY_TIMEOUT_MS = 8000;
const DEFAULT_USAGE_QUERY_CONCURRENCY = 4;

export function shouldQueryUsageForProvider(provider = {}) {
    if (provider.isDisabled) {
        return false;
    }

    if (provider.state) {
        return isProviderStateSelectable(provider.state);
    }

    return provider.isHealthy !== false;
}

async function withUsageTimeout(promise, timeoutMs = DEFAULT_USAGE_QUERY_TIMEOUT_MS) {
    let timeoutId = null;

    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Usage query timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            })
        ]);
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

async function runWithConcurrency(items, limit, handler) {
    const results = new Array(items.length);
    let cursor = 0;

    async function worker() {
        while (cursor < items.length) {
            const index = cursor++;
            results[index] = await handler(items[index], index);
        }
    }

    const workerCount = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
}


/**
 * 获取所有支持用量查询的提供商的用量信息
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 所有提供商的用量信息
 */
async function getAllProvidersUsage(currentConfig, providerPoolManager) {
    const results = {
        timestamp: new Date().toISOString(),
        providers: {}
    };

    // 并发获取所有提供商的用量数据
    const usagePromises = supportedProviders.map(async (providerType) => {
        try {
            const providerUsage = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            return { providerType, data: providerUsage, success: true };
        } catch (error) {
            return {
                providerType,
                data: {
                    error: error.message,
                    instances: []
                },
                success: false
            };
        }
    });

    // 等待所有并发请求完成
    const usageResults = await Promise.all(usagePromises);

    // 将结果整合到 results.providers 中
    for (const result of usageResults) {
        results.providers[result.providerType] = result.data;
    }

    return results;
}

/**
 * 获取指定提供商类型的用量信息
 * @param {string} providerType - 提供商类型
 * @param {Object} currentConfig - 当前配置
 * @param {Object} providerPoolManager - 提供商池管理器
 * @returns {Promise<Object>} 提供商用量信息
 */
async function getProviderTypeUsage(providerType, currentConfig, providerPoolManager) {
    const result = {
        providerType,
        instances: [],
        totalCount: 0,
        successCount: 0,
        errorCount: 0
    };

    // 获取提供商池中的所有实例
    let providers = [];
    if (providerPoolManager && providerPoolManager.providerPools && providerPoolManager.providerPools[providerType]) {
        providers = providerPoolManager.providerPools[providerType];
    } else if (currentConfig.providerPools && currentConfig.providerPools[providerType]) {
        providers = currentConfig.providerPools[providerType];
    }

    result.totalCount = providers.length;

    const usageQueryConcurrency = currentConfig.USAGE_QUERY_CONCURRENCY || DEFAULT_USAGE_QUERY_CONCURRENCY;
    const usageQueryTimeoutMs = currentConfig.USAGE_QUERY_TIMEOUT_MS || DEFAULT_USAGE_QUERY_TIMEOUT_MS;

    const instanceResults = await runWithConcurrency(providers, usageQueryConcurrency, async (provider) => {
        const providerKey = providerType + (provider.uuid || '');
        let adapter = serviceInstances[providerKey];
        
        const instanceResult = {
            uuid: provider.uuid || 'unknown',
            name: getProviderDisplayName(provider, providerType),
            configFilePath: getProviderConfigFilePath(provider, providerType),
            isHealthy: provider.isHealthy !== false,
            isDisabled: provider.isDisabled === true,
            success: false,
            usage: null,
            error: null
        };

        if (!shouldQueryUsageForProvider(provider)) {
            instanceResult.error = provider.isDisabled
                ? 'Provider is disabled'
                : `Provider skipped in state: ${provider.state || 'unhealthy'}`;
            return instanceResult;
        }

        if (!adapter) {
            // Service instance not initialized, try auto-initialization
            try {
                logger.info(`[Usage API] Auto-initializing service adapter for ${providerType}: ${provider.uuid}`);
                // Build configuration object
                const serviceConfig = {
                    ...CONFIG,
                    ...provider,
                    MODEL_PROVIDER: providerType
                };
                adapter = getServiceAdapter(serviceConfig);
            } catch (initError) {
                logger.error(`[Usage API] Failed to initialize adapter for ${providerType}: ${provider.uuid}:`, initError.message);
                instanceResult.error = `Service instance initialization failed: ${initError.message}`;
                return instanceResult;
            }
        }
        
        // If adapter exists (including just initialized), and no error, try to get usage
        if (adapter && !instanceResult.error) {
            try {
                const usage = await withUsageTimeout(
                    getAdapterUsage(adapter, providerType),
                    usageQueryTimeoutMs
                );
                instanceResult.success = true;
                instanceResult.usage = usage;
            } catch (error) {
                instanceResult.error = error.message;
            }
        }

        return instanceResult;
    });

    result.instances.push(...instanceResults);
    result.successCount = instanceResults.filter(item => item.success).length;
    result.errorCount = instanceResults.filter(item => !item.success).length;

    return result;
}

/**
 * 从适配器获取用量信息
 * @param {Object} adapter - 服务适配器
 * @param {string} providerType - 提供商类型
 * @returns {Promise<Object>} 用量信息
 */
async function getAdapterUsage(adapter, providerType) {
    if (providerType === 'claude-kiro-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatKiroUsage(rawUsage);
        } else if (adapter.kiroApiService && typeof adapter.kiroApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.kiroApiService.getUsageLimits();
            return formatKiroUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-cli-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        } else if (adapter.geminiApiService && typeof adapter.geminiApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.geminiApiService.getUsageLimits();
            return formatGeminiUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    if (providerType === 'gemini-antigravity') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        } else if (adapter.antigravityApiService && typeof adapter.antigravityApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.antigravityApiService.getUsageLimits();
            return formatAntigravityUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'openai-codex-oauth') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatCodexUsage(rawUsage);
        } else if (adapter.codexApiService && typeof adapter.codexApiService.getUsageLimits === 'function') {
            const rawUsage = await adapter.codexApiService.getUsageLimits();
            return formatCodexUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }

    if (providerType === 'grok-custom') {
        if (typeof adapter.getUsageLimits === 'function') {
            const rawUsage = await adapter.getUsageLimits();
            return formatGrokUsage(rawUsage);
        }
        throw new Error('This adapter does not support usage query');
    }
    
    throw new Error(`Unsupported provider type: ${providerType}`);
}

/**
 * 获取提供商显示名称
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(provider, providerType) {
    // 优先使用自定义名称
    if (provider.customName) {
        return provider.customName;
    }

    if (provider.uuid) {
        return provider.uuid;
    }

    // 尝试从凭据文件路径提取名称
    const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    if (credPathKey && provider[credPathKey]) {
        const filePath = provider[credPathKey];
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        return `${dirName}/${fileName}`;
    }

    return 'Unnamed';
}

/**
 * 获取提供商配置文件路径
 * @param {Object} provider - 提供商配置
 * @param {string} providerType - 提供商类型
 * @returns {string|null} 配置文件路径
 */
function getProviderConfigFilePath(provider, providerType) {
    const mapping = PROVIDER_MAPPINGS.find(m => m.providerType === providerType);
    const credPathKey = mapping ? mapping.credPathKey : null;

    return (credPathKey && provider[credPathKey]) ? provider[credPathKey] : null;
}

/**
 * 获取支持用量查询的提供商列表
 */
export async function handleGetSupportedProviders(req, res) {
    try {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(supportedProviders));
        return true;
    } catch (error) {
        logger.error('[Usage API] Failed to get supported providers:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get supported providers: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取所有提供商的用量限制
 */
export async function handleGetUsage(req, res, currentConfig, providerPoolManager) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // 优先读取缓存
            const cachedData = await readUsageCache();
            if (cachedData) {
                logger.info('[Usage API] Returning cached usage data');
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // 缓存不存在或需要刷新，重新查询
            logger.info('[Usage API] Fetching fresh usage data');
            usageResults = await getAllProvidersUsage(currentConfig, providerPoolManager);
            // 写入缓存
            await writeUsageCache(usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error('[UI API] Failed to get usage:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: 'Failed to get usage info: ' + error.message
            }
        }));
        return true;
    }
}

/**
 * 获取特定提供商类型的用量限制
 */
export async function handleGetProviderUsage(req, res, currentConfig, providerPoolManager, providerType) {
    try {
        // 解析查询参数，检查是否需要强制刷新
        const url = new URL(req.url, `http://${req.headers.host}`);
        const refresh = url.searchParams.get('refresh') === 'true';
        
        let usageResults;
        
        if (!refresh) {
            // Prefer reading from cache
            const cachedData = await readProviderUsageCache(providerType);
            if (cachedData) {
                logger.info(`[Usage API] Returning cached usage data for ${providerType}`);
                usageResults = { ...cachedData, fromCache: true };
            }
        }
        
        if (!usageResults) {
            // Cache does not exist or refresh required, re-query
            logger.info(`[Usage API] Fetching fresh usage data for ${providerType}`);
            usageResults = await getProviderTypeUsage(providerType, currentConfig, providerPoolManager);
            // 更新缓存
            await updateProviderUsageCache(providerType, usageResults);
        }
        
        // Always include current server time
        const finalResults = {
            ...usageResults,
            serverTime: new Date().toISOString()
        };
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(finalResults));
        return true;
    } catch (error) {
        logger.error(`[UI API] Failed to get usage for ${providerType}:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            error: {
                message: `Failed to get usage info for ${providerType}: ` + error.message
            }
        }));
        return true;
    }
}
