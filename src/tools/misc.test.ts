import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { registerChatTools } from './chat.js';
import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { registerDiagnosticTools as registerDiagnosticsTools } from './diagnostics.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestHeaders, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerChatTools', () => {
  it('registers the single chat tool only when the `chat` scope is present', () => {
    const withChat = makeServer();
    expect(registerChatTools(withChat.server, ctxFor(['chat']))).toBe(1);

    const without = makeServer();
    expect(registerChatTools(without.server, ctxFor(['admin:posts']))).toBe(0);
  });

  it('chat passes through an explicit threadId', async () => {
    const { server, byName } = makeServer();
    registerChatTools(server, ctxFor(['*']));
    await byName('chat')?.call({ workspaceId: 'acme', message: 'do you ship to CA?', threadId: 't-abc' });
    const body = lastRequestBody();
    expect(body).toMatchObject({ message: 'do you ship to CA?', threadId: 't-abc', stream: false });
    expect(() => CLOUD_SCHEMAS.chat.parse(body)).not.toThrow();
  });

  it('chat mints a threadId when the caller omits one (cloud requires a non-empty value)', async () => {
    const { server, byName } = makeServer();
    registerChatTools(server, ctxFor(['*']));
    await byName('chat')?.call({ workspaceId: 'acme', message: 'hi' });
    const body = lastRequestBody();
    expect(typeof body.threadId).toBe('string');
    expect((body.threadId as string).length).toBeGreaterThan(0);
    expect(body.threadId).toMatch(/^mcp-/);
    expect(() => CLOUD_SCHEMAS.chat.parse(body)).not.toThrow();
  });

  it('chat threads X-Workspace-ID via headers', async () => {
    const { server, byName } = makeServer();
    registerChatTools(server, ctxFor(['*']));
    await byName('chat')?.call({ workspaceId: 'acme', message: 'hi', threadId: 't-1' });
    expect(lastRequestPath()).toBe('/chat');
    expect(lastRequestHeaders()['X-Workspace-ID']).toBe('acme');
  });
});

// ── Diagnostics ──────────────────────────────────────────────────────

describe('registerDiagnosticsTools', () => {
  it('exposes whoami regardless of scope (pure identity probe)', () => {
    const { server, names } = makeServer();
    registerDiagnosticsTools(server, ctxFor([], 'publishable'));
    expect(names()).toContain('whoami');
  });

  it('gates get_tenant_usage on tenant:admin', () => {
    const full = makeServer();
    registerDiagnosticsTools(full.server, ctxFor(['tenant:admin']));
    expect(full.names()).toContain('get_tenant_usage');

    const limited = makeServer();
    registerDiagnosticsTools(limited.server, ctxFor(['chat'], 'publishable'));
    expect(limited.names()).not.toContain('get_tenant_usage');
  });

  it('whoami handler returns the cached Whoami struct without a network call', async () => {
    const { server, byName } = makeServer();
    registerDiagnosticsTools(server, ctxFor(['*']));
    const result = (await byName('whoami')?.call({})) as { structuredContent?: unknown };
    expect(hoisted.request).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ tenantId: 't-1' });
  });
});

// ── Config (workspace settings) ──────────────────────────────────────
