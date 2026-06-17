import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { registerTaxonomyTools } from './taxonomies.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerTaxonomyTools', () => {
  it('registers all six taxonomy tools for an admin:taxonomies key', () => {
    const { server, names } = makeServer();
    expect(registerTaxonomyTools(server, ctxFor(['admin:taxonomies']))).toBe(6);
    expect(names().sort()).toEqual(
      [
        'bulk_delete_taxonomies',
        'bulk_upsert_taxonomies',
        'delete_taxonomy',
        'get_taxonomy',
        'list_taxonomies',
        'upsert_taxonomy',
      ].sort(),
    );
  });

  it('registers NONE for a publishable widget key', () => {
    const { server } = makeServer();
    expect(registerTaxonomyTools(server, ctxFor(['chat', 'search:products'], 'publishable'))).toBe(0);
  });

  it('upsert_taxonomy translates externalId -> id and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerTaxonomyTools(server, ctxFor(['*']));
    await byName('upsert_taxonomy')?.call({
      workspaceId: 'acme',
      externalId: 'cat-42',
      name: 'Running Shoes',
      slug: 'running-shoes',
      taxonomyName: 'category',
      parent: 0,
    });
    expect(lastRequestPath()).toBe('/taxonomies');
    const body = lastRequestBody();
    expect(body).toMatchObject({
      id: 'cat-42',
      name: 'Running Shoes',
      slug: 'running-shoes',
      taxonomyName: 'category',
    });
    expect(body.externalId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.upsertTaxonomy.parse(body)).not.toThrow();
  });

  it('bulk_upsert_taxonomies wraps translated entities', async () => {
    const { server, byName } = makeServer();
    registerTaxonomyTools(server, ctxFor(['*']));
    await byName('bulk_upsert_taxonomies')?.call({
      workspaceId: 'acme',
      taxonomies: [{ externalId: 't-1', name: 'Hats', slug: 'hats', taxonomyName: 'category' }],
    });
    expect(lastRequestPath()).toBe('/taxonomies/bulk');
    const body = lastRequestBody() as { entities: Array<Record<string, unknown>> };
    expect(body.entities[0]).toMatchObject({ id: 't-1', slug: 'hats' });
    expect(body.entities[0].externalId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.bulkUpsertTaxonomies.parse(body)).not.toThrow();
  });

  it('list_taxonomies GETs /taxonomies with query params', async () => {
    const { server, byName } = makeServer();
    registerTaxonomyTools(server, ctxFor(['*']));
    await byName('list_taxonomies')?.call({ workspaceId: 'acme', taxonomyName: 'category', page: 1, perPage: 50 });
    expect(lastRequestPath()).toBe('/taxonomies');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { query?: Record<string, unknown> }).query).toEqual({
      taxonomyName: 'category',
      page: 1,
      perPage: 50,
    });
  });

  it('get_taxonomy GETs /taxonomies/:externalId', async () => {
    const { server, byName } = makeServer();
    registerTaxonomyTools(server, ctxFor(['*']));
    await byName('get_taxonomy')?.call({ workspaceId: 'acme', externalId: 'cat-42' });
    expect(lastRequestPath()).toBe('/taxonomies/cat-42');
  });

  it('delete_taxonomy / bulk_delete_taxonomies require confirm:true', async () => {
    const { server, byName } = makeServer();
    registerTaxonomyTools(server, ctxFor(['*']));
    await expect(byName('delete_taxonomy')?.call({ workspaceId: 'acme', externalId: 'c1' })).rejects.toThrow();
    await expect(
      byName('bulk_delete_taxonomies')?.call({ workspaceId: 'acme', externalIds: ['c1'] }),
    ).rejects.toThrow();
    expect(hoisted.request).not.toHaveBeenCalled();

    await byName('bulk_delete_taxonomies')?.call({ workspaceId: 'acme', externalIds: ['c1', 'c2'], confirm: true });
    expect(lastRequestPath()).toBe('/taxonomies/bulk');
    expect(lastRequestBody()).toEqual({ ids: ['c1', 'c2'] });
    expect(() => CLOUD_SCHEMAS.bulkDelete.parse(lastRequestBody())).not.toThrow();
  });
});

// ── Prompts ──────────────────────────────────────────────────────────
