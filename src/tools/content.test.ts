import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { CLOUD_SCHEMAS } from './cloudSchemas.fixture.js';
import { registerContentTools } from './content.js';
import { createRequestProbe, ctxFor, makeServer } from './testHarness.js';

const { lastRequestBody, lastRequestPath } = createRequestProbe(hoisted.request);

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

describe('registerContentTools', () => {
  it('gates tools per-scope independently (search vs. admin)', () => {
    const { server, names } = makeServer();
    registerContentTools(server, ctxFor(['search:products', 'search:posts'], 'publishable'));
    expect(names()).toContain('search_products');
    expect(names()).toContain('search_posts');
    expect(names()).not.toContain('upsert_product');
    expect(names()).not.toContain('upsert_post');
  });

  it('upsert_product translates externalId/category/stockStatus to the cloud shape', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('upsert_product')?.call({
      workspaceId: 'acme',
      externalId: 'prod-123',
      name: 'Trail Runner',
      content: 'A great shoe.',
      category: 'footwear',
      stockStatus: 'inStock',
      price: 120,
    });
    const body = lastRequestBody();
    expect(body).toMatchObject({
      id: 'prod-123',
      name: 'Trail Runner',
      categories: ['footwear'],
      stockStatus: 'instock',
    });
    expect(body.externalId).toBeUndefined();
    expect(body.category).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.upsertProduct.parse(body)).not.toThrow();
  });

  it('upsert_product merges category + categories without duplicates', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('upsert_product')?.call({
      workspaceId: 'acme',
      externalId: 'p-1',
      name: 'Boot',
      category: 'footwear',
      categories: ['footwear', 'outdoor'],
    });
    const body = lastRequestBody();
    expect(body.categories).toEqual(['footwear', 'outdoor']);
  });

  it('upsert_product maps each stockStatus value to its cloud counterpart', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    for (const [tool, cloud] of [
      ['inStock', 'instock'],
      ['outOfStock', 'outofstock'],
      ['preorder', 'onbackorder'],
    ] as const) {
      await byName('upsert_product')?.call({ workspaceId: 'acme', externalId: 'p-1', name: 'x', stockStatus: tool });
      expect(lastRequestBody().stockStatus).toBe(cloud);
    }
  });

  it('upsert_post translates externalId -> id', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('upsert_post')?.call({
      workspaceId: 'acme',
      externalId: 'post-1',
      title: 'Hello',
      content: 'World',
    });
    const body = lastRequestBody();
    expect(body).toMatchObject({ id: 'post-1', title: 'Hello', content: 'World' });
    expect(body.externalId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.upsertPost.parse(body)).not.toThrow();
  });

  it('search_products translates query -> text (cloud schema expects `text`)', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('search_products')?.call({ workspaceId: 'acme', query: 'red sneakers', limit: 5 });
    const body = lastRequestBody();
    expect(body).toMatchObject({ text: 'red sneakers', limit: 5 });
    expect(body.query).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.search.parse(body)).not.toThrow();
  });

  it('search_products accepts nested operator filters like { price: { gte, lte } }', async () => {
    // The cloud's searchSchema explicitly allows nested objects in the
    // filter value union (see cloud/src/routes/products.ts), so a tool
    // schema that rejects them is the strictly-more-restrictive layer
    // and silently denies agents range queries the backend can actually
    // execute. Round-tripping `{ price: { gte: 50, lte: 200 } }` against
    // both the tool schema and the cloud-mirror is the contract we need.
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('search_products')?.call({
      workspaceId: 'acme',
      query: 'jacket',
      filters: { price: { gte: 50, lte: 200 }, category: 'outerwear', tags: ['waterproof'] },
    });
    const body = lastRequestBody();
    expect(body).toMatchObject({
      text: 'jacket',
      filters: { price: { gte: 50, lte: 200 }, category: 'outerwear', tags: ['waterproof'] },
    });
    expect(() => CLOUD_SCHEMAS.search.parse(body)).not.toThrow();
  });

  it('search_posts translates query -> text', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('search_posts')?.call({ workspaceId: 'acme', query: 'return policy' });
    const body = lastRequestBody();
    expect(body).toMatchObject({ text: 'return policy' });
    expect(body.query).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.search.parse(body)).not.toThrow();
  });

  // ── lifecycle: bulk / list / get / patch / delete ──

  it('bulk_upsert_products wraps translated entities and round-trips the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('bulk_upsert_products')?.call({
      workspaceId: 'acme',
      products: [
        { externalId: 'p-1', name: 'A', category: 'footwear', stockStatus: 'inStock' },
        { externalId: 'p-2', name: 'B', categories: ['outdoor'] },
      ],
    });
    expect(lastRequestPath()).toBe('/products/bulk');
    const body = lastRequestBody() as { entities: Array<Record<string, unknown>> };
    expect(body.entities).toHaveLength(2);
    // each entity translated externalId -> id, category -> categories[], stock mapped
    expect(body.entities[0]).toMatchObject({ id: 'p-1', categories: ['footwear'], stockStatus: 'instock' });
    expect(body.entities[0].externalId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.bulkUpsertProducts.parse(body)).not.toThrow();
  });

  it('bulk_upsert_posts wraps translated entities', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('bulk_upsert_posts')?.call({
      workspaceId: 'acme',
      posts: [{ externalId: 'a-1', title: 'T', content: 'Body' }],
    });
    expect(lastRequestPath()).toBe('/posts/bulk');
    const body = lastRequestBody() as { entities: Array<Record<string, unknown>> };
    expect(body.entities[0]).toMatchObject({ id: 'a-1', title: 'T' });
    expect(body.entities[0].externalId).toBeUndefined();
    expect(() => CLOUD_SCHEMAS.bulkUpsertPosts.parse(body)).not.toThrow();
  });

  it('list_products GETs /products with filters as query params (not body)', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    // Cloud list paginates with page/perPage and filters on categories/tags/status (csv).
    await byName('list_products')?.call({ workspaceId: 'acme', page: 2, perPage: 20, categories: 'footwear' });
    expect(lastRequestPath()).toBe('/products');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { method?: string }).method).toBeUndefined(); // GET (no method)
    expect((init as { query?: Record<string, unknown> }).query).toEqual({
      page: 2,
      perPage: 20,
      categories: 'footwear',
    });
    expect((init as { body?: unknown }).body).toBeUndefined();
  });

  it('get_product GETs /products/:externalId', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('get_product')?.call({ workspaceId: 'acme', externalId: 'prod 123' });
    expect(lastRequestPath()).toBe('/products/prod%20123');
  });

  it('patch_product PATCHes /products/:externalId with { indexStatus }', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await byName('patch_product')?.call({ workspaceId: 'acme', externalId: 'p-1', indexStatus: 'hidden' });
    expect(lastRequestPath()).toBe('/products/p-1');
    const body = lastRequestBody();
    expect(body).toEqual({ indexStatus: 'hidden' });
    expect(() => CLOUD_SCHEMAS.patchContent.parse(body)).not.toThrow();
  });

  it('delete_product requires confirm:true and DELETEs the path', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await expect(byName('delete_product')?.call({ workspaceId: 'acme', externalId: 'p-1' })).rejects.toThrow();
    expect(hoisted.request).not.toHaveBeenCalled();

    await byName('delete_product')?.call({ workspaceId: 'acme', externalId: 'p-1', confirm: true });
    expect(lastRequestPath()).toBe('/products/p-1');
    const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
    expect((init as { method?: string }).method).toBe('DELETE');
  });

  it('bulk_delete_products requires confirm:true and sends { ids } to /products/bulk', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await expect(
      byName('bulk_delete_products')?.call({ workspaceId: 'acme', externalIds: ['p-1', 'p-2'] }),
    ).rejects.toThrow();
    expect(hoisted.request).not.toHaveBeenCalled();

    await byName('bulk_delete_products')?.call({ workspaceId: 'acme', externalIds: ['p-1', 'p-2'], confirm: true });
    expect(lastRequestPath()).toBe('/products/bulk');
    const body = lastRequestBody();
    expect(body).toEqual({ ids: ['p-1', 'p-2'] });
    expect(() => CLOUD_SCHEMAS.bulkDelete.parse(body)).not.toThrow();
  });

  it('delete_post requires confirm:true', async () => {
    const { server, byName } = makeServer();
    registerContentTools(server, ctxFor(['*']));
    await expect(byName('delete_post')?.call({ workspaceId: 'acme', externalId: 'a-1' })).rejects.toThrow();
    await byName('delete_post')?.call({ workspaceId: 'acme', externalId: 'a-1', confirm: true });
    expect(lastRequestPath()).toBe('/posts/a-1');
  });

  it('admin content tools are gated off for a publishable (search-only) key', () => {
    const { server, names } = makeServer();
    registerContentTools(server, ctxFor(['search:products', 'search:posts'], 'publishable'));
    for (const t of ['bulk_upsert_products', 'delete_product', 'patch_post', 'bulk_delete_posts']) {
      expect(names()).not.toContain(t);
    }
    // list_products mirrors cloud's OR gate (admin:products OR search:products),
    // so a search-scoped key DOES see it.
    expect(names()).toContain('list_products');
    // There is no list_posts tool (cloud has no GET /posts).
    expect(names()).not.toContain('list_posts');
  });
});

// ── Chat ─────────────────────────────────────────────────────────────
