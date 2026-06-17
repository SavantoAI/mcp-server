import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { registerAnalyticsTools } from './analytics.js';
import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerAnalyticsTools', () => {
  it('registers all four analytics tools for a tenant:admin key', () => {
    const { server, names } = makeServer();
    // Most analytics tools need tenant:admin; list_feedback needs feedback:admin.
    expect(registerAnalyticsTools(server, ctxFor(['tenant:admin', 'feedback:admin']))).toBe(5);
    expect(names().sort()).toEqual(
      [
        'get_chat_analytics',
        'get_feedback_analytics',
        'get_search_analytics',
        'list_feedback',
        'search_search_logs',
      ].sort(),
    );
  });

  it('list_feedback gates on feedback:admin, separate from tenant:admin', () => {
    const t = makeServer();
    registerAnalyticsTools(t.server, ctxFor(['tenant:admin']));
    expect(t.names()).not.toContain('list_feedback');
    const f = makeServer();
    registerAnalyticsTools(f.server, ctxFor(['feedback:admin']));
    expect(f.names()).toEqual(['list_feedback']);
  });

  it('list_feedback GETs /feedback with rating/limit as query', async () => {
    const { server, byName } = makeServer();
    registerAnalyticsTools(server, ctxFor(['*']));
    await byName('list_feedback')?.call({ rating: 'negative', limit: 25 });
    expect(lastRequestPath()).toBe('/feedback');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { query?: Record<string, unknown> }).query).toEqual({ rating: 'negative', limit: 25 });
  });

  it('registers NONE for a publishable widget key', () => {
    const { server } = makeServer();
    expect(registerAnalyticsTools(server, ctxFor(['chat', 'search:products'], 'publishable'))).toBe(0);
  });

  it('get_search_analytics GETs /analytics/search with filters as query (not body)', async () => {
    const { server, byName } = makeServer();
    registerAnalyticsTools(server, ctxFor(['*']));
    await byName('get_search_analytics')?.call({ days: 30, topN: 10, workspaceId: 'acme' });
    expect(lastRequestPath()).toBe('/analytics/search');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { method?: string }).method).toBeUndefined();
    expect((init as { query?: Record<string, unknown> }).query).toEqual({ days: 30, topN: 10, workspaceId: 'acme' });
  });

  it('get_chat_analytics GETs /analytics/chat', async () => {
    const { server, byName } = makeServer();
    registerAnalyticsTools(server, ctxFor(['*']));
    await byName('get_chat_analytics')?.call({ days: 7 });
    expect(lastRequestPath()).toBe('/analytics/chat');
  });

  it('get_feedback_analytics GETs /analytics/feedback', async () => {
    const { server, byName } = makeServer();
    registerAnalyticsTools(server, ctxFor(['*']));
    await byName('get_feedback_analytics')?.call({ dateFrom: '2026-01-01' });
    expect(lastRequestPath()).toBe('/analytics/feedback');
  });

  it('search_search_logs POSTs /analytics/searches/search and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerAnalyticsTools(server, ctxFor(['*']));
    await byName('search_search_logs')?.call({ zeroResultsOnly: true, limit: 50, workspaceId: 'acme' });
    expect(lastRequestPath()).toBe('/analytics/searches/search');
    const body = lastRequestBody();
    expect(body).toEqual({ zeroResultsOnly: true, limit: 50, workspaceId: 'acme' });
    expect(() => CLOUD_SCHEMAS.searchSearchLogs.parse(body)).not.toThrow();
  });
});
