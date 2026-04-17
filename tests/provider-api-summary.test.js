import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => ['grok-custom', 'openai-custom']),
    invalidateServiceAdapter: jest.fn()
}));

let handleGetProviders;

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

describe('handleGetProviders summary', () => {
    beforeAll(async () => {
        ({ handleGetProviders } = await import('../src/ui-modules/provider-api.js'));
    });

    test('returns state counts by provider type and globally', async () => {
        const providerPoolManager = {
            providerStatus: {
                'grok-custom': [
                    { uuid: 'g1', config: { uuid: 'g1', state: 'healthy', isHealthy: true }, state: { activeCount: 1, waitingCount: 0 } },
                    { uuid: 'g2', config: { uuid: 'g2', state: 'cooldown', isHealthy: false }, state: { activeCount: 0, waitingCount: 0 } },
                    { uuid: 'g3', config: { uuid: 'g3', state: 'disabled', isDisabled: true, isHealthy: false }, state: { activeCount: 0, waitingCount: 0 } }
                ],
                'openai-custom': [
                    { uuid: 'o1', config: { uuid: 'o1', state: 'banned', isHealthy: false }, state: { activeCount: 0, waitingCount: 2 } },
                    { uuid: 'o2', config: { uuid: 'o2', state: 'risky', isHealthy: false }, state: { activeCount: 0, waitingCount: 0 } }
                ]
            },
            providerPools: {}
        };
        const res = createMockResponse();

        await handleGetProviders({}, res, {}, providerPoolManager);
        const body = JSON.parse(res.body);

        expect(res.statusCode).toBe(200);
        expect(body.providerStateCountsByType['grok-custom']).toEqual({
            healthy: 1,
            cooldown: 1,
            risky: 0,
            banned: 0,
            disabled: 1,
            unknown: 0
        });
        expect(body.providerStateCountsByType['openai-custom']).toEqual({
            healthy: 0,
            cooldown: 0,
            risky: 1,
            banned: 1,
            disabled: 0,
            unknown: 0
        });
        expect(body.globalStateCounts).toEqual({
            healthy: 1,
            cooldown: 1,
            risky: 1,
            banned: 1,
            disabled: 1,
            unknown: 0
        });
        expect(body.providers['grok-custom'][0].activeRequests).toBe(1);
        expect(body.providers['openai-custom'][0].waitingRequests).toBe(2);
    });
});
