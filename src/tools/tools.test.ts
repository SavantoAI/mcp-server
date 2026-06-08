/**
 * Integration-style tests for the MCP tool registrations.
 *
 * Two critical validation layers that the earlier version of this file
 * missed and that let a round of schema-mismatch bugs slip through:
 *
 *   1. Tool INPUT Zod — the fake server below Zod-parses the args using
 *      each tool's advertised `inputSchema` before invoking the handler,
 *      exactly like `McpServer.registerTool` does at runtime. That means
 *      a test can't paper over a misnamed tool field by handing the
 *      handler cloud-shaped args directly.
 *
 *   2. Outgoing body vs. cloud Zod — each handler test round-trips the
 *      body through a local mirror of the cloud route's request schema
 *      (kept in `CLOUD_SCHEMAS` with a file pointer back to the source
 *      of truth). If a tool forgets to translate a field (e.g. leaves
 *      `externalId` instead of `id`), the parse fails and the test
 *      fails with a loud `ZodError`.
 *
 * If the cloud schemas change, update CLOUD_SCHEMAS in lock-step — the
 * test will otherwise go green on a silent contract drift.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import type { SavantoClient } from '../utils/fetch.js';
import type { Whoami } from '../whoami.js';

const hoisted = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../utils/fetch.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/fetch.js')>('../utils/fetch.js');
  return { ...actual, request: hoisted.request };
});

import { registerChatTools } from './chat.js';
import { registerContentTools } from './content.js';
import { registerCrawlTools } from './crawl.js';
import { registerDiagnosticTools as registerDiagnosticsTools } from './diagnostics.js';
import { registerWorkspaceTools } from './workspaces.js';

const CLIENT: SavantoClient = { baseUrl: 'http://localhost:3001', apiKey: 'if_sk_test' };

// ── Cloud schema mirrors ────────────────────────────────────────────
// Trimmed Zod mirrors of what each cloud route's request body expects.
// If cloud/src/routes/<file>.ts changes, update the corresponding block
// here; the per-tool tests call `parse()` on the outgoing body so any
// drift lights up immediately.
//
// ── Strictness policy ──
// The mirrors for upsert_product / upsert_post use `.strict()`, which is
// TIGHTER than the real cloud schemas (which ignore unknown fields
// rather than rejecting them). This is deliberate: strict mode turns
// "MCP tool leaked a field the cloud doesn't model" into a test
// failure, which is exactly the class of drift these tests exist to
// catch. If you add a new MCP tool arg that needs to reach the cloud
// (e.g. `regularPrice`, `rating`, `metadata`, …), add it to BOTH the
// tool's inputSchema AND the corresponding mirror below — that
// coupling is the point.
//
// Null-handling: cloud accepts `null` for several optional fields
// (`price`, `stockQuantity`, etc.); the mirrors match that so a future
// tool update that exposes null-clearing passes without churn.

const CLOUD_SCHEMAS = {
  // cloud/src/routes/crawl.ts → startCrawlSchema
  startCrawl: z.object({
    url: z.string().min(1),
    workspaceId: z.string().optional(),
    maxPages: z.number().int().positive().optional(),
    isOnboarding: z.boolean().optional(),
    strategy: z.enum(['full', 'smart']).optional(),
    trigger: z.enum(['manual', 'scheduled']).optional(),
  }),
  // cloud/src/routes/crawl.ts → updateCrawlConfigSchema
  updateCrawlConfig: z.object({
    workspaceId: z.string().optional(),
    strategy: z.enum(['full', 'smart']).optional(),
    schedule: z.enum(['none', 'daily', 'weekly', 'monthly']).optional(),
    preferredHour: z.number().int().min(0).max(23).optional(),
    maxPages: z.number().int().positive().optional(),
    excludePatterns: z.array(z.string()).optional(),
    excludeSelectors: z.array(z.string()).optional(),
    includePatterns: z.array(z.string()).optional(),
    overagesEnabled: z.boolean().optional(),
  }),
  // cloud/src/routes/tenant.ts → createWorkspaceBodySchema.
  // The cloud route's body actually accepts `description` and `source`
  // as well, but they are dropped on the server side — so we model the
  // *effective* contract here (what MCP should emit) and use strict mode
  // to catch the easy regression of re-introducing `platform` /
  // `description` to the MCP inputSchema.
  createWorkspace: z
    .object({
      workspaceId: z
        .string()
        .min(3)
        .max(50)
        .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
      name: z.string().optional(),
      siteUrl: z.string().optional(),
    })
    .strict(),
  // cloud/src/routes/tenant.ts → updateWorkspaceBodySchema.
  // Mirrors the cloud's `.refine(name || domain)` constraint as well.
  updateWorkspace: z
    .object({
      name: z.string().min(1).max(200).optional(),
      domain: z.string().min(1).max(255).optional(),
    })
    .strict()
    .refine((v) => v.name !== undefined || v.domain !== undefined, {
      message: 'At least one field (name, domain) must be provided',
    }),
  // cloud/src/routes/products.ts → productSchema.
  // Fields below are a superset of what MCP tools currently emit,
  // intersected with the cloud's actual allowed keys. Nullability
  // mirrors the cloud (`.min(0).nullable().optional()` collapses to
  // `.nullable().optional()` for the subset of cloud checks the MCP
  // server ever triggers).
  upsertProduct: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      content: z.string().optional(),
      excerpt: z.string().optional(),
      price: z.number().nullable().optional(),
      salePrice: z.number().nullable().optional(),
      image: z.string().nullable().optional(),
      url: z.string().optional(),
      categories: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      brands: z.array(z.string()).optional(),
      stockStatus: z.enum(['instock', 'outofstock', 'onbackorder']).optional(),
      sku: z.string().optional(),
    })
    .strict(),
  // cloud/src/routes/posts.ts → postSchema.
  upsertPost: z
    .object({
      id: z.string().min(1),
      title: z.string().min(1),
      content: z.string().optional(),
      url: z.string().optional(),
      excerpt: z.string().optional(),
      tags: z.array(z.string()).optional(),
      categories: z.array(z.string()).optional(),
      publishedAt: z.string().nullable().optional(),
    })
    .strict(),
  // cloud/src/routes/products.ts / posts.ts → searchSchema (both
  // identical on the fields we send). `filters` mirrors the products
  // route's value union — string | number | boolean | string[] | object
  // — so nested operator objects like { price: { gte: 50, lte: 200 } }
  // round-trip through the schema instead of getting filtered out.
  search: z
    .object({
      text: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      filters: z
        .record(
          z.string(),
          z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.object({}).passthrough()]),
        )
        .optional(),
    })
    .strict(),
  // cloud/src/routes/chat.ts → chatSchema
  chat: z.object({
    message: z.string().min(1),
    threadId: z.string().min(1),
    stream: z.boolean().optional(),
  }),
};

// ── Fake MCP server ─────────────────────────────────────────────────
// Emulates `McpServer.registerTool` closely enough for our purposes:
// - Stores name + inputSchema + handler
// - On invocation, Zod-parses the raw args against the recorded
//   inputSchema and throws like the real SDK would on a mismatch.
// This is what makes the test suite catch tool-schema typos that the
// previous "call handler directly" approach missed.

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (rawArgs: unknown) => Promise<unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

function makeServer() {
  const calls: RegisteredTool[] = [];
  const registerTool = vi.fn(
    (
      name: string,
      meta: { description: string; inputSchema: z.ZodRawShape },
      handler: (rawArgs: unknown) => Promise<unknown>,
    ) => {
      const compiled = z.object(meta.inputSchema);
      calls.push({
        name,
        description: meta.description,
        inputSchema: meta.inputSchema,
        handler,
        async call(args) {
          const parsed = compiled.parse(args);
          return handler(parsed);
        },
      });
    },
  );
  return {
    server: { registerTool } as unknown as Parameters<typeof registerWorkspaceTools>[0],
    calls,
    byName(name: string): RegisteredTool | undefined {
      return calls.find((c) => c.name === name);
    },
    names(): string[] {
      return calls.map((c) => c.name);
    },
  };
}

function ctxFor(scopes: string[], keyType: Whoami['keyType'] = 'secret'): ToolContext {
  return {
    client: CLIENT,
    who: {
      tenantId: 't-1',
      tier: 'pro',
      apiKeyId: 'k-1',
      keyType,
      scopes,
    },
  };
}

function lastRequestBody(): Record<string, unknown> {
  const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
  return (init as { body?: Record<string, unknown> })?.body ?? {};
}

function lastRequestHeaders(): Record<string, string> {
  const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
  return (init as { headers?: Record<string, string> })?.headers ?? {};
}

function lastRequestPath(): string {
  const [, init] = hoisted.request.mock.calls.at(-1) ?? [];
  return (init as { path?: string })?.path ?? '';
}

beforeEach(() => {
  hoisted.request.mockReset();
  hoisted.request.mockResolvedValue({});
});

// ── Workspaces ───────────────────────────────────────────────────────

describe('registerWorkspaceTools', () => {
  it('registers all five workspace tools for a secret tenant-admin key', () => {
    const { server, names } = makeServer();
    const count = registerWorkspaceTools(server, ctxFor(['tenant:admin']));
    expect(count).toBe(5);
    expect(names().sort()).toEqual(
      ['create_workspace', 'delete_workspace', 'get_workspace_settings', 'list_workspaces', 'update_workspace'].sort(),
    );
  });

  it('registers NONE of the workspace tools for a publishable widget key', () => {
    const { server } = makeServer();
    expect(registerWorkspaceTools(server, ctxFor(['chat', 'search:products'], 'publishable'))).toBe(0);
  });

  it('create_workspace POSTs to /tenant/workspaces and round-trips against the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('create_workspace')?.call({ workspaceId: 'acme', name: 'Acme Inc.', siteUrl: 'https://acme.test' });
    expect(hoisted.request).toHaveBeenCalledWith(CLIENT, {
      method: 'POST',
      path: '/tenant/workspaces',
      body: { workspaceId: 'acme', name: 'Acme Inc.', siteUrl: 'https://acme.test' },
    });
    expect(() => CLOUD_SCHEMAS.createWorkspace.parse(lastRequestBody())).not.toThrow();
  });

  it('create_workspace strips `platform` / `description` from the outgoing body', async () => {
    // Regression for the audit finding: the previous inputSchema
    // advertised `platform` and `description`, but the cloud route
    // ignored both (hardcoding `platform: 'wordpress'` and never
    // reading `description`). The fix is to drop those keys from the
    // inputSchema — Zod's default behaviour then strips them on parse,
    // so even if an agent still passes them, the cloud never sees them.
    // We assert on the OUTGOING body (what the cloud receives) since
    // that is the contract worth pinning.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('create_workspace')?.call({
      workspaceId: 'acme',
      name: 'Acme',
      platform: 'shopify',
      description: 'My store',
    });
    const body = lastRequestBody();
    expect(body.platform).toBeUndefined();
    expect(body.description).toBeUndefined();
    expect(body).toEqual({ workspaceId: 'acme', name: 'Acme' });
    expect(() => CLOUD_SCHEMAS.createWorkspace.parse(body)).not.toThrow();
  });

  it('create_workspace rejects invalid slugs (enforces slug regex for NEW workspaces)', async () => {
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    // Contains capital letters and a space — disallowed for new workspaces.
    await expect(byName('create_workspace')?.call({ workspaceId: 'Acme Store' })).rejects.toThrow();
  });

  it('update_workspace PUTs to /tenant/workspaces/:id and round-trips against the cloud schema', async () => {
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('update_workspace')?.call({ workspaceId: 'acme', name: 'Acme v2' });
    expect(lastRequestPath()).toBe('/tenant/workspaces/acme');
    expect(lastRequestBody()).toEqual({ name: 'Acme v2' });
    expect(() => CLOUD_SCHEMAS.updateWorkspace.parse(lastRequestBody())).not.toThrow();
  });

  it('update_workspace strips `platform` from the outgoing body', async () => {
    // The old MCP schema accepted `platform`; the cloud's
    // updateWorkspaceBodySchema does not, so the field was silently
    // dropped server-side. Dropping it from the inputSchema means Zod
    // strips it client-side instead — same end-state, but now the
    // contract is enforced at the boundary where the agent can see it.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('update_workspace')?.call({ workspaceId: 'acme', name: 'Acme v2', platform: 'shopify' });
    const body = lastRequestBody();
    expect(body.platform).toBeUndefined();
    expect(body).toEqual({ name: 'Acme v2' });
    expect(() => CLOUD_SCHEMAS.updateWorkspace.parse(body)).not.toThrow();
  });

  it('update_workspace requires at least one of name/domain (mirrors the cloud .refine())', async () => {
    // The handler throws SavantoApiError, which maybeRegisterTool
    // converts into a structured `isError: true` envelope (rather than
    // letting it propagate as a JS exception) — that's the same shape
    // every other API failure surfaces with, so we assert on it
    // directly. The key guarantee is that no network call happens.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    const result = (await byName('update_workspace')?.call({ workspaceId: 'acme' })) as {
      isError?: boolean;
      structuredContent?: { error?: { status?: number; code?: string; message?: string } };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.error).toMatchObject({
      status: 400,
      code: 'INVALID_REQUEST',
      message: expect.stringMatching(/at least one field/i),
    });
    expect(hoisted.request).not.toHaveBeenCalled();
  });

  it('get_workspace_settings accepts loose workspace ids and URL-encodes them', async () => {
    // Historical workspaces may have IDs that contain spaces or capitals.
    // The tool schema is intentionally permissive for READ paths; strict
    // validation happens only at create time.
    const { server, byName } = makeServer();
    registerWorkspaceTools(server, ctxFor(['*']));
    await byName('get_workspace_settings')?.call({ workspaceId: 'acme store' });
    expect(lastRequestPath()).toBe('/workspace/acme%20store/details');
  });
});

// ── Crawl ────────────────────────────────────────────────────────────

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
});

// ── Chat ─────────────────────────────────────────────────────────────

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
