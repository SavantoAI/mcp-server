import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';
import { registerWebhookTools } from './webhooks.js';

const { lastRequestBody, lastRequestHeaders, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerWebhookTools', () => {
  it('registers all seven webhook tools for an admin:webhooks key', () => {
    const { server, names } = makeServer();
    expect(registerWebhookTools(server, ctxFor(['admin:webhooks']))).toBe(7);
    expect(names().sort()).toEqual(
      [
        'create_webhook',
        'delete_webhook',
        'get_webhook',
        'get_webhook_stats',
        'list_webhooks',
        'test_webhook',
        'update_webhook',
      ].sort(),
    );
  });

  it('registers NONE for a publishable widget key', () => {
    const { server } = makeServer();
    expect(registerWebhookTools(server, ctxFor(['chat'], 'publishable'))).toBe(0);
  });

  it('create_webhook POSTs /webhooks (tenant-level, no workspace header) and round-trips', async () => {
    const { server, byName } = makeServer();
    registerWebhookTools(server, ctxFor(['*']));
    await byName('create_webhook')?.call({
      name: 'Order events',
      url: 'https://hooks.acme.test/orders',
      events: ['chat.completed', 'order.created'],
      secret: 's3cret',
    });
    expect(lastRequestPath()).toBe('/webhooks');
    expect(lastRequestHeaders()['X-Workspace-ID']).toBeUndefined();
    const body = lastRequestBody();
    expect(body).toMatchObject({ name: 'Order events', events: ['chat.completed', 'order.created'] });
    expect(() => CLOUD_SCHEMAS.createWebhook.parse(body)).not.toThrow();
  });

  it('list_webhooks GETs /webhooks with query params', async () => {
    const { server, byName } = makeServer();
    registerWebhookTools(server, ctxFor(['*']));
    await byName('list_webhooks')?.call({ status: 'active', limit: 10 });
    expect(lastRequestPath()).toBe('/webhooks');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { query?: Record<string, unknown> }).query).toEqual({ status: 'active', limit: 10 });
  });

  it('update_webhook PUTs /webhooks/:id and rejects an empty update', async () => {
    const { server, byName } = makeServer();
    registerWebhookTools(server, ctxFor(['*']));
    const empty = (await byName('update_webhook')?.call({ webhookId: 'wh-1' })) as { isError?: boolean };
    expect(empty.isError).toBe(true);
    expect(hoisted.request).not.toHaveBeenCalled();

    await byName('update_webhook')?.call({ webhookId: 'wh-1', status: 'inactive' });
    expect(lastRequestPath()).toBe('/webhooks/wh-1');
    const body = lastRequestBody();
    expect(body).toEqual({ status: 'inactive' });
    expect(body.webhookId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.updateWebhook.parse(body)).not.toThrow();
  });

  it('test_webhook / get_webhook_stats hit the right subpaths', async () => {
    const { server, byName } = makeServer();
    registerWebhookTools(server, ctxFor(['*']));
    await byName('test_webhook')?.call({ webhookId: 'wh-1' });
    expect(lastRequestPath()).toBe('/webhooks/wh-1/test');
    await byName('get_webhook_stats')?.call({ webhookId: 'wh-1' });
    expect(lastRequestPath()).toBe('/webhooks/wh-1/stats');
  });

  it('delete_webhook requires confirm:true', async () => {
    const { server, byName } = makeServer();
    registerWebhookTools(server, ctxFor(['*']));
    await expect(byName('delete_webhook')?.call({ webhookId: 'wh-1' })).rejects.toThrow();
    expect(hoisted.request).not.toHaveBeenCalled();
    await byName('delete_webhook')?.call({ webhookId: 'wh-1', confirm: true });
    expect(lastRequestPath()).toBe('/webhooks/wh-1');
  });
});
