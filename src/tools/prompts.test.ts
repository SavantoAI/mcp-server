import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { registerPromptTools } from './prompts.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerPromptTools', () => {
  it('registers all seven prompt tools for an admin+read prompts key', () => {
    const { server, names } = makeServer();
    expect(registerPromptTools(server, ctxFor(['admin:prompts', 'prompts:read']))).toBe(7);
    expect(names().sort()).toEqual(
      [
        'bulk_delete_prompts',
        'bulk_upsert_prompts',
        'delete_prompt',
        'get_prompt',
        'list_prompts',
        'search_prompts',
        'upsert_prompt',
      ].sort(),
    );
  });

  it('gates read vs admin prompt tools independently', () => {
    const { server, names } = makeServer();
    registerPromptTools(server, ctxFor(['prompts:read']));
    expect(names()).toContain('list_prompts');
    expect(names()).toContain('search_prompts');
    expect(names()).not.toContain('upsert_prompt');
    expect(names()).not.toContain('delete_prompt');
  });

  it('search_prompts requires prompts:read specifically — an admin-only key does NOT see it', () => {
    // Cloud POST /prompts/search requires READ_PROMPTS only, so search_prompts
    // must NOT be advertised to a key that only has admin:prompts (it would 403).
    // list_prompts still shows (cloud list is unguarded; we gate it read-or-admin).
    const { server, names } = makeServer();
    registerPromptTools(server, ctxFor(['admin:prompts']));
    expect(names()).not.toContain('search_prompts');
    expect(names()).toContain('list_prompts');
    expect(names()).toContain('upsert_prompt');
  });

  it('upsert_prompt POSTs the prompt body 1:1 (no translation) and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerPromptTools(server, ctxFor(['*']));
    await byName('upsert_prompt')?.call({
      workspaceId: 'acme',
      prompt: 'Where is my order?',
      cannedResponse: 'Track it here.',
      overrideMode: 'fallback',
      priority: 10,
    });
    expect(lastRequestPath()).toBe('/prompts');
    const body = lastRequestBody();
    expect(body.workspaceId).toBeUndefined();
    expect(body).toEqual({
      prompt: 'Where is my order?',
      cannedResponse: 'Track it here.',
      overrideMode: 'fallback',
      priority: 10,
    });
    expect(() => CLOUD_SCHEMAS.upsertPrompt.parse(body)).not.toThrow();
  });

  it('bulk_upsert_prompts wraps entities and round-trips', async () => {
    const { server, byName } = makeServer();
    registerPromptTools(server, ctxFor(['*']));
    await byName('bulk_upsert_prompts')?.call({
      workspaceId: 'acme',
      prompts: [{ prompt: 'A?' }, { id: 'p2', prompt: 'B?' }],
    });
    expect(lastRequestPath()).toBe('/prompts/bulk');
    expect(() => CLOUD_SCHEMAS.bulkUpsertPrompts.parse(lastRequestBody())).not.toThrow();
  });

  it('search_prompts translates query -> text and POSTs /prompts/search', async () => {
    const { server, byName } = makeServer();
    registerPromptTools(server, ctxFor(['*']));
    await byName('search_prompts')?.call({ workspaceId: 'acme', query: 'returns' });
    expect(lastRequestPath()).toBe('/prompts/search');
    expect(lastRequestBody()).toMatchObject({ text: 'returns' });
    expect(lastRequestBody().query).toBeUndefined();
  });

  it('get_prompt / delete_prompt address /prompts/:promptId; delete needs confirm', async () => {
    const { server, byName } = makeServer();
    registerPromptTools(server, ctxFor(['*']));
    await byName('get_prompt')?.call({ workspaceId: 'acme', promptId: 'p-1' });
    expect(lastRequestPath()).toBe('/prompts/p-1');
    await expect(byName('delete_prompt')?.call({ workspaceId: 'acme', promptId: 'p-1' })).rejects.toThrow();
    await byName('delete_prompt')?.call({ workspaceId: 'acme', promptId: 'p-1', confirm: true });
    expect(lastRequestPath()).toBe('/prompts/p-1');
  });
});

// ── Webhooks ─────────────────────────────────────────────────────────
