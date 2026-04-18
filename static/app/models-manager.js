/**
 * Models Manager - 管理可用模型列表的显示和复制功能
 * Models Manager - Manages the display and copy functionality of available models
 */

import { t } from './i18n.js';
import { getProviderModelEntriesMap, invalidateModelRegistryCache } from './model-registry-manager.js';

// 模型数据缓存
let modelsCache = null;

// 提供商配置缓存
let currentProviderConfigs = null;

function translateOrFallback(key, fallback, params = {}) {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
}

function formatRate(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return '-';
    }

    return `${Math.round(numeric * 100)}%`;
}

function formatLatency(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
        return '-';
    }

    if (numeric < 1000) {
        return `${Math.round(numeric)} ms`;
    }

    return `${(numeric / 1000).toFixed(1)} s`;
}

function formatModelStatusLabel(status = 'unknown') {
    const normalizedStatus = String(status || 'unknown').trim().toLowerCase() || 'unknown';
    return translateOrFallback(`models.status.${normalizedStatus}`, normalizedStatus);
}

function buildModelStatusSummary(modelStatus = null) {
    if (!modelStatus || typeof modelStatus !== 'object') {
        return '';
    }

    const runtime = modelStatus.runtime || {};
    const recentSummary = modelStatus.recentSummary || {};
    const metricItems = [
        {
            key: 'success',
            label: translateOrFallback('models.metric.successRate', '成功率'),
            value: formatRate(recentSummary.successRate ?? modelStatus.successRate)
        },
        {
            key: 'nodes',
            label: translateOrFallback('models.metric.selectableNodes', '可选节点'),
            value: `${runtime.selectableNodeCount ?? 0}/${runtime.supportingNodeCount ?? 0}`
        },
        {
            key: 'http429',
            label: '429',
            value: String(recentSummary.httpStatusCounts?.['429'] ?? 0)
        },
        {
            key: 'http401403',
            label: '401/403',
            value: String((recentSummary.httpStatusCounts?.['401'] ?? 0) + (recentSummary.httpStatusCounts?.['403'] ?? 0))
        },
        {
            key: 'interrupt',
            label: translateOrFallback('models.metric.streamInterrupted', '流中断'),
            value: String(recentSummary.streamInterruptedCount ?? 0)
        },
        {
            key: 'latency',
            label: translateOrFallback('models.metric.avgLatency', '延迟'),
            value: formatLatency(recentSummary.avgLatencyMs ?? modelStatus.avgLatencyMs)
        }
    ];

    return `
        <div class="model-item-status-summary">
            ${metricItems.map(item => `
                <span class="model-item-status-chip metric-${item.key}">
                    <span class="metric-label">${escapeHtml(item.label)}</span>
                    <span class="metric-value">${escapeHtml(item.value)}</span>
                </span>
            `).join('')}
        </div>
    `;
}

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
function updateModelsProviderConfigs(configs) {
    currentProviderConfigs = configs;
    // 如果已经加载了模型，重新渲染一次以更新显示名称和图标
    if (modelsCache) {
        renderModelsList(modelsCache);
    }
}

/**
 * 获取所有提供商的可用模型
 * @returns {Promise<Object>} 模型数据
 */
async function fetchProviderModels() {
    if (modelsCache) {
        return modelsCache;
    }
    
    try {
        modelsCache = await getProviderModelEntriesMap();
        return modelsCache;
    } catch (error) {
        console.error('[Models Manager] Failed to fetch provider models:', error);
        throw error;
    }
}

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (error) {
        console.error('[Models Manager] Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * 显示复制成功的 Toast 提示
 * @param {string} modelName - 模型名称
 */
function showCopyToast(modelName) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${t('models.copied') || '已复制'}: ${modelName}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // 自动移除
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2000);
}

/**
 * 渲染模型列表
 * @param {Object} models - 模型数据
 */
function renderModelsList(models) {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    // 检查是否有模型数据
    const providerTypes = Object.keys(models);
    if (providerTypes.length === 0) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-cube"></i>
                <p data-i18n="models.empty">${t('models.empty') || '暂无可用模型'}</p>
            </div>
        `;
        return;
    }
    
    // 渲染每个提供商的模型组
    let html = '';
    
    for (const providerType of providerTypes) {
        const modelList = models[providerType];
        if (!modelList || modelList.length === 0) continue;
        
        // 如果配置了不可见，则跳过
        if (currentProviderConfigs) {
            const config = currentProviderConfigs.find(c => c.id === providerType);
            if (config && config.visible === false) continue;
        }
        
        const providerDisplayName = getProviderDisplayName(providerType);
        const providerIcon = getProviderIcon(providerType);
        
        html += `
            <div class="provider-models-group" data-provider="${providerType}">
                <div class="provider-models-header" onclick="window.toggleProviderModels('${providerType}')">
                    <div class="provider-models-title">
                        <i class="${providerIcon}"></i>
                        <h3>${providerDisplayName}</h3>
                        <span class="provider-models-count">${modelList.length}</span>
                    </div>
                    <div class="provider-models-toggle">
                        <i class="fas fa-chevron-down"></i>
                    </div>
                </div>
                <div class="provider-models-content" id="models-${providerType}">
                    ${modelList.map(modelEntry => {
                        const canonicalModelId = typeof modelEntry === 'string' ? modelEntry : modelEntry.id;
                        const displayName = typeof modelEntry === 'string'
                            ? modelEntry
                            : (modelEntry.displayName || modelEntry.id);
                        const aliases = Array.isArray(modelEntry?.aliases) ? modelEntry.aliases : [];
                        const modelStatus = typeof modelEntry === 'object' ? modelEntry.modelStatus : null;
                        const status = String(modelStatus?.status || 'unknown').trim().toLowerCase() || 'unknown';
                        const showMeta = displayName !== canonicalModelId || aliases.length > 0;
                        const modelStatusBadge = modelStatus
                            ? `
                                <span class="model-item-status-badge status-${escapeHtml(status)}">
                                    ${escapeHtml(formatModelStatusLabel(status))}
                                </span>
                            `
                            : '';
                        const modelStatusSummary = buildModelStatusSummary(modelStatus);

                        return `
                        <div class="model-item" onclick="window.copyModelName('${escapeHtml(canonicalModelId)}', this)" title="${t('models.clickToCopy') || '点击复制'}">
                            <div class="model-item-icon">
                                <i class="fas fa-cube"></i>
                            </div>
                            <div class="model-item-body">
                                <div class="model-item-title-row">
                                    <span class="model-item-name">${escapeHtml(displayName)}</span>
                                    ${modelStatusBadge}
                                </div>
                                ${showMeta ? `
                                <div class="model-item-meta">
                                    ${displayName !== canonicalModelId ? `<code class="model-item-id">${escapeHtml(canonicalModelId)}</code>` : ''}
                                    ${aliases.map(alias => `<span class="model-item-alias">${escapeHtml(alias)}</span>`).join('')}
                                </div>
                                ` : ''}
                                ${modelStatusSummary}
                            </div>
                            <div class="model-item-copy">
                                <i class="fas fa-copy"></i>
                            </div>
                        </div>
                    `;
                    }).join('')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

/**
 * 获取提供商显示名称
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(providerType) {
    // 优先从外部传入的配置中获取名称
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.name) {
            return config.name;
        }
    }

    const displayNames = {
        'gemini-cli-oauth': 'Gemini CLI (OAuth)',
        'gemini-antigravity': 'Gemini Antigravity',
        'claude-custom': 'Claude Custom',
        'claude-kiro-oauth': 'Claude Kiro (OAuth)',
        'openai-custom': 'OpenAI Custom',
        'openaiResponses-custom': 'OpenAI Responses Custom',
        'openai-qwen-oauth': 'Qwen (OAuth)',
        'openai-iflow': 'iFlow',
        'openai-codex-oauth': 'OpenAI Codex (OAuth)',
        'grok-custom': 'Grok Reverse'
    };

    if (displayNames[providerType]) {
        return displayNames[providerType];
    }

    // 尝试前缀匹配
    for (const baseType in displayNames) {
        if (providerType.startsWith(baseType + '-')) {
            const suffix = providerType.substring(baseType.length + 1);
            return `${displayNames[baseType]} (${suffix})`;
        }
    }

    return providerType;
}

/**
 * 获取提供商图标
 * @param {string} providerType - 提供商类型
 * @returns {string} 图标类名
 */
function getProviderIcon(providerType) {
    // 优先从外部传入的配置中获取图标
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.icon) {
            // 如果 icon 已经包含 fa- 则直接使用，否则加上 fas
            return config.icon.startsWith('fa-') ? `fas ${config.icon}` : config.icon;
        }
    }

    const iconMap = {
        'gemini': 'fas fa-gem',
        'claude': 'fas fa-robot',
        'openai': 'fas fa-brain',
        'qwen': 'fas fa-brain',
        'iflow': 'fas fa-brain',
        'forward': 'fas fa-share-square',
        'grok': 'fas fa-search'
    };

    for (const key in iconMap) {
        if (providerType.includes(key)) {
            return iconMap[key];
        }
    }
    
    return 'fas fa-server';
}

/**
 * HTML 转义
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 切换提供商模型列表的展开/折叠状态
 * @param {string} providerType - 提供商类型
 */
function toggleProviderModels(providerType) {
    const group = document.querySelector(`.provider-models-group[data-provider="${providerType}"]`);
    if (!group) return;
    
    const header = group.querySelector('.provider-models-header');
    const content = group.querySelector('.provider-models-content');
    
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        header.classList.remove('collapsed');
    } else {
        content.classList.add('collapsed');
        header.classList.add('collapsed');
    }
}

/**
 * 复制模型名称
 * @param {string} modelName - 模型名称
 * @param {HTMLElement} element - 点击的元素
 */
async function copyModelName(modelName, element) {
    const success = await copyToClipboard(modelName);
    
    if (success) {
        // 添加复制成功的视觉反馈
        element.classList.add('copied');
        setTimeout(() => {
            element.classList.remove('copied');
        }, 1000);
        
        // 显示 Toast 提示
        showCopyToast(modelName);
    }
}

/**
 * 初始化模型管理器
 */
async function initModelsManager() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    try {
        const models = await fetchProviderModels();
        renderModelsList(models);
    } catch (error) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${t('models.loadError') || '加载模型列表失败'}</p>
            </div>
        `;
    }
}

/**
 * 刷新模型列表
 */
async function refreshModels() {
    invalidateModelRegistryCache();
    modelsCache = null;
    await initModelsManager();
}

// 导出到全局作用域供 HTML 调用
window.toggleProviderModels = toggleProviderModels;
window.copyModelName = copyModelName;
window.refreshModels = refreshModels;

// 监听组件加载完成事件
window.addEventListener('componentsLoaded', () => {
    initModelsManager();
});

// 导出函数
export {
    initModelsManager,
    refreshModels,
    fetchProviderModels,
    updateModelsProviderConfigs
};
