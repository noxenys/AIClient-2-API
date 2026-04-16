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

function createManager(providerPools) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiclient-state-machine-'));
    const poolsFile = path.join(tempDir, 'provider_pools.json');
    fs.writeFileSync(poolsFile, JSON.stringify(providerPools, null, 2), 'utf8');

    const manager = new ProviderPoolManager(providerPools, {
        globalConfig: {
            PROVIDER_POOLS_FILE_PATH: poolsFile,
            RATE_LIMIT_COOLDOWN_MS: 60_000
        },
        saveDebounceTime: 60_000
    });

    if (manager.saveTimer) {
        clearTimeout(manager.saveTimer);
        manager.saveTimer = null;
        manager.pendingSaves.clear();
    }

    activeManagers.push(manager);
    return manager;
}

describe('ProviderPoolManager state machine', () => {
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

    test('infers runtime state from legacy fields on initialization', () => {
        const manager = createManager({
            'openai-custom': [
                { uuid: 'healthy-default', customName: 'healthy-default' },
                { uuid: 'disabled-node', customName: 'disabled-node', isDisabled: true },
                { uuid: 'banned-node', customName: 'banned-node', isHealthy: false, lastErrorMessage: '401 Unauthorized' },
                { uuid: 'cooldown-node', customName: 'cooldown-node', isHealthy: false, lastErrorMessage: '429 Too Many Requests' },
                { uuid: 'risky-node', customName: 'risky-node', isHealthy: false, lastErrorMessage: 'socket hang up' }
            ]
        });

        const configs = Object.fromEntries(
            manager.providerStatus['openai-custom'].map(item => [item.uuid, item.config])
        );

        expect(configs['healthy-default'].state).toBe('healthy');
        expect(configs['disabled-node'].state).toBe('disabled');
        expect(configs['banned-node'].state).toBe('banned');
        expect(configs['cooldown-node'].state).toBe('cooldown');
        expect(configs['risky-node'].state).toBe('risky');
    });

    test('maps rate limit errors to cooldown and auth errors to banned', () => {
        const manager = createManager({
            'openai-custom': [
                { uuid: 'node-a', customName: 'node-a' },
                { uuid: 'node-b', customName: 'node-b' }
            ]
        });
        manager._autoDeletePermanentlyInvalidProvider = jest.fn();

        manager.markProviderUnhealthy('openai-custom', { uuid: 'node-a' }, '429 Too Many Requests');
        manager.markProviderUnhealthyImmediately('openai-custom', { uuid: 'node-b' }, '403 Forbidden');

        const nodeA = manager.findProviderByUuid('node-a');
        const nodeB = manager.findProviderByUuid('node-b');

        expect(nodeA.state).toBe('cooldown');
        expect(nodeA.recentFailureType).toBe('rate_limit');
        expect(nodeA.cooldownUntil).toBeTruthy();

        expect(nodeB.state).toBe('banned');
        expect(nodeB.recentFailureType).toBe('auth');
        expect(nodeB.lastStateReason).toContain('403');
    });

    test('selects healthy nodes before risky ones and skips banned/cooldown/disabled nodes', async () => {
        const manager = createManager({
            'openai-custom': [
                { uuid: 'risky-node', customName: 'risky-node', state: 'risky', isHealthy: false },
                { uuid: 'cooldown-node', customName: 'cooldown-node', state: 'cooldown', isHealthy: false },
                { uuid: 'banned-node', customName: 'banned-node', state: 'banned', isHealthy: false },
                { uuid: 'disabled-node', customName: 'disabled-node', state: 'disabled', isDisabled: true, isHealthy: false },
                { uuid: 'healthy-node', customName: 'healthy-node', state: 'healthy', isHealthy: true }
            ]
        });

        const selected = await manager.selectProvider('openai-custom');
        expect(selected.uuid).toBe('healthy-node');
    });

    test('falls back to risky node when no healthy node is available', async () => {
        const manager = createManager({
            'openai-custom': [
                { uuid: 'risky-node', customName: 'risky-node', state: 'risky', isHealthy: false },
                { uuid: 'cooldown-node', customName: 'cooldown-node', state: 'cooldown', isHealthy: false }
            ]
        });

        const selected = await manager.selectProvider('openai-custom');
        expect(selected.uuid).toBe('risky-node');
    });
});
