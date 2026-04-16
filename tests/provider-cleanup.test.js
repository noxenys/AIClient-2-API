import fs from 'fs';
import os from 'os';
import path from 'path';

import {
    isDefinitiveCredentialFailure,
    removeProvidersByPredicate,
    shouldPermanentlyDeleteProvider
} from '../src/utils/provider-cleanup.js';

describe('provider cleanup helpers', () => {
    test('treats 401 and re-authenticate refresh failures as permanently invalid', () => {
        expect(isDefinitiveCredentialFailure('401 Unauthorized')).toBe(true);
        expect(
            isDefinitiveCredentialFailure('Refresh failed: Failed to refresh Codex token. Please re-authenticate.')
        ).toBe(true);
    });

    test('preserves 429 nodes even when message also contains auth-like text', () => {
        expect(isDefinitiveCredentialFailure('429 Too Many Requests after previous 401 Unauthorized')).toBe(false);
        expect(shouldPermanentlyDeleteProvider({
            lastErrorMessage: '429 Too Many Requests'
        })).toBe(false);
    });

    test('removes only permanently invalid providers and deletes unused oauth credential files', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-cleanup-'));
        const deleteMe = path.join(tempDir, 'delete-me.json');
        const keepShared = path.join(tempDir, 'shared.json');
        fs.writeFileSync(deleteMe, '{}', 'utf8');
        fs.writeFileSync(keepShared, '{}', 'utf8');

        const providerPools = {
            'openai-codex-oauth': [
                {
                    uuid: 'delete-401',
                    customName: 'bad',
                    isHealthy: false,
                    lastErrorMessage: '401 Unauthorized',
                    CODEX_OAUTH_CREDS_FILE_PATH: deleteMe
                },
                {
                    uuid: 'keep-429',
                    customName: 'rate-limited',
                    isHealthy: false,
                    lastErrorMessage: '429 Too Many Requests',
                    CODEX_OAUTH_CREDS_FILE_PATH: keepShared
                },
                {
                    uuid: 'keep-shared',
                    customName: 'healthy-shared',
                    isHealthy: true,
                    lastErrorMessage: null,
                    CODEX_OAUTH_CREDS_FILE_PATH: keepShared
                }
            ]
        };

        const result = removeProvidersByPredicate(
            providerPools,
            'openai-codex-oauth',
            shouldPermanentlyDeleteProvider
        );

        expect(result.deletedProviders.map(provider => provider.uuid)).toEqual(['delete-401']);
        expect(result.remainingProviders.map(provider => provider.uuid)).toEqual(['keep-429', 'keep-shared']);
        expect(fs.existsSync(deleteMe)).toBe(false);
        expect(fs.existsSync(keepShared)).toBe(true);
        expect(result.deletedCredentialFiles).toEqual([deleteMe]);
    });
});
