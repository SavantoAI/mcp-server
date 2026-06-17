/**
 * Remote HTTP transport tests. These drive the handler with real `Request`
 * objects through the real SDK web-standard transport + a real `McpServer`
 * (built via `createServer` with an injected whoami, so no network probe) —
 * the same in-memory philosophy as the tool tests, no sockets involved.
 *
 * `createServer` registers tools but they only hit the network when *called*;
 * initialize / tools-list never touch the Savanto API, so these run offline.
 */

import { describe, expect, it, vi } from 'vitest';
import { type CreatedServer, createServer } from '../server.js';
import { SavantoApiError } from '../utils/fetch.js';
import type { Whoami } from '../whoami.js';
import { createHttpHandler, type FetchHandler, type HttpHandlerOptions } from './handler.js';

const WHOAMI: Whoami = {
  tenantId: 't-1',
  tier: 'pro',
  apiKeyId: 'k-1',
  keyType: 'secret',
  scopes: [], // empty + secret = god-key for this tenant → full tool surface
};

const BASE = 'http://localhost:3001';
const MCP_URL = 'http://mcp.test/mcp';

function makeHandler(): FetchHandler {
  return createHttpHandler({
    baseUrl: BASE,
    createServerFn: (opts) => createServer({ ...opts, whoami: WHOAMI }),
  });
}

/** Handler whose server factory fails — to exercise the upstream-error paths. */
function makeHandlerThatFails(error: unknown): FetchHandler {
  return createHttpHandler({
    baseUrl: BASE,
    createServerFn: (): Promise<CreatedServer> => Promise.reject(error),
  });
}

/** Handler with custom options (caps, idle window, allowlists, clock). */
function makeConfiguredHandler(extra: Partial<HttpHandlerOptions>): FetchHandler {
  return createHttpHandler({
    baseUrl: BASE,
    createServerFn: (opts) => createServer({ ...opts, whoami: WHOAMI }),
    ...extra,
  });
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  },
};

const JSON_AND_SSE = 'application/json, text/event-stream';

function postInit(headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: JSON_AND_SSE,
      Authorization: 'Bearer if_sk_test',
      ...headers,
    },
    body: JSON.stringify(INIT_BODY),
  });
}

/** Initialize a session and return the handler + minted session id. */
async function initSession(): Promise<{ handler: FetchHandler; sessionId: string }> {
  const handler = makeHandler();
  const res = await handler(postInit());
  expect(res.status).toBe(200);
  const sessionId = res.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  // Complete the lifecycle so subsequent requests are accepted.
  await handler(
    new Request(MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: JSON_AND_SSE,
        'mcp-session-id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
  );
  return { handler, sessionId: sessionId as string };
}

describe('createHttpHandler — routing & health', () => {
  it('serves a liveness probe at /healthz', async () => {
    const res = await makeHandler()(new Request('http://mcp.test/healthz'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('404s any path other than the MCP endpoint', async () => {
    const res = await makeHandler()(new Request('http://mcp.test/nope', { method: 'POST' }));
    expect(res.status).toBe(404);
  });
});

describe('createHttpHandler — OAuth discovery (RFC 9728)', () => {
  const AS = 'https://savanto.ai';
  const RESOURCE = 'https://mcp.savanto.ai/mcp';

  it('serves protected-resource metadata when an authorization server is configured', async () => {
    const handler = makeConfiguredHandler({ authorizationServer: AS, resourceIdentifier: RESOURCE });
    const res = await handler(new Request('http://mcp.test/.well-known/oauth-protected-resource'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([AS]);
  });

  it('adds the resource_metadata pointer to 401s (public origin from resourceIdentifier)', async () => {
    const handler = makeConfiguredHandler({ authorizationServer: AS, resourceIdentifier: RESOURCE });
    const res = await handler(postInit({ Authorization: '' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer realm="savanto-mcp", resource_metadata="https://mcp.savanto.ai/.well-known/oauth-protected-resource"',
    );
  });

  it('stays Phase-1 when no authorization server is set: no discovery doc, plain WWW-Authenticate', async () => {
    const res404 = await makeHandler()(new Request('http://mcp.test/.well-known/oauth-protected-resource'));
    expect(res404.status).toBe(404);
    const res401 = await makeHandler()(postInit({ Authorization: '' }));
    expect(res401.headers.get('WWW-Authenticate')).toBe('Bearer realm="savanto-mcp"');
    expect(res401.headers.get('WWW-Authenticate')).not.toContain('resource_metadata');
  });
});

describe('createHttpHandler — auth gating', () => {
  it('rejects initialize with no Authorization header (401 + WWW-Authenticate)', async () => {
    const res = await makeHandler()(postInit({ Authorization: '' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    const body = (await res.json()) as { error: { message: string } };
    // HTTP-appropriate message — about the header, not the SAVANTO_API_KEY env var.
    expect(body.error.message).toMatch(/Authorization header/i);
    expect(body.error.message).not.toMatch(/SAVANTO_API_KEY/);
  });

  it('rejects a publishable key with 401', async () => {
    const res = await makeHandler()(postInit({ Authorization: 'Bearer if_pk_test' }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/publishable/i);
  });

  it('rejects a non-Bearer Authorization scheme with 401', async () => {
    const res = await makeHandler()(postInit({ Authorization: 'Basic if_sk_test' }));
    expect(res.status).toBe(401);
  });
});

describe('createHttpHandler — session lifecycle', () => {
  it('initialize mints a session id', async () => {
    const res = await makeHandler()(postInit());
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects a non-initialize POST that has no session id', async () => {
    const res = await makeHandler()(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: JSON_AND_SSE,
          Authorization: 'Bearer if_sk_test',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a GET with no session id', async () => {
    const res = await makeHandler()(new Request(MCP_URL, { method: 'GET', headers: { Accept: 'text/event-stream' } }));
    expect(res.status).toBe(400);
  });

  it('rejects a request bearing an unknown session id', async () => {
    const res = await makeHandler()(
      new Request(MCP_URL, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', 'mcp-session-id': 'does-not-exist' },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 on a malformed JSON body', async () => {
    const res = await makeHandler()(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: JSON_AND_SSE,
          Authorization: 'Bearer if_sk_test',
        },
        body: '{ not valid json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.message).toMatch(/parse error/i);
  });

  it('lists tools over an established session', async () => {
    const { handler, sessionId } = await initSession();
    const res = await handler(
      new Request(MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: JSON_AND_SSE,
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('whoami');
    expect(names.length).toBeGreaterThan(1);
  });
});

describe('createHttpHandler — hardening (cap, idle eviction, allowlists)', () => {
  it('refuses a new session past maxSessions with 503', async () => {
    const handler = makeConfiguredHandler({ maxSessions: 1 });
    const first = await handler(postInit());
    expect(first.status).toBe(200); // one session now registered
    const second = await handler(postInit());
    expect(second.status).toBe(503);
    const body = (await second.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/capacity/i);
  });

  it('lazily evicts a session idle past sessionIdleMs', async () => {
    let clock = 0;
    const handler = makeConfiguredHandler({ sessionIdleMs: 1000, now: () => clock });
    const res = await handler(postInit());
    const sessionId = res.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();

    // Jump past the idle window; the next request triggers the sweep, so the
    // now-stale session is gone by the time routing looks it up.
    clock = 5000;
    const after = await handler(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: JSON_AND_SSE, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      }),
    );
    expect(after.status).toBe(404);
  });

  it('keeps a session alive while it stays active within the idle window', async () => {
    let clock = 0;
    const handler = makeConfiguredHandler({ sessionIdleMs: 1000, now: () => clock });
    const res = await handler(postInit());
    const sessionId = res.headers.get('mcp-session-id') as string;
    await handler(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: JSON_AND_SSE, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      }),
    );
    // Each step advances the clock by less than the window, refreshing activity.
    clock = 800;
    const a = await handler(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: JSON_AND_SSE, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(a.status).toBe(200);
    clock = 1500; // 700ms since last activity (< 1000) → still alive
    const b = await handler(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: JSON_AND_SSE, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
      }),
    );
    expect(b.status).toBe(200);
  });

  it('rejects a Host outside the allowlist with 403', async () => {
    const handler = makeConfiguredHandler({ allowedHosts: ['mcp.savanto.ai'] });
    const res = await handler(postInit({ host: 'evil.test' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/host not allowed/i);
  });

  it('allows a Host in the allowlist', async () => {
    const handler = makeConfiguredHandler({ allowedHosts: ['mcp.savanto.ai'] });
    const res = await handler(postInit({ host: 'mcp.savanto.ai' }));
    expect(res.status).toBe(200);
  });

  it('matches a Host allowlist ignoring the port (mcp.savanto.ai:443)', async () => {
    const handler = makeConfiguredHandler({ allowedHosts: ['mcp.savanto.ai'] });
    const res = await handler(postInit({ host: 'mcp.savanto.ai:443' }));
    expect(res.status).toBe(200);
  });

  it('rejects a present Origin outside the allowlist with 403', async () => {
    const handler = makeConfiguredHandler({ allowedOrigins: ['https://app.savanto.ai'] });
    const res = await handler(postInit({ origin: 'https://evil.test' }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/origin not allowed/i);
  });

  it('allows a request with no Origin even when an allowlist is set (CLI clients)', async () => {
    const handler = makeConfiguredHandler({ allowedOrigins: ['https://app.savanto.ai'] });
    const res = await handler(postInit()); // no Origin header
    expect(res.status).toBe(200);
  });
});

describe('createHttpHandler — upstream auth & errors', () => {
  it('maps an API 401/403 (revoked key) to a 401', async () => {
    const handler = makeHandlerThatFails(new SavantoApiError({ status: 401, message: 'revoked' }));
    const res = await handler(postInit());
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer');
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/rejected by the Savanto API/i);
  });

  it('maps an unreachable / unexpected upstream error to a 502', async () => {
    const handler = makeHandlerThatFails(new Error('ECONNREFUSED'));
    const res = await handler(postInit());
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/could not reach the savanto api/i);
  });
});

describe('createHttpHandler — review follow-ups', () => {
  it('closes an orphaned server when an initialize body fails the strict JSON-RPC schema (no leak)', async () => {
    const closeSpy = vi.fn();
    const handler = createHttpHandler({
      baseUrl: BASE,
      createServerFn: async (opts) => {
        const created = await createServer({ ...opts, whoami: WHOAMI });
        const original = created.server.close.bind(created.server);
        created.server.close = () => {
          closeSpy();
          return original();
        };
        return created;
      },
    });
    // Passes the loose isInitializeRequest gate (method + params) but has no
    // jsonrpc/id, so the transport returns a 4xx without throwing → the server
    // would be orphaned if we didn't close it on the no-session path.
    const res = await handler(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: JSON_AND_SSE, Authorization: 'Bearer if_sk_test' },
        body: JSON.stringify({
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
        }),
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('matches the Host allowlist case-insensitively', async () => {
    const handler = makeConfiguredHandler({ allowedHosts: ['mcp.savanto.ai'] });
    const res = await handler(postInit({ host: 'MCP.Savanto.AI' }));
    expect(res.status).toBe(200);
  });
});
