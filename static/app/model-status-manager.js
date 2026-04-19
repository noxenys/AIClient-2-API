import { escapeHtml, getProviderConfigs, showToast } from './utils.js';
import { t, getCurrentLanguage } from './i18n.js';

const DEFAULT_MODEL_STATUS_PAYLOAD = Object.freeze({
    version: 1,
    updatedAt: null,
    recentWindowSize: null,
    timelineWindowHours: 24,
    timelineBucketMinutes: 60,
    filePath: '',
    providers: {}
});

let isInitialized = false;

const state = {
    loading: false,
    fetchError: '',
    supportedProviders: [],
    providerSummaries: {},
    modelStatusPayload: { ...DEFAULT_MODEL_STATUS_PAYLOAD, providers: {} },
    selectedProviderType: '',
    providerSearchTerm: '',
    modelSearchTerm: ''
};

function getElements() {
    return {
        refreshBtn: document.getElementById('refreshModelStatusBtn'),
        providerSearchInput: document.getElementById('modelStatusProviderSearchInput'),
        providerList: document.getElementById('modelStatusProviderList'),
        content: document.getElementById('modelStatusContent')
    };
}

function translateOrFallback(key, fallback, params = {}) {
    const translated = t(key, params);
    return translated === key ? fallback : translated;
}

function normalizeModelStatusPayload(payload = {}) {
    return {
        version: payload?.version ?? 1,
        updatedAt: payload?.updatedAt || null,
        recentWindowSize: payload?.recentWindowSize ?? null,
        timelineWindowHours: payload?.timelineWindowHours ?? DEFAULT_MODEL_STATUS_PAYLOAD.timelineWindowHours,
        timelineBucketMinutes: payload?.timelineBucketMinutes ?? DEFAULT_MODEL_STATUS_PAYLOAD.timelineBucketMinutes,
        filePath: payload?.filePath || '',
        providers: payload?.providers && typeof payload.providers === 'object'
            ? payload.providers
            : {}
    };
}

function getDefaultProviderEntry(providerType = '') {
    return {
        providerType,
        summary: {},
        dashboardSummary: {},
        items: [],
        byModel: {}
    };
}

function formatDateTime(value) {
    if (!value) {
        return '-';
    }

    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString(getCurrentLanguage()) : String(value);
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

function formatCompactMetricNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return '-';
    }

    try {
        return new Intl.NumberFormat(getCurrentLanguage(), {
            notation: 'compact',
            maximumFractionDigits: numeric >= 100 ? 0 : 1
        }).format(numeric);
    } catch (error) {
        return numeric.toLocaleString(getCurrentLanguage());
    }
}

function formatTimelineBucketLabel(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return '';
    }

    return date.toLocaleTimeString(getCurrentLanguage(), {
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatTimelineGradeLabel(grade = 'no_data') {
    const normalizedGrade = String(grade || 'no_data').trim().toLowerCase() || 'no_data';
    return translateOrFallback(`modal.provider.modelStatus.grade.${normalizedGrade}`, normalizedGrade);
}

function getTimelineGradeClass(grade = 'no_data') {
    const normalizedGrade = String(grade || 'no_data').trim().toLowerCase() || 'no_data';
    return ['excellent', 'good', 'fair', 'poor', 'error', 'no_data'].includes(normalizedGrade)
        ? normalizedGrade
        : 'no_data';
}

function formatModelStatusLabel(status = 'unknown') {
    const normalizedStatus = String(status || 'unknown').trim().toLowerCase() || 'unknown';
    return translateOrFallback(`modal.provider.modelStatus.status.${normalizedStatus}`, normalizedStatus);
}

function getProviderConfigMap(providerTypes = []) {
    const configMap = new Map();
    getProviderConfigs(providerTypes).forEach(config => {
        configMap.set(config.id, config);
    });

    providerTypes.forEach(providerType => {
        if (!configMap.has(providerType)) {
            configMap.set(providerType, {
                id: providerType,
                name: providerType,
                icon: 'fa-server',
                visible: true
            });
        }
    });

    return configMap;
}

function getOrderedProviderTypes() {
    const providerTypes = [...new Set([
        ...state.supportedProviders,
        ...Object.keys(state.providerSummaries || {}),
        ...Object.keys(state.modelStatusPayload.providers || {})
    ])];

    if (providerTypes.length === 0) {
        return [];
    }

    const knownOrder = getProviderConfigs(providerTypes).map(config => config.id);
    const ordered = [
        ...knownOrder.filter(providerType => providerTypes.includes(providerType)),
        ...providerTypes
            .filter(providerType => !knownOrder.includes(providerType))
            .sort((left, right) => left.localeCompare(right))
    ];

    return [...new Set(ordered)];
}

function getFilteredProviderTypes(providerTypes = getOrderedProviderTypes()) {
    const searchTerm = state.providerSearchTerm.trim().toLowerCase();
    if (!searchTerm) {
        return providerTypes;
    }

    const configMap = getProviderConfigMap(providerTypes);
    return providerTypes.filter(providerType => {
        const config = configMap.get(providerType);
        const previewNames = (state.providerSummaries[providerType]?.previewNodes || [])
            .map(node => node.customName)
            .filter(Boolean)
            .join(' ');
        const haystack = [
            providerType,
            config?.name || '',
            previewNames
        ].join(' ').toLowerCase();

        return haystack.includes(searchTerm);
    });
}

function pickPreferredProvider(providerTypes = []) {
    const withModelData = providerTypes.find(providerType =>
        Array.isArray(state.modelStatusPayload.providers?.[providerType]?.items) &&
        state.modelStatusPayload.providers[providerType].items.length > 0
    );
    if (withModelData) {
        return withModelData;
    }

    const withAccounts = providerTypes.find(providerType =>
        Number(state.providerSummaries[providerType]?.totalCount || 0) > 0
    );
    if (withAccounts) {
        return withAccounts;
    }

    return providerTypes[0] || '';
}

function reconcileSelectedProvider() {
    const orderedProviderTypes = getOrderedProviderTypes();
    const filteredProviderTypes = getFilteredProviderTypes(orderedProviderTypes);

    if (!orderedProviderTypes.includes(state.selectedProviderType)) {
        state.selectedProviderType = pickPreferredProvider(orderedProviderTypes);
    }

    if (state.providerSearchTerm.trim() && filteredProviderTypes.length > 0 && !filteredProviderTypes.includes(state.selectedProviderType)) {
        state.selectedProviderType = filteredProviderTypes[0];
    }

    return filteredProviderTypes;
}

function renderMetricCard(label, value, hint = '', tone = 'default') {
    return `
        <div class="provider-model-status-metric tone-${escapeHtml(tone)}">
            <span class="label">${escapeHtml(label)}</span>
            <span class="value">${escapeHtml(value)}</span>
            ${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}
        </div>
    `;
}

function buildBucketTitle(bucket = {}) {
    const startedAt = formatTimelineBucketLabel(bucket.startedAt);
    const endedAt = formatTimelineBucketLabel(bucket.endedAt);
    const timeRange = startedAt && endedAt ? `${startedAt} - ${endedAt}` : startedAt || endedAt || '-';
    const successRate = formatRate(bucket.successRate);
    const metricLines = [
        `${translateOrFallback('modal.provider.modelStatus.bucket.time', '时间')}: ${timeRange}`,
        `${translateOrFallback('modal.provider.modelStatus.bucket.grade', '状态')}: ${formatTimelineGradeLabel(bucket.grade)}`,
        `${translateOrFallback('modal.provider.modelStatus.metric.successRate', '成功率')}: ${successRate}`,
        `${translateOrFallback('modal.provider.modelStatus.metric.requests', '请求数')}: ${bucket.requestCount ?? 0}`,
        `429: ${bucket?.httpStatusCounts?.['429'] ?? 0}`,
        `401/403: ${(bucket?.httpStatusCounts?.['401'] ?? 0) + (bucket?.httpStatusCounts?.['403'] ?? 0)}`
    ];

    if (bucket.totalTokens > 0) {
        metricLines.push(`${translateOrFallback('modal.provider.modelStatus.metric.totalTokens', 'Token')}: ${formatCompactMetricNumber(bucket.totalTokens)}`);
    }

    if (bucket.lastFailureType) {
        metricLines.push(`${translateOrFallback('modal.provider.modelStatus.metric.lastFailure', '最近故障')}: ${bucket.lastFailureType}`);
    }

    return metricLines.join('\n');
}

function renderAxis(items = []) {
    const baseTimeline = Array.isArray(items[0]?.timeline) ? items[0].timeline : [];
    if (baseTimeline.length === 0) {
        return '';
    }

    const step = Math.max(1, Math.floor(baseTimeline.length / 8));
    return `
        <div class="provider-model-status-axis" style="grid-template-columns: repeat(${baseTimeline.length}, minmax(0, 1fr));">
            ${baseTimeline.map((bucket, index) => `
                <span class="provider-model-status-axis-label ${index % step === 0 || index === baseTimeline.length - 1 ? 'is-visible' : ''}">
                    ${index % step === 0 || index === baseTimeline.length - 1 ? escapeHtml(formatTimelineBucketLabel(bucket.startedAt)) : ''}
                </span>
            `).join('')}
        </div>
    `;
}

function renderStatusItem(item = {}) {
    const runtime = item.runtime || {};
    const timeline = Array.isArray(item.timeline) ? item.timeline : [];
    const timelineSummary = item.timelineSummary || {};
    const status = String(item.status || 'unknown').trim().toLowerCase() || 'unknown';
    const gradeClass = getTimelineGradeClass(timelineSummary.grade);
    const trafficValue = Number(timelineSummary.totalTokens || 0) > 0
        ? `${formatCompactMetricNumber(timelineSummary.totalTokens)} ${translateOrFallback('modal.provider.modelStatus.metric.totalTokensShort', 'Tokens')}`
        : `${formatCompactMetricNumber(timelineSummary.requestCount || 0)} ${translateOrFallback('modal.provider.modelStatus.metric.requestsShort', 'Req')}`;
    const secondaryMeta = [
        `${translateOrFallback('modal.provider.modelStatus.metric.nodes', '节点')}: ${runtime.selectableNodeCount ?? 0}/${runtime.supportingNodeCount ?? 0}`,
        `429: ${timelineSummary?.httpStatusCounts?.['429'] ?? 0}`,
        `401/403: ${(timelineSummary?.httpStatusCounts?.['401'] ?? 0) + (timelineSummary?.httpStatusCounts?.['403'] ?? 0)}`,
        `${translateOrFallback('modal.provider.modelStatus.metric.latency', '延迟')}: ${formatLatency(timelineSummary.avgLatencyMs ?? item.avgLatencyMs)}`
    ];

    if (item.lastFailureType) {
        secondaryMeta.push(`${translateOrFallback('modal.provider.modelStatus.metric.lastFailure', '最近故障')}: ${item.lastFailureType}`);
    }

    return `
        <div class="provider-model-status-item tone-${escapeHtml(gradeClass)}">
            <div class="provider-model-status-item-header">
                <div class="provider-model-status-item-main">
                    <span class="provider-model-status-accent grade-${escapeHtml(gradeClass)}"></span>
                    <div class="provider-model-status-item-copy">
                        <code class="provider-model-status-name">${escapeHtml(item.modelId || '-')}</code>
                        <div class="provider-model-status-item-stats">
                            <span class="provider-model-status-rate grade-${escapeHtml(gradeClass)}">${escapeHtml(formatRate(timelineSummary.successRate))}</span>
                            <span class="provider-model-status-volume">${escapeHtml(trafficValue)}</span>
                        </div>
                    </div>
                </div>
                <span class="provider-model-status-badge status-${escapeHtml(status)}">${escapeHtml(formatModelStatusLabel(status))}</span>
            </div>
            <div class="provider-model-status-timeline" style="grid-template-columns: repeat(${Math.max(timeline.length, 1)}, minmax(0, 1fr));">
                ${timeline.map(bucket => `
                    <span
                        class="provider-model-status-bucket grade-${escapeHtml(getTimelineGradeClass(bucket.grade))} ${bucket.isCurrent ? 'is-current' : ''}"
                        title="${escapeHtml(buildBucketTitle(bucket))}"
                    ></span>
                `).join('')}
            </div>
            <div class="provider-model-status-item-meta">
                ${secondaryMeta.map(metric => `<span class="provider-model-status-chip">${escapeHtml(metric)}</span>`).join('')}
            </div>
        </div>
    `;
}

function renderProviderCards(providerTypes = [], configMap = new Map()) {
    if (state.loading && providerTypes.length === 0) {
        return `
            <div class="model-status-empty-state">
                <i class="fas fa-spinner fa-spin"></i>
                <span>${escapeHtml(translateOrFallback('modelStatus.page.loadingProviders', '正在加载提供商监控视图...'))}</span>
            </div>
        `;
    }

    if (providerTypes.length === 0) {
        const emptyKey = state.providerSearchTerm.trim()
            ? 'modelStatus.page.noProviderMatched'
            : 'modelStatus.page.emptyProviders';
        const emptyText = state.providerSearchTerm.trim()
            ? '没有匹配的提供商'
            : '当前没有可监控的提供商';

        return `
            <div class="model-status-empty-state">
                <i class="fas fa-circle-info"></i>
                <span>${escapeHtml(translateOrFallback(emptyKey, emptyText))}</span>
            </div>
        `;
    }

    return providerTypes.map(providerType => {
        const config = configMap.get(providerType) || { name: providerType, icon: 'fa-server' };
        const summary = state.providerSummaries[providerType] || {};
        const dashboardSummary = state.modelStatusPayload.providers?.[providerType]?.dashboardSummary || {};
        const successRate = formatRate(dashboardSummary.successRate);
        const monitoredModels = Number(dashboardSummary.totalModels || 0);
        const totalCount = Number(summary.totalCount || 0);
        const healthyCount = Number(summary.healthyCount || 0);
        const rateLimitCount = Number(dashboardSummary.httpStatusCounts?.['429'] || 0);
        const badgeLabel = monitoredModels > 0
            ? `${monitoredModels} ${translateOrFallback('modelStatus.page.card.models', '模型')}`
            : translateOrFallback('modelStatus.page.card.noData', '暂无数据');

        return `
            <button
                type="button"
                class="model-status-provider-card ${providerType === state.selectedProviderType ? 'active' : ''}"
                data-provider-type="${escapeHtml(providerType)}"
            >
                <div class="model-status-provider-card-header">
                    <div class="model-status-provider-main">
                        <span class="model-status-provider-icon">
                            <i class="fas ${escapeHtml(config.icon || 'fa-server')}"></i>
                        </span>
                        <div class="model-status-provider-copy">
                            <div class="model-status-provider-name">${escapeHtml(config.name || providerType)}</div>
                            <span class="model-status-provider-type">${escapeHtml(providerType)}</span>
                        </div>
                    </div>
                    <span class="model-status-provider-badge ${monitoredModels === 0 ? 'is-empty' : ''}">
                        <i class="fas fa-wave-square"></i>
                        ${escapeHtml(badgeLabel)}
                    </span>
                </div>
                <div class="model-status-provider-metrics">
                    <span class="model-status-provider-chip">${escapeHtml(translateOrFallback('modelStatus.page.card.nodes', '节点'))}: ${healthyCount}/${totalCount}</span>
                    <span class="model-status-provider-chip">${escapeHtml(t('modal.provider.modelStatus.successRate'))}: ${escapeHtml(successRate)}</span>
                    <span class="model-status-provider-chip">429: ${rateLimitCount}</span>
                </div>
            </button>
        `;
    }).join('');
}

function renderSelectedProviderPanel(providerType = '') {
    if (!providerType) {
        return `
            <div class="model-status-empty-state">
                <i class="fas fa-circle-info"></i>
                <span>${escapeHtml(translateOrFallback('modelStatus.page.emptyProviders', '当前没有可监控的提供商'))}</span>
            </div>
        `;
    }

    const providerTypes = getOrderedProviderTypes();
    const configMap = getProviderConfigMap(providerTypes);
    const config = configMap.get(providerType) || { name: providerType };
    const summary = state.providerSummaries[providerType] || {};
    const entry = state.modelStatusPayload.providers?.[providerType] || getDefaultProviderEntry(providerType);
    const dashboardSummary = entry.dashboardSummary || {};
    const allItems = Array.isArray(entry.items) ? entry.items : [];
    const searchTerm = state.modelSearchTerm.trim().toLowerCase();
    const items = searchTerm
        ? allItems.filter(item => String(item.modelId || '').toLowerCase().includes(searchTerm))
        : allItems;
    const updatedAt = state.modelStatusPayload.updatedAt ? formatDateTime(state.modelStatusPayload.updatedAt) : '-';
    const timelineWindowHours = Number(state.modelStatusPayload.timelineWindowHours || 24) || 24;
    const totalModels = dashboardSummary.totalModels ?? allItems.length;
    const throughputLabel = Number(dashboardSummary.totalTokens || 0) > 0
        ? translateOrFallback('modal.provider.modelStatus.totalTokens', 'Token总数')
        : translateOrFallback('modal.provider.modelStatus.totalRequests', '请求总数');
    const throughputValue = Number(dashboardSummary.totalTokens || 0) > 0
        ? formatCompactMetricNumber(dashboardSummary.totalTokens)
        : formatCompactMetricNumber(dashboardSummary.requestCount);
    const throughputHint = Number(dashboardSummary.totalTokens || 0) > 0
        ? translateOrFallback('modal.provider.modelStatus.totalTokensHint', `过去${timelineWindowHours}小时`, { hours: timelineWindowHours })
        : translateOrFallback('modal.provider.modelStatus.totalRequestsHint', `过去${timelineWindowHours}小时`, { hours: timelineWindowHours });
    const axisHtml = renderAxis(items.length > 0 ? items : allItems);

    return `
        <div class="model-status-detail-shell">
            <div class="model-status-detail-header">
                <div class="model-status-detail-title">
                    <h3>${escapeHtml(config.name || providerType)}</h3>
                    <code>${escapeHtml(providerType)}</code>
                </div>
                <div class="model-status-detail-meta">
                    <span class="model-status-provider-chip">${escapeHtml(translateOrFallback('modelStatus.page.card.nodes', '节点'))}: ${summary.healthyCount || 0}/${summary.totalCount || 0}</span>
                    <span class="model-status-provider-chip">${escapeHtml(translateOrFallback('modal.provider.modelStatus.updatedAt', '缓存更新时间'))}: ${escapeHtml(updatedAt)}</span>
                </div>
            </div>
            ${state.fetchError ? `
                <div class="model-status-warning">
                    <i class="fas fa-triangle-exclamation"></i>
                    <span>${escapeHtml(translateOrFallback('modelStatus.page.loadStatusFailed', '模型状态加载失败'))}: ${escapeHtml(state.fetchError)}</span>
                </div>
            ` : ''}
            <div class="provider-model-status-card ${state.loading ? 'is-loading' : ''}">
                <div class="provider-model-status-header">
                    <div class="provider-model-status-title-block">
                        <div class="provider-model-status-title">
                            <i class="fas fa-heart-pulse"></i>
                            <span>${escapeHtml(t('modal.provider.modelStatus.title'))}</span>
                        </div>
                        <div class="provider-model-status-subtitle">
                            ${escapeHtml(translateOrFallback(
                                'modal.provider.modelStatus.subtitle',
                                `最近 ${timelineWindowHours} 小时模型运行状态一览，监测所有请求（包括格式错误）`,
                                { hours: timelineWindowHours }
                            ))}
                        </div>
                    </div>
                    <span class="provider-model-status-updated">
                        ${escapeHtml(t('modal.provider.modelStatus.updatedAt'))}: ${escapeHtml(updatedAt)}
                    </span>
                </div>
                <div class="provider-model-status-grid">
                    ${renderMetricCard(
                        translateOrFallback('modal.provider.modelStatus.monitoredModels', '监控模型数'),
                        String(totalModels),
                        `${dashboardSummary.activeModels ?? 0} ${translateOrFallback('modal.provider.modelStatus.activeModelsHint', '个活跃模型')}`,
                        'warm'
                    )}
                    ${renderMetricCard(
                        t('modal.provider.modelStatus.successRate'),
                        formatRate(dashboardSummary.successRate),
                        translateOrFallback('modal.provider.modelStatus.successRateHint', `过去${timelineWindowHours}小时`, { hours: timelineWindowHours }),
                        'good'
                    )}
                    ${renderMetricCard(
                        throughputLabel,
                        throughputValue,
                        throughputHint,
                        'gold'
                    )}
                    ${renderMetricCard(
                        translateOrFallback('modal.provider.modelStatus.highQualityModels', '优良模型'),
                        String(dashboardSummary.highQualityCount ?? 0),
                        translateOrFallback('modal.provider.modelStatus.highQualityHint', '成功率 >= 80%'),
                        'good'
                    )}
                </div>
                ${state.loading && allItems.length === 0 ? `
                    <div class="provider-model-status-empty">
                        <i class="fas fa-spinner fa-spin"></i>
                        <span>${escapeHtml(translateOrFallback('modelStatus.page.loadingStatus', '正在加载模型状态...'))}</span>
                    </div>
                ` : ''}
                ${!state.loading && allItems.length === 0 ? `
                    <div class="provider-model-status-empty">
                        <i class="fas fa-wave-square"></i>
                        <span>${escapeHtml(t('modal.provider.modelStatus.empty'))}</span>
                    </div>
                ` : ''}
                ${allItems.length > 0 ? `
                    <div class="provider-model-status-toolbar">
                        <div class="provider-model-status-legend">
                            <span class="provider-model-status-legend-title">${escapeHtml(translateOrFallback('modal.provider.modelStatus.legend', '状态图例'))}</span>
                            <span class="provider-model-status-legend-item"><span class="provider-model-status-dot grade-excellent"></span>${escapeHtml(formatTimelineGradeLabel('excellent'))}</span>
                            <span class="provider-model-status-legend-item"><span class="provider-model-status-dot grade-good"></span>${escapeHtml(formatTimelineGradeLabel('good'))}</span>
                            <span class="provider-model-status-legend-item"><span class="provider-model-status-dot grade-fair"></span>${escapeHtml(formatTimelineGradeLabel('fair'))}</span>
                            <span class="provider-model-status-legend-item"><span class="provider-model-status-dot grade-poor"></span>${escapeHtml(formatTimelineGradeLabel('poor'))}</span>
                            <span class="provider-model-status-legend-item"><span class="provider-model-status-dot grade-error"></span>${escapeHtml(formatTimelineGradeLabel('error'))}</span>
                        </div>
                        <div class="provider-model-status-search">
                            <i class="fas fa-search"></i>
                            <input
                                type="text"
                                id="modelStatusModelSearchInput"
                                value="${escapeHtml(state.modelSearchTerm)}"
                                placeholder="${escapeHtml(translateOrFallback('modal.provider.modelStatus.searchPlaceholder', '搜索模型...'))}"
                            >
                        </div>
                    </div>
                    ${axisHtml}
                ` : ''}
                ${allItems.length > 0 && items.length === 0 ? `
                    <div class="provider-model-status-empty">
                        <i class="fas fa-search"></i>
                        <span>${escapeHtml(translateOrFallback('modal.provider.modelStatus.noSearchResults', '没有匹配的模型'))}</span>
                    </div>
                ` : ''}
                ${items.length > 0 ? `
                    <div class="provider-model-status-list">
                        ${items.map(renderStatusItem).join('')}
                    </div>
                ` : ''}
            </div>
        </div>
    `;
}

function setRefreshButtonLoading(isLoading) {
    const { refreshBtn } = getElements();
    if (!refreshBtn) {
        return;
    }

    if (!refreshBtn.dataset.originalHtml) {
        refreshBtn.dataset.originalHtml = refreshBtn.innerHTML;
    }

    refreshBtn.disabled = isLoading;
    refreshBtn.innerHTML = isLoading
        ? `<i class="fas fa-spinner fa-spin"></i> <span>${escapeHtml(t('common.loading'))}</span>`
        : refreshBtn.dataset.originalHtml;
}

function renderModelStatusDashboard() {
    const { providerList, content } = getElements();
    if (!providerList || !content) {
        return;
    }

    const orderedProviderTypes = getOrderedProviderTypes();
    const filteredProviderTypes = reconcileSelectedProvider();
    const configMap = getProviderConfigMap(orderedProviderTypes);

    providerList.innerHTML = renderProviderCards(filteredProviderTypes, configMap);

    if (state.providerSearchTerm.trim() && filteredProviderTypes.length === 0) {
        content.innerHTML = `
            <div class="model-status-empty-state">
                <i class="fas fa-search"></i>
                <span>${escapeHtml(translateOrFallback('modelStatus.page.noProviderMatched', '没有匹配的提供商'))}</span>
            </div>
        `;
        return;
    }

    content.innerHTML = renderSelectedProviderPanel(state.selectedProviderType);
}

async function loadModelStatusDashboard({ silent = false } = {}) {
    if (state.loading) {
        return;
    }

    state.loading = true;
    state.fetchError = '';
    setRefreshButtonLoading(true);
    renderModelStatusDashboard();

    try {
        const [providerSummaryPayload, modelStatusPayload] = await Promise.all([
            window.apiClient.get('/providers?summary=true'),
            window.apiClient.get('/model-status')
        ]);

        state.supportedProviders = Array.isArray(providerSummaryPayload?.supportedProviders)
            ? providerSummaryPayload.supportedProviders
            : [];
        state.providerSummaries = providerSummaryPayload?.providersSummary || {};
        state.modelStatusPayload = normalizeModelStatusPayload(modelStatusPayload);

        const orderedProviderTypes = getOrderedProviderTypes();
        if (!orderedProviderTypes.includes(state.selectedProviderType)) {
            state.selectedProviderType = pickPreferredProvider(orderedProviderTypes);
        }
    } catch (error) {
        state.fetchError = error.message || String(error);
        if (!silent) {
            showToast(
                t('common.error'),
                `${translateOrFallback('modelStatus.page.loadStatusFailed', '模型状态加载失败')}: ${state.fetchError}`,
                'error'
            );
        }
    } finally {
        state.loading = false;
        setRefreshButtonLoading(false);
        renderModelStatusDashboard();
    }
}

function initModelStatusManager() {
    if (isInitialized) {
        return;
    }

    const { refreshBtn, providerSearchInput, providerList, content } = getElements();
    if (!refreshBtn || !providerSearchInput || !providerList || !content) {
        return;
    }

    refreshBtn.addEventListener('click', () => {
        void loadModelStatusDashboard();
    });

    providerSearchInput.addEventListener('input', event => {
        state.providerSearchTerm = event.target.value || '';
        renderModelStatusDashboard();
    });

    providerList.addEventListener('click', event => {
        const button = event.target.closest('.model-status-provider-card[data-provider-type]');
        if (!button) {
            return;
        }

        state.selectedProviderType = button.dataset.providerType || '';
        state.modelSearchTerm = '';
        renderModelStatusDashboard();
    });

    content.addEventListener('input', event => {
        if (event.target.id !== 'modelStatusModelSearchInput') {
            return;
        }

        state.modelSearchTerm = event.target.value || '';
        renderModelStatusDashboard();
    });

    isInitialized = true;
}

function refreshModelStatusDashboard(options = {}) {
    return loadModelStatusDashboard(options);
}

export {
    initModelStatusManager,
    loadModelStatusDashboard,
    refreshModelStatusDashboard
};
