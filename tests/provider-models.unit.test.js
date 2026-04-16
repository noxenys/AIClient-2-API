import { describe, expect, test } from '@jest/globals';
import {
    extractModelIdsFromNativeList,
    getConfiguredSupportedModels,
    usesManagedModelList
} from '../src/providers/provider-models.js';

describe('provider-models helpers', () => {
    test('recognizes managed model list providers', () => {
        expect(usesManagedModelList('openai-custom')).toBe(true);
        expect(usesManagedModelList('openaiResponses-custom-lab')).toBe(true);
        expect(usesManagedModelList('openai-codex-oauth')).toBe(true);
        expect(usesManagedModelList('grok-custom')).toBe(true);
        expect(usesManagedModelList('gemini-cli-oauth')).toBe(false);
    });

    test('normalizes supported models for managed providers', () => {
        expect(getConfiguredSupportedModels('openai-custom', {
            supportedModels: [' gpt-4o-mini ', '', 'gpt-4o-mini', 'gpt-4.1']
        })).toEqual(['gpt-4.1', 'gpt-4o-mini']);

        expect(getConfiguredSupportedModels('openai-codex-oauth', {
            supportedModels: [' gpt-5.4 ', '', 'gpt-5.3-codex', 'gpt-5.4']
        })).toEqual(['gpt-5.3-codex', 'gpt-5.4']);

        expect(getConfiguredSupportedModels('grok-custom', {
            supportedModels: [' grok-4.20 ', 'grok-4.20-heavy', 'grok-4.20']
        })).toEqual(['grok-4.20', 'grok-4.20-heavy']);

        expect(getConfiguredSupportedModels('gemini-cli-oauth', {
            supportedModels: ['gemini-2.5-flash']
        })).toEqual([]);
    });

    test('extracts model ids from openai-style model lists', () => {
        expect(extractModelIdsFromNativeList({
            data: [
                { id: 'gpt-4o-mini' },
                { id: 'gpt-4.1' }
            ]
        }, 'openai-custom')).toEqual(['gpt-4.1', 'gpt-4o-mini']);
    });
});
