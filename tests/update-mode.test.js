import {
    canPerformSelfUpdate,
    compareVersions,
    findRollbackVersion,
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

    test('image mode supports in-container self update', () => {
        expect(canPerformSelfUpdate('image')).toBe(true);
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

    test('finds rollback version from the next lower tag', () => {
        expect(findRollbackVersion(['2.14.13', '2.14.12', '2.14.11'], '2.14.12')).toBe('2.14.11');
        expect(findRollbackVersion(['v2.14.13', '2.14.11'], '2.14.12')).toBe('2.14.11');
    });

    test('returns null when no lower rollback version exists', () => {
        expect(findRollbackVersion(['2.14.13', '2.14.12'], '2.14.11')).toBeNull();
    });
});
