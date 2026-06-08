import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavantoApiError } from './utils/fetch.js';
import { fetchWhoami, hasScope, type Whoami } from './whoami.js';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock('./utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('./utils/fetch.js')>('./utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

const CLIENT = { apiKey: 'if_sk_test', baseUrl: 'http://localhost:3001' };

describe('hasScope', () => {
  const publishableWho: Whoami = {
    tenantId: 't-1',
    tier: 'pro',
    apiKeyId: 'k-1',
    keyType: 'publishable',
    scopes: ['chat', 'search:products'],
  };

  it('returns true when the exact scope is present', () => {
    expect(hasScope(publishableWho, 'chat')).toBe(true);
  });

  it('returns false when the scope is absent', () => {
    expect(hasScope(publishableWho, 'tenant:admin')).toBe(false);
  });

  it('grants all scopes to wildcard (`*`) keys', () => {
    const wildcard: Whoami = { ...publishableWho, scopes: ['*'] };
    expect(hasScope(wildcard, 'tenant:admin')).toBe(true);
    expect(hasScope(wildcard, 'anything-at-all')).toBe(true);
  });

  it('treats a secret key with an EMPTY scope list as wildcard (legacy behaviour)', () => {
    // This mirrors the cloud's own `hasScope` helper — a secret key that
    // was issued before scopes existed is represented with `scopes: []`
    // and must still be able to call every endpoint.
    const legacySecret: Whoami = { ...publishableWho, keyType: 'secret', scopes: [] };
    expect(hasScope(legacySecret, 'admin:products')).toBe(true);
  });

  it('does NOT treat a publishable key with empty scopes as wildcard', () => {
    const emptyPublishable: Whoami = { ...publishableWho, scopes: [] };
    expect(hasScope(emptyPublishable, 'chat')).toBe(false);
  });
});

describe('fetchWhoami', () => {
  beforeEach(() => {
    hoisted.request.mockReset();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('returns the /tenant/whoami payload when the endpoint is available', async () => {
    hoisted.request.mockResolvedValueOnce({
      tenantId: 't-1',
      tier: 'pro',
      apiKeyId: 'k-1',
      keyType: 'secret',
      scopes: ['*'],
      label: 'Agent MCP',
    });
    const who = await fetchWhoami(CLIENT);
    expect(who).toEqual({
      tenantId: 't-1',
      tier: 'pro',
      apiKeyId: 'k-1',
      keyType: 'secret',
      scopes: ['*'],
      label: 'Agent MCP',
    });
    expect(hoisted.request).toHaveBeenCalledTimes(1);
    expect(hoisted.request).toHaveBeenCalledWith(CLIENT, { path: '/tenant/whoami' });
  });

  it('defaults scopes to [] when the payload omits the field', async () => {
    hoisted.request.mockResolvedValueOnce({
      tenantId: 't-1',
      tier: 'pro',
      apiKeyId: 'k-1',
      keyType: 'secret',
    });
    const who = await fetchWhoami(CLIENT);
    expect(who.scopes).toEqual([]);
  });

  it('falls back to /tenant/status when whoami returns 404 (older cloud)', async () => {
    // 404 is the only signal "this cloud predates /tenant/whoami". We
    // must not fall back on 401/500 because those are real failures.
    hoisted.request.mockImplementationOnce(async () => {
      throw new SavantoApiError({ status: 404, message: 'not found' });
    });
    hoisted.request.mockResolvedValueOnce({
      tenantId: 't-legacy',
      tier: 'starter',
      jwtSecret: 'k-legacy',
      publishableKey: 'if_pk_legacy',
    });
    const who = await fetchWhoami(CLIENT);
    expect(who.tenantId).toBe('t-legacy');
    expect(who.keyType).toBe('secret');
    expect(who.scopes).toContain('tenant:admin');
    // Because `publishableKey` was present in the fallback response, the
    // inferred scopes should include chat / search surfaces too.
    expect(who.scopes).toContain('chat');
  });

  it('does NOT swallow non-404 errors during whoami lookup', async () => {
    hoisted.request.mockImplementationOnce(async () => {
      throw new SavantoApiError({ status: 401, message: 'bad key' });
    });
    await expect(fetchWhoami(CLIENT)).rejects.toBeInstanceOf(SavantoApiError);
    // Crucially, the fallback route should NOT have been attempted.
    expect(hoisted.request).toHaveBeenCalledTimes(1);
  });
});
