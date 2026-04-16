import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import {
    detectAvailableModelsForProvider,
    getCodexModelsByPlanType
} from '../src/providers/provider-detection.js';

function makeJwtWithPlan(planType) {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        'https://api.openai.com/auth': {
            chatgpt_plan_type: planType
        }
    })).toString('base64url');

    return `${header}.${payload}.signature`;
}

describe('provider-detection helpers', () => {
    test('returns codex plan models for free plan without spark variant', () => {
        const models = getCodexModelsByPlanType('free');
        expect(models).toContain('gpt-5.4');
        expect(models).toContain('gpt-5.3-codex');
        expect(models).not.toContain('gpt-5.3-codex-spark');
    });

    test('infers codex supported models from credentials file plan_type', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient-codex-plan-'));
        const credPath = path.join(tmpDir, 'cred.json');
        await fs.writeFile(credPath, JSON.stringify({ plan_type: 'plus' }), 'utf8');

        const models = await detectAvailableModelsForProvider('openai-codex-oauth', {
            CODEX_OAUTH_CREDS_FILE_PATH: credPath
        });

        expect(models).toContain('gpt-5.4');
        expect(models).toContain('gpt-5.3-codex-spark');
    });

    test('infers codex supported models from id_token when plan_type missing', async () => {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aiclient-codex-token-'));
        const credPath = path.join(tmpDir, 'cred.json');
        await fs.writeFile(credPath, JSON.stringify({
            id_token: makeJwtWithPlan('team')
        }), 'utf8');

        const models = await detectAvailableModelsForProvider('openai-codex-oauth', {
            CODEX_OAUTH_CREDS_FILE_PATH: credPath
        });

        expect(models).toContain('gpt-5.4');
        expect(models).not.toContain('gpt-5.3-codex-spark');
    });

    test('returns static grok model list for grok custom nodes', async () => {
        const models = await detectAvailableModelsForProvider('grok-custom', {
            GROK_COOKIE_TOKEN: 'token'
        });

        expect(models).toContain('grok-4.20');
        expect(models).toContain('grok-4.20-heavy');
    });
});
