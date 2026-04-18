import { describe, expect, test } from '@jest/globals';
import {
    buildModelRegistry,
    buildProviderModelMap
} from '../src/providers/model-registry.js';

describe('model registry', () => {
    test('merges builtin, managed, and custom models into unified entries', () => {
        const registry = buildModelRegistry({
            providerTypes: ['openai-codex-oauth', 'grok-custom-01'],
            builtinProviderModels: {
                'openai-codex-oauth': ['gpt-5.4', 'gpt-5.3-codex'],
                'grok-custom': ['grok-4.20', 'grok-4.20-auto']
            },
            providerPools: {
                'openai-codex-oauth': [
                    { supportedModels: [' gpt-5.4 ', 'gpt-5.2', 'gpt-5.4'] }
                ],
                'grok-custom-01': [
                    { supportedModels: ['grok-4.20'] }
                ]
            },
            customModels: [
                {
                    id: 'grok-latest',
                    alias: 'grok-main',
                    provider: 'grok-custom',
                    actualProvider: 'grok-custom',
                    actualModel: 'grok-4.20'
                },
                {
                    id: 'codex-latest',
                    provider: 'openai-codex-oauth',
                    actualProvider: 'openai-codex-oauth',
                    actualModel: 'gpt-5.4'
                }
            ]
        });

        expect(registry.find(item => item.id === 'gpt-5.2')).toEqual(expect.objectContaining({
            id: 'gpt-5.2',
            primarySource: 'managed',
            providerTypes: ['openai-codex-oauth'],
            listProviderTypes: ['openai-codex-oauth']
        }));

        expect(registry.find(item => item.id === 'gpt-5.3-codex')).toEqual(expect.objectContaining({
            id: 'gpt-5.3-codex',
            primarySource: 'builtin',
            providerTypes: ['openai-codex-oauth'],
            listProviderTypes: []
        }));

        expect(registry.find(item => item.id === 'grok-latest')).toEqual(expect.objectContaining({
            id: 'grok-latest',
            primarySource: 'custom',
            providerTypes: ['grok-custom-01'],
            listProviderTypes: ['grok-custom-01'],
            aliases: ['grok-main'],
            actualProvider: 'grok-custom',
            actualModel: 'grok-4.20'
        }));
    });

    test('builds legacy provider model map from registry entries', () => {
        const registry = buildModelRegistry({
            providerTypes: ['openai-codex-oauth', 'grok-custom-01'],
            builtinProviderModels: {
                'openai-codex-oauth': ['gpt-5.4', 'gpt-5.3-codex'],
                'grok-custom': ['grok-4.20', 'grok-4.20-auto']
            },
            providerPools: {
                'openai-codex-oauth': [
                    { supportedModels: ['gpt-5.4', 'gpt-5.2'] }
                ],
                'grok-custom-01': [
                    { supportedModels: ['grok-4.20'] }
                ]
            },
            customModels: [
                {
                    id: 'grok-latest',
                    provider: 'grok-custom',
                    actualProvider: 'grok-custom',
                    actualModel: 'grok-4.20'
                },
                {
                    id: 'codex-latest',
                    provider: 'openai-codex-oauth',
                    actualProvider: 'openai-codex-oauth',
                    actualModel: 'gpt-5.4'
                }
            ]
        });

        expect(buildProviderModelMap(registry)).toEqual({
            'grok-custom-01': ['grok-4.20', 'grok-latest'],
            'openai-codex-oauth': ['codex-latest', 'gpt-5.2', 'gpt-5.4']
        });
    });
});
