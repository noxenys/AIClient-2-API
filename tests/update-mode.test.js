import {
    canPerformSelfUpdate,
    compareVersions,
    normalizeUpdateMode,
    resolveEffectiveUpdateMode,
    sortAndFilterVersions
} from '../src/utils/update-mode';

describe('update mode helpers', () => {
    test('normalizes invalid modes to auto', () => {
        expect(normalizeUpdateMode()).toBe('auto');
        expect(normalizeUpdateMode('weird')).toBe('auto');
        expect(normalizeUpdateMode('IMAGE')).toBe('image');
    });

    test('auto mode resolves to git inside git repo and image outside git repo', () => {
        expect(resolveEffectiveUpdateMode('auto', true)).toBe('git');
        expect(resolveEffectiveUpdateMode('auto', false)).toBe('image');
    });

    test('image mode never performs self update', () => {
        expect(canPerformSelfUpdate('image')).toBe(false);
        expect(canPerformSelfUpdate('git')).toBe(true);
        expect(canPerformSelfUpdate('tarball')).toBe(true);
    });

    test('compares mixed v and non-v tags correctly', () => {
        expect(compareVersions('2.14.7', 'v2.14.6')).toBe(1);
        expect(compareVersions('v2.14.6', '2.14.6')).toBe(0);
    });

    test('sorts mixed version tags with latest first', () => {
        expect(sortAndFilterVersions(['v2.14.6', '2.14.7', 'v2.14.5.2'], 10)).toEqual([
            '2.14.7',
            'v2.14.6',
            'v2.14.5.2'
        ]);
    });
});
