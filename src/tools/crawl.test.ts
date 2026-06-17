import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { registerCrawlTools } from './crawl.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestHeaders, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerCrawlTools', () => {
  it('registers all five crawl tools for an admin:posts key', () => {
    const { server, names } = makeServer();
    expect(registerCrawlTools(server, ctxFor(['admin:posts']))).toBe(5);
    expect(names().sort()).toEqual([
      'get_crawl_config',
      'get_crawl_history',
      'get_crawl_status',
      'start_crawl',
      'update_crawl_config',
    ]);
  });

  it('does NOT register crawl tools for a key with only search scopes', () => {
    const { server } = makeServer();
    expect(registerCrawlTools(server, ctxFor(['search:posts']))).toBe(0);
  });

  it('start_crawl translates siteUrl -> url and the body parses against the cloud schema', async () => {
    // Regression test for a class of bug where the tool's input schema
    // keys didn't match the cloud's expected request body. Passing the
    // tool's advertised arg name (`siteUrl`) MUST produce a body the
    // cloud's startCrawlSchema will accept.
    const { server, byName } = makeServer();
    registerCrawlTools(server, ctxFor(['*']));
    await byName('start_crawl')?.call({
      workspaceId: 'acme',
      siteUrl: 'https://acme.test',
      strategy: 'smart',
    });
    expect(lastRequestPath()).toBe('/crawl');
    expect(lastRequestHeaders()['X-Workspace-ID']).toBe('acme');
    const body = lastRequestBody();
    expect(body).toMatchObject({ url: 'https://acme.test', strategy: 'smart' });
    expect(body.siteUrl).toBeUndefined();
    // Round-trip: cloud must accept what we sent.
    expect(() => CLOUD_SCHEMAS.startCrawl.parse(body)).not.toThrow();
  });

  it('update_crawl_config schedule enum matches the cloud ("none"/"monthly" — not "manual"/"hourly")', async () => {
    const { server, byName } = makeServer();
    registerCrawlTools(server, ctxFor(['*']));

    // Valid cloud enum
    await byName('update_crawl_config')?.call({ workspaceId: 'acme', schedule: 'monthly' });
    expect(() => CLOUD_SCHEMAS.updateCrawlConfig.parse(lastRequestBody())).not.toThrow();

    // Values the OLD tool schema accepted that cloud rejects — must now
    // be rejected BEFORE we hit the network.
    await expect(byName('update_crawl_config')?.call({ workspaceId: 'acme', schedule: 'manual' })).rejects.toThrow();
    await expect(byName('update_crawl_config')?.call({ workspaceId: 'acme', schedule: 'hourly' })).rejects.toThrow();
  });

  it('update_crawl_config strips unknown fields (e.g. the old `sitemapUrl`) before hitting the cloud', async () => {
    // Zod's default object behaviour drops unknown keys silently, which
    // is the right forgiveness-for-agents trade-off: the tool still
    // succeeds, and the outgoing body (what the cloud sees) is clean.
    // We assert the CLEAN body rather than expecting a throw — the
    // contract we care about is "the cloud never sees sitemapUrl".
    const { server, byName } = makeServer();
    registerCrawlTools(server, ctxFor(['*']));
    await byName('update_crawl_config')?.call({
      workspaceId: 'acme',
      sitemapUrl: 'https://acme.test/sitemap.xml',
      schedule: 'daily',
    });
    const body = lastRequestBody();
    expect(body.sitemapUrl).toBeUndefined();
    expect(body).toMatchObject({ schedule: 'daily' });
    expect(() => CLOUD_SCHEMAS.updateCrawlConfig.parse(body)).not.toThrow();
  });
});

// ── Content ──────────────────────────────────────────────────────────
