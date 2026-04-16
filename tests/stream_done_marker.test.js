import { EventEmitter } from 'events';
import { handleStreamRequest } from '../src/utils/common.js';

class FakeResponse extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
        this.writableEnded = false;
        this.destroyed = false;
    }

    write(chunk) {
        this.writes.push(String(chunk));
        return true;
    }

    end(chunk = '') {
        if (chunk) {
            this.writes.push(String(chunk));
        }
        this.writableEnded = true;
    }

    writeHead() {
        return this;
    }
}

describe('handleStreamRequest OpenAI SSE completion', () => {
    test('appends data: [DONE] even when finish_reason stop already appeared', async () => {
        const res = new FakeResponse();
        const service = {
            async *generateContentStream() {
                yield {
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'grok-4.20',
                    choices: [
                        {
                            index: 0,
                            delta: { content: 'hello' },
                            finish_reason: 'stop'
                        }
                    ]
                };
            }
        };

        await handleStreamRequest(
            res,
            service,
            'grok-4.20',
            { messages: [{ role: 'user', content: 'hi' }] },
            'openai-custom',
            'openai-custom',
            'none',
            '',
            null,
            null,
            null
        );

        const payload = res.writes.join('');
        expect(payload).toContain('data: {"id":"chatcmpl-test"');
        expect(payload).toContain('data: [DONE]\n\n');
    });
});
