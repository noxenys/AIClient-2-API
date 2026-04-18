import { jest } from '@jest/globals';
import { createDebouncedTask, createSectionInitializer } from '../static/app/performance-utils.js';

describe('performance utils', () => {
    test('section initializer runs each section only once', async () => {
        const calls = [];
        const sections = createSectionInitializer({
            usage: async () => calls.push('usage'),
            plugins: async () => calls.push('plugins')
        });

        expect(await sections.ensureInitialized('usage')).toBe(true);
        expect(await sections.ensureInitialized('usage')).toBe(false);
        expect(await sections.ensureInitialized('plugins')).toBe(true);
        expect(sections.isInitialized('usage')).toBe(true);
        expect(sections.isInitialized('plugins')).toBe(true);
        expect(calls).toEqual(['usage', 'plugins']);
    });

    test('debounced task coalesces repeated calls', () => {
        jest.useFakeTimers();
        const calls = [];
        const task = createDebouncedTask(value => calls.push(value), 200);

        task('first');
        task('second');
        task('third');

        jest.advanceTimersByTime(199);
        expect(calls).toEqual([]);

        jest.advanceTimersByTime(1);
        expect(calls).toEqual(['third']);
        jest.useRealTimers();
    });
});
