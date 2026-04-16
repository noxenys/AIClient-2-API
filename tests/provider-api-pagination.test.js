import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    getRegisteredProviders: jest.fn(() => []),
    invalidateServiceAdapter: jest.fn()
}));

let handleGetProviderType;

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

function parseResponseBody(res) {
    return JSON.parse(res.body);
}

describe('handleGetProviderType pagination', () => {
    const providerType = 'grok-custom';
    const providerPools = {
        [providerType]: [
            { uuid: 'node-1', customName: 'alpha', isHealthy: true, state: 'healthy', GROK_COOKIE_TOKEN: 'secret-token-1' },
            { uuid: 'node-2', customName: 'beta', isHealthy: false, state: 'banned', GROK_COOKIE_TOKEN: 'secret-token-2' },
            { uuid: 'node-3', customName: 'gamma', isHealthy: true, state: 'healthy', GROK_COOKIE_TOKEN: 'secret-token-3' },
            { uuid: 'node-4', customName: 'delta', isHealthy: false, state: 'cooldown', GROK_COOKIE_TOKEN: 'secret-token-4' },
            { uuid: 'node-5', customName: 'epsilon', isHealthy: true, state: 'healthy', GROK_COOKIE_TOKEN: 'secret-token-5' }
        ]
    };

    beforeAll(async () => {
        ({ handleGetProviderType } = await import('../src/ui-modules/provider-api.js'));
    });

    test('returns paginated providers when page params are present', async () => {
        const req = {
            url: `/api/providers/${providerType}?page=2&pageSize=2`,
            headers: { host: 'localhost' }
        };
        const res = createMockResponse();

        await handleGetProviderType(
            req,
            res,
            {},
            { providerPools },
            providerType
        );

        const body = parseResponseBody(res);

        expect(res.statusCode).toBe(200);
        expect(body.totalCount).toBe(5);
        expect(body.filteredCount).toBe(5);
        expect(body.healthyCount).toBe(3);
        expect(body.unhealthyCount).toBe(2);
        expect(body.stateCounts).toEqual({
            healthy: 3,
            cooldown: 1,
            risky: 0,
            banned: 1,
            disabled: 0,
            unknown: 0
        });
        expect(body.page).toBe(2);
        expect(body.pageSize).toBe(2);
        expect(body.totalPages).toBe(3);
        expect(body.providers).toHaveLength(2);
        expect(body.providers.map(provider => provider.uuid)).toEqual(['node-3', 'node-4']);
        expect(body.providers[1].state).toBe('cooldown');
        expect(body.providers[0].GROK_COOKIE_TOKEN).toContain('****');
    });

    test('filters providers before pagination when search is present', async () => {
        const req = {
            url: `/api/providers/${providerType}?page=1&pageSize=10&search=beta`,
            headers: { host: 'localhost' }
        };
        const res = createMockResponse();

        await handleGetProviderType(
            req,
            res,
            {},
            { providerPools },
            providerType
        );

        const body = parseResponseBody(res);

        expect(body.totalCount).toBe(5);
        expect(body.filteredCount).toBe(1);
        expect(body.totalPages).toBe(1);
        expect(body.providers).toHaveLength(1);
        expect(body.providers[0].uuid).toBe('node-2');
    });

    test('keeps legacy full-list response when no page params are provided', async () => {
        const req = {
            url: `/api/providers/${providerType}`,
            headers: { host: 'localhost' }
        };
        const res = createMockResponse();

        await handleGetProviderType(
            req,
            res,
            {},
            { providerPools },
            providerType
        );

        const body = parseResponseBody(res);

        expect(body.totalCount).toBe(5);
        expect(body.healthyCount).toBe(3);
        expect(body.stateCounts.banned).toBe(1);
        expect(body.providers).toHaveLength(5);
        expect(body.page).toBeUndefined();
        expect(body.filteredCount).toBeUndefined();
    });
});
