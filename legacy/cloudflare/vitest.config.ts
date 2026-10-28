import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.dev.jsonc' },
    miniflare: { outboundService: async request => {
      // Keep runtime fetch tests offline while exercising Workerd's actual redirect/HTTP handling.
      const url = new URL(request.url);
      if (url.hostname !== 'gateway-runtime.test') throw new Error('Unmatched outbound test request');
      if (url.pathname === '/redirect/chat/completions') return new Response('redirect rejected', { status: 302, headers: { Location: 'https://gateway-runtime.test/json/chat/completions' } });
      if (request.method !== 'POST' || request.headers.get('authorization') !== 'Bearer runtime-upstream-secret') return new Response('Invalid fixture authentication', { status: 401 });
      const body = await request.json() as { model?: string; stream?: boolean };
      if (body.model !== 'test') return new Response('Invalid fixture model', { status: 400 });
      const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
      if (url.pathname === '/json/chat/completions') return Response.json({ model: 'test', choices: [{ message: { role: 'assistant', content: 'runtime JSON reply' } }], usage });
      if (url.pathname === '/sse/chat/completions' && body.stream) return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'runtime SSE reply' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage })}\n\n`, 'data: [DONE]\n\n',
      ].join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      throw new Error('Unmatched outbound test endpoint');
    }, bindings: {
      DEV_MODE: 'true', ADMIN_TOKEN: 'test-admin-token',
      ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      TEST_MIGRATIONS: await readD1Migrations('./migrations'),
    } },
  })],
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, hookTimeout: 30000 },
}));
