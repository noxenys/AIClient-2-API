import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getServiceAdapter: jest.fn(() => null),
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

jest.mock('../src/ui-modules/event-broadcast.js', () => ({
    broadcastEvent: jest.fn()
}));

let ProviderPoolManager;
const activeManagers = [];

describe('ProviderPoolManager auto cleanup', () => {
    beforeAll(async () => {
        ({ ProviderPoolManager } = await import('../src/providers/provider-pool-manager.js'));
    });

    afterEach(() => {
        for (const manager of activeManagers.splice(0)) {
            if (manager.saveTimer) {
                clearTimeout(manager.saveTimer);
                manager.saveTimer = null;
            }
            manager.pendingSaves?.clear();
        }
    });

    test('auto deletes permanently invalid oauth provider after immediate auth failure', async () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-pool-cleanup-'));
        const poolsFile = path.join(tempDir, 'provider_pools.json');
        const badCred = path.join(tempDir, 'bad.json');
        fs.writeFileSync(badCred, '{}', 'utf8');

        const providerPools = {
            'openai-codex-oauth': [
                {
                    uuid: 'delete-401',
                    customName: 'bad',
                    isHealthy: true,
                    errorCount: 0,
                    refreshCount: 0,
                    needsRefresh: false,
                    lastErrorMessage: null,
                    CODEX_OAUTH_CREDS_FILE_PATH: badCred
                }
            ]
        };

        fs.writeFileSync(poolsFile, JSON.stringify(providerPools, null, 2), 'utf8');

        const manager = new ProviderPoolManager(providerPools, {
            globalConfig: { PROVIDER_POOLS_FILE_PATH: poolsFile },
            saveDebounceTime: 1
        });
        activeManagers.push(manager);

        manager.markProviderUnhealthyImmediately(
            'openai-codex-oauth',
            { uuid: 'delete-401' },
            '401 Unauthorized'
        );

        let savedPools = null;
        for (let attempt = 0; attempt < 20; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 30));
            try {
                const raw = fs.readFileSync(poolsFile, 'utf8');
                savedPools = JSON.parse(raw);
                if (!savedPools['openai-codex-oauth']) {
                    break;
                }
            } catch {
                // 文件写入过程中可能暂时不可解析，继续等待
            }
        }

        expect(savedPools).toBeTruthy();

        expect(savedPools['openai-codex-oauth']).toBeUndefined();
        expect(manager.providerPools['openai-codex-oauth']).toBeUndefined();
        expect(fs.existsSync(badCred)).toBe(false);
    });
});
