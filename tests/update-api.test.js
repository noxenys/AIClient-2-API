import { jest } from '@jest/globals';

const mockExecAsync = jest.fn();

jest.mock('util', () => ({
    promisify: () => mockExecAsync
}));

jest.mock('../src/core/config-manager.js', () => ({
    CONFIG: {
        UPDATE_MODE: 'image',
        UPDATE_GITHUB_REPO: 'noxenys/AIClient-2-API',
        PROXY_URL: ''
    }
}));

jest.mock('../src/utils/proxy-utils.js', () => ({
    parseProxyUrl: jest.fn(() => null)
}));

jest.mock('../src/utils/common.js', () => ({
    getRequestBody: jest.fn()
}));

function createJsonResponse(body) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async json() {
            return body;
        }
    };
}

describe('update api', () => {
    let checkForUpdates;

    beforeAll(async () => {
        ({ checkForUpdates } = await import('../src/ui-modules/update-api.js'));
    });

    beforeEach(() => {
        mockExecAsync.mockReset();
        mockExecAsync.mockRejectedValue(new Error('not a git repository'));
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/tags')) {
                return createJsonResponse([
                    { name: '2.14.13' },
                    { name: '2.14.12' },
                    { name: '2.14.11' }
                ]);
            }

            if (String(url).includes('/releases/latest')) {
                return createJsonResponse({
                    tag_name: '2.14.13',
                    name: '2.14.13',
                    html_url: 'https://github.com/noxenys/AIClient-2-API/releases/tag/2.14.13',
                    published_at: '2026-04-17T08:30:00Z',
                    body: 'Fix update UX\n\n- Add release info\n- Add rollback shortcut'
                });
            }

            throw new Error(`Unexpected URL: ${url}`);
        });
    });

    afterEach(() => {
        delete global.fetch;
    });

    test('returns release metadata and rollback target in image mode', async () => {
        const info = await checkForUpdates();

        expect(info.updateRepo).toBe('noxenys/AIClient-2-API');
        expect(info.updateMode).toBe('image');
        expect(info.canSelfUpdate).toBe(false);
        expect(info.latestVersion).toBe('2.14.13');
        expect(info.availableVersions).toEqual(['2.14.13', '2.14.12', '2.14.11']);
        expect(info.rollbackVersion).toBe('2.14.11');
        expect(info.hasRollbackTarget).toBe(true);
        expect(info.releaseInfo).toEqual(expect.objectContaining({
            tag: '2.14.13',
            title: '2.14.13',
            url: 'https://github.com/noxenys/AIClient-2-API/releases/tag/2.14.13',
            publishedAt: '2026-04-17T08:30:00Z'
        }));
        expect(info.releaseInfo.notes).toContain('Add rollback shortcut');
    });
});
