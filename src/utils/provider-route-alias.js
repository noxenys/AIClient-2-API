import { MODEL_PROVIDER } from './constants.js';

export const PROVIDER_ALIAS_ROUTE_PREFIX = '/api/provider/';

const INFERENCE_ROUTE_PATTERNS = [
    /^\/v1\/chat\/completions$/,
    /^\/v1\/responses$/,
    /^\/v1\/messages$/,
    /^\/v1\/messages\/count_tokens$/,
    /^\/v1\/models$/,
    /^\/v1beta\/models$/,
    /^\/v1beta\/models\/.+:(generateContent|streamGenerateContent)$/
];

export function isProviderAliasInferencePath(pathname = '') {
    const normalizedPath = String(pathname || '');
    return INFERENCE_ROUTE_PATTERNS.some(pattern => pattern.test(normalizedPath));
}

export function matchProviderAliasRoute(pathname = '', {
    isRegisteredProvider = () => false,
    allowAuto = true
} = {}) {
    const normalizedPathname = String(pathname || '');
    if (!normalizedPathname.startsWith(PROVIDER_ALIAS_ROUTE_PREFIX)) {
        return { matched: false };
    }

    const aliasSuffix = normalizedPathname.slice(PROVIDER_ALIAS_ROUTE_PREFIX.length);
    const providerSeparatorIndex = aliasSuffix.indexOf('/');
    if (providerSeparatorIndex <= 0) {
        return { matched: false };
    }

    const providerType = decodeURIComponent(aliasSuffix.slice(0, providerSeparatorIndex));
    const targetPath = aliasSuffix.slice(providerSeparatorIndex);
    if (!isProviderAliasInferencePath(targetPath)) {
        return { matched: false };
    }

    const isAutoMode = allowAuto && providerType === MODEL_PROVIDER.AUTO;
    return {
        matched: true,
        providerType,
        normalizedPath: targetPath,
        isAutoMode,
        isValidProvider: isAutoMode || isRegisteredProvider(providerType)
    };
}

export function buildProviderAliasPath(providerType, protocolPath = '') {
    const encodedProvider = encodeURIComponent(String(providerType || '').trim());
    const normalizedProtocolPath = String(protocolPath || '').startsWith('/')
        ? String(protocolPath || '')
        : `/${String(protocolPath || '')}`;

    return `${PROVIDER_ALIAS_ROUTE_PREFIX}${encodedProvider}${normalizedProtocolPath}`;
}
