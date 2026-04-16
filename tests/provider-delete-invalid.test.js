import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let handleDeleteUnhealthyProviders;

function createMockResponse() {
    return {
        statusCode: null,
        headers: null,
        body: '',
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        end(body) {
            this.body = body;
        }
    };
}

describe('handleDeleteUnhealthyProviders', () => {
    beforeAll(async () => {
        ({ handleDeleteUnhealthyProviders } = await import('../src/ui-modules/provider-api.js'));
    });

    test('deletes only permanently invalid providers and keeps 429 nodes', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-delete-invalid-'));
        const poolsFile = path.join(tempDir, 'provider_pools.json');
        const badCred = path.join(tempDir, 'bad.json');
        const keepCred = path.join(tempDir, 'keep.json');
        fs.writeFileSync(badCred, '{}', 'utf8');
        fs.writeFileSync(keepCred, '{}', 'utf8');

        fs.writeFileSync(poolsFile, JSON.stringify({
            'openai-codex-oauth': [
                {
                    uuid: 'delete-401',
                    customName: 'bad',
                    isHealthy: false,
                    lastErrorMessage: '401 Unauthorized',
                    CODEX_OAUTH_CREDS_FILE_PATH: badCred
                },
                {
                    uuid: 'keep-429',
                    customName: 'quota',
                    isHealthy: false,
                    lastErrorMessage: '429 Too Many Requests',
                    CODEX_OAUTH_CREDS_FILE_PATH: keepCred
                },
                {
                    uuid: 'keep-ok',
                    customName: 'good',
                    isHealthy: true,
                    lastErrorMessage: null
                }
            ]
        }, null, 2), 'utf8');

        const res = createMockResponse();
        await handleDeleteUnhealthyProviders(
            { headers: { host: 'localhost' } },
            res,
            { PROVIDER_POOLS_FILE_PATH: poolsFile },
            {
                providerPools: {},
                initializeProviderStatus: jest.fn()
            },
            'openai-codex-oauth'
        );

        const body = JSON.parse(res.body);
        const savedPools = JSON.parse(fs.readFileSync(poolsFile, 'utf8'));

        expect(res.statusCode).toBe(200);
        expect(body.deletedCount).toBe(1);
        expect(body.skippedCount).toBe(1);
        expect(body.remainingCount).toBe(2);
        expect(savedPools['openai-codex-oauth'].map(provider => provider.uuid)).toEqual(['keep-429', 'keep-ok']);
        expect(fs.existsSync(badCred)).toBe(false);
        expect(fs.existsSync(keepCred)).toBe(true);
    });
});
