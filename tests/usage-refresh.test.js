import { jest } from '@jest/globals';

jest.mock('../src/providers/adapter.js', () => ({
    serviceInstances: {},
    getServiceAdapter: jest.fn(() => null)
}));

let shouldQueryUsageForProvider;

describe('usage refresh policy', () => {
    beforeAll(async () => {
        ({ shouldQueryUsageForProvider } = await import('../src/ui-modules/usage-api.js'));
    });

    test('skips disabled and non-selectable provider states', () => {
        expect(shouldQueryUsageForProvider({ isDisabled: true, state: 'healthy' })).toBe(false);
        expect(shouldQueryUsageForProvider({ state: 'cooldown' })).toBe(false);
        expect(shouldQueryUsageForProvider({ state: 'banned' })).toBe(false);
        expect(shouldQueryUsageForProvider({ state: 'disabled' })).toBe(false);
    });

    test('allows healthy and risky providers', () => {
        expect(shouldQueryUsageForProvider({ state: 'healthy' })).toBe(true);
        expect(shouldQueryUsageForProvider({ state: 'risky' })).toBe(true);
        expect(shouldQueryUsageForProvider({ isHealthy: true })).toBe(true);
    });
});
