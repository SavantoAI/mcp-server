import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';
import { registerThreadTools } from './threads.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerThreadTools', () => {
  it('registers all six thread tools for a threads:admin key', () => {
    const { server, names } = makeServer();
    expect(registerThreadTools(server, ctxFor(['threads:admin']))).toBe(6);
    expect(names().sort()).toEqual(
      [
        'bulk_delete_threads',
        'delete_thread',
        'get_thread',
        'get_thread_analytics',
        'get_thread_messages',
        'search_threads',
      ].sort(),
    );
  });

  it('get_thread_messages also registers for a chat-scoped key (cloud allows admin:threads OR chat)', () => {
    const { server, names } = makeServer();
    registerThreadTools(server, ctxFor(['chat'], 'publishable'));
    expect(names()).toEqual(['get_thread_messages']);
  });

  it('search_threads POSTs /threads/search and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerThreadTools(server, ctxFor(['*']));
    await byName('search_threads')?.call({ hasUnresolvedQueries: true, limit: 25, sortBy: 'messageCount' });
    expect(lastRequestPath()).toBe('/threads/search');
    const body = lastRequestBody();
    expect(body).toEqual({ hasUnresolvedQueries: true, limit: 25, sortBy: 'messageCount' });
    expect(() => CLOUD_SCHEMAS.searchThreads.parse(body)).not.toThrow();
  });

  it('get_thread / get_thread_messages address the right paths', async () => {
    const { server, byName } = makeServer();
    registerThreadTools(server, ctxFor(['*']));
    await byName('get_thread')?.call({ threadId: 't-1' });
    expect(lastRequestPath()).toBe('/threads/t-1');
    await byName('get_thread_messages')?.call({ threadId: 't-1' });
    expect(lastRequestPath()).toBe('/threads/t-1/messages');
  });

  it('delete_thread / bulk_delete_threads require confirm:true', async () => {
    const { server, byName } = makeServer();
    registerThreadTools(server, ctxFor(['*']));
    await expect(byName('delete_thread')?.call({ threadId: 't-1' })).rejects.toThrow();
    await expect(byName('bulk_delete_threads')?.call({ threadIds: ['t-1'] })).rejects.toThrow();
    expect(hoisted.request).not.toHaveBeenCalled();

    await byName('bulk_delete_threads')?.call({ threadIds: ['t-1', 't-2'], confirm: true });
    expect(lastRequestPath()).toBe('/threads');
    expect(lastRequestBody()).toEqual({ ids: ['t-1', 't-2'] });
    expect(() => CLOUD_SCHEMAS.bulkDelete.parse(lastRequestBody())).not.toThrow();
  });
});
