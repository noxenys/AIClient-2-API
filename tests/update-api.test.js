import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
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

function createBinaryResponse(buffer) {
    return {
        ok: true,
        status: 200,
        statusText: 'OK',
        async arrayBuffer() {
            return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
        }
    };
}

function createTempAppFixture({ localVersion, targetVersion }) {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'aiclient-update-'));
    const releaseRoot = path.join(tempRoot, `AIClient-2-API-${targetVersion}`);
    const sharedPackageJson = JSON.stringify({
        name: 'aiclient-update-test',
        version: '1.0.0'
    }, null, 2);

    mkdirSync(path.join(tempRoot, 'src'), { recursive: true });
    mkdirSync(path.join(tempRoot, 'static'), { recursive: true });
    writeFileSync(path.join(tempRoot, 'VERSION'), `${localVersion}\n`);
    writeFileSync(path.join(tempRoot, 'package.json'), `${sharedPackageJson}\n`);
    writeFileSync(path.join(tempRoot, 'src', 'old.js'), 'export const oldValue = true;\n');
    writeFileSync(path.join(tempRoot, 'static', 'old.txt'), 'old-static\n');

    mkdirSync(path.join(releaseRoot, 'src'), { recursive: true });
    mkdirSync(path.join(releaseRoot, 'static'), { recursive: true });
    writeFileSync(path.join(releaseRoot, 'VERSION'), `${targetVersion}\n`);
    writeFileSync(path.join(releaseRoot, 'package.json'), `${sharedPackageJson}\n`);
    writeFileSync(path.join(releaseRoot, 'src', 'new.js'), `export const version = '${targetVersion}';\n`);
    writeFileSync(path.join(releaseRoot, 'static', 'new.txt'), `static-${targetVersion}\n`);

    const tarballPath = path.join(tempRoot, `${targetVersion}.tar.gz`);
    execFileSync('tar', ['-czf', tarballPath, '-C', tempRoot, `AIClient-2-API-${targetVersion}`]);

    return { tempRoot, tarballPath };
}

describe('update api', () => {
    let checkForUpdates;
    let performUpdate;
    let handlePerformUpdate;
    let CONFIG;
    let getRequestBody;
    let originalCwd;

    beforeAll(async () => {
        ({ checkForUpdates, performUpdate, handlePerformUpdate } = await import('../src/ui-modules/update-api.js'));
        ({ CONFIG } = await import('../src/core/config-manager.js'));
        ({ getRequestBody } = await import('../src/utils/common.js'));
        originalCwd = process.cwd();
    });

    beforeEach(() => {
        mockExecAsync.mockReset();
        mockExecAsync.mockImplementation(async (command, options = {}) => {
            if (command === 'git rev-parse --git-dir') {
                throw new Error('not a git repository');
            }

            const tarMatch = String(command).match(/^tar -xzf "(.+)" -C "(.+)"$/);
            if (tarMatch) {
                execFileSync('tar', ['-xzf', tarMatch[1], '-C', tarMatch[2]]);
                return { stdout: '', stderr: '' };
            }

            if (command === 'npm install') {
                return { stdout: '', stderr: '' };
            }

            throw new Error(`Unexpected command: ${command} ${JSON.stringify(options)}`);
        });

        CONFIG.UPDATE_MODE = 'image';
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
        process.chdir(originalCwd);
        delete global.fetch;
    });

    test('returns release metadata and enables self update in image mode', async () => {
        const info = await checkForUpdates();

        expect(info.updateRepo).toBe('noxenys/AIClient-2-API');
        expect(info.updateMode).toBe('image');
        expect(info.canSelfUpdate).toBe(true);
        expect(info.latestVersion).toBe('2.14.13');
        expect(info.availableVersions).toEqual(['2.14.13', '2.14.12', '2.14.11']);
        expect(info.rollbackVersion).toBe('2.14.12');
        expect(info.hasRollbackTarget).toBe(true);
        expect(info.releaseInfo).toEqual(expect.objectContaining({
            tag: '2.14.13',
            title: '2.14.13',
            url: 'https://github.com/noxenys/AIClient-2-API/releases/tag/2.14.13',
            publishedAt: '2026-04-17T08:30:00Z'
        }));
        expect(info.releaseInfo.notes).toContain('Add rollback shortcut');
    });

    test('performs in-container self update in image mode via tarball replacement', async () => {
        const fixture = createTempAppFixture({
            localVersion: '2.14.13',
            targetVersion: '2.14.14'
        });

        process.chdir(fixture.tempRoot);

        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('2.14.14.tar.gz')) {
                return createBinaryResponse(readFileSync(fixture.tarballPath));
            }

            if (String(url).includes('/tags')) {
                return createJsonResponse([
                    { name: '2.14.14' },
                    { name: '2.14.13' },
                    { name: '2.14.12' }
                ]);
            }

            if (String(url).includes('/releases/latest')) {
                return createJsonResponse({
                    tag_name: '2.14.14',
                    name: '2.14.14',
                    html_url: 'https://github.com/noxenys/AIClient-2-API/releases/tag/2.14.14',
                    published_at: '2026-04-18T08:30:00Z',
                    body: 'Container self update release'
                });
            }

            throw new Error(`Unexpected URL: ${url}`);
        });

        try {
            const result = await performUpdate();

            expect(result.updated).toBe(true);
            expect(result.updateMethod).toBe('tarball');
            expect(result.targetVersion).toBe('2.14.14');
            expect(readFileSync(path.join(fixture.tempRoot, 'VERSION'), 'utf8').trim()).toBe('2.14.14');
            expect(existsSync(path.join(fixture.tempRoot, 'src', 'new.js'))).toBe(true);
            expect(existsSync(path.join(fixture.tempRoot, 'src', 'old.js'))).toBe(false);
            expect(readFileSync(path.join(fixture.tempRoot, 'static', 'new.txt'), 'utf8').trim()).toBe('static-2.14.14');
        } finally {
            process.chdir(originalCwd);
            rmSync(fixture.tempRoot, { recursive: true, force: true });
        }
    });

    test('forwards rollback target through update handler in image mode self update', async () => {
        const fixture = createTempAppFixture({
            localVersion: '2.14.13',
            targetVersion: '2.14.12'
        });

        process.chdir(fixture.tempRoot);
        getRequestBody.mockResolvedValue({
            version: '2.14.12',
            action: 'rollback'
        });

        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('2.14.12.tar.gz')) {
                return createBinaryResponse(readFileSync(fixture.tarballPath));
            }

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
                    body: 'Rollback release metadata'
                });
            }

            throw new Error(`Unexpected URL: ${url}`);
        });

        const res = {
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

        try {
            await handlePerformUpdate({ url: '/api/update', headers: { host: 'localhost' } }, res);
            const body = JSON.parse(res.body);

            expect(res.statusCode).toBe(200);
            expect(body.updated).toBe(true);
            expect(body.targetVersion).toBe('2.14.12');
            expect(readFileSync(path.join(fixture.tempRoot, 'VERSION'), 'utf8').trim()).toBe('2.14.12');
        } finally {
            process.chdir(originalCwd);
            rmSync(fixture.tempRoot, { recursive: true, force: true });
        }
    });
});
