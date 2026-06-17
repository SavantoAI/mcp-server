/**
 * Content tools: products, posts, and semantic search over both, plus the full
 * content lifecycle (bulk upsert, list, get, patch, delete, bulk delete).
 *
 * The write tools use Savanto's "external ID" model — callers decide the ID
 * (usually the store's native product/post ID), and upsert is idempotent keyed
 * on it. get/patch/delete address a document by that same external id.
 *
 * The two search tools return structured results (hits + scores + snippets) an
 * agent can reason over, vs. `chat` which returns a conversational string.
 *
 * ── Field-name translation ─────────────────────────────────────────
 * The tool input schemas are agent-friendly (`externalId`, `query`, `category`,
 * camelCase stockStatus). The cloud contract uses (`id`, `text`, `categories[]`,
 * lowercase stockStatus). `buildProductBody` / `buildPostBody` translate at the
 * boundary so the wire payload matches the cloud Zod schemas. If you touch these,
 * update `tools.test.ts` (it round-trips the outgoing body through cloud mirrors).
 *
 * Workspace is always passed via the `X-Workspace-ID` header, never the path.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { CONFIRM_ARG, LIST_PAGINATION, WORKSPACE_ID_SCHEMA as WORKSPACE_ID_ARG } from '../schemas/common.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

const EXTERNAL_ID_ARG = z
  .string()
  .min(1)
  .describe('The external ID the document was upserted with (your store/CMS ID).');
const INDEX_STATUS = z.enum(['active', 'hidden', 'disabled']);

const STOCK_STATUS_MAP = {
  inStock: 'instock',
  outOfStock: 'outofstock',
  preorder: 'onbackorder',
} as const;

// Per-product fields (agent-facing). Shared by upsert_product and
// bulk_upsert_products so the two can't drift.
const productItemShape = {
  externalId: z.string().min(1).describe('Stable ID from your store (e.g. Shopify variant GID, WC product ID).'),
  name: z.string().min(1),
  content: z.string().optional().describe('Long-form product description. Will be chunked and embedded.'),
  excerpt: z.string().optional().describe('Short summary for search result snippets.'),
  url: z.string().url().optional(),
  price: z.number().optional(),
  salePrice: z.number().optional(),
  image: z.string().url().optional(),
  category: z
    .string()
    .optional()
    .describe('Single primary category. Merged with `categories` when both are given (prepended, deduped).'),
  categories: z.array(z.string()).optional().describe('List of categories. Merged with `category` when both given.'),
  tags: z.array(z.string()).optional(),
  brands: z.array(z.string()).optional(),
  stockStatus: z
    .enum(['inStock', 'outOfStock', 'preorder'])
    .optional()
    .describe("Stock state. `preorder` maps to the cloud's `onbackorder`."),
  sku: z.string().optional(),
} as const;

// Per-post fields (agent-facing). Shared by upsert_post and bulk_upsert_posts.
const postItemShape = {
  externalId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1).describe('Full body text (markdown or plain text). Will be chunked and embedded.'),
  url: z.string().url().optional(),
  excerpt: z.string().optional(),
  tags: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  publishedAt: z.string().datetime().optional(),
} as const;

/** Translate an agent-facing product item to the cloud wire shape (id, merged categories, lowercase stock). */
function buildProductBody(item: Record<string, unknown>): Record<string, unknown> {
  const { externalId, category, categories, stockStatus, ...rest } = item as {
    externalId: string;
    category?: string;
    categories?: string[];
    stockStatus?: keyof typeof STOCK_STATUS_MAP;
    [k: string]: unknown;
  };
  const mergedCategories =
    category || (categories && categories.length > 0)
      ? Array.from(new Set([...(category ? [category] : []), ...(categories ?? [])]))
      : undefined;
  return {
    ...rest,
    id: externalId,
    ...(mergedCategories ? { categories: mergedCategories } : {}),
    ...(stockStatus ? { stockStatus: STOCK_STATUS_MAP[stockStatus] } : {}),
  };
}

/** Translate an agent-facing post item to the cloud wire shape (id). */
function buildPostBody(item: Record<string, unknown>): Record<string, unknown> {
  const { externalId, ...rest } = item as { externalId: string; [k: string]: unknown };
  return { ...rest, id: externalId };
}

export function registerContentTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  // ── Products ───────────────────────────────────────────────────────

  if (
    maybeRegisterTool(server, ctx, {
      name: 'upsert_product',
      description:
        'Create or update a product in the knowledge base. Idempotent on `externalId` — re-calling with the same externalId updates the existing document and regenerates embeddings.',
      scope: 'admin:products',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, ...productItemShape },
      handler: async ({ client }, args) => {
        const { workspaceId, ...item } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/products',
          headers: { 'X-Workspace-ID': workspaceId },
          body: buildProductBody(item),
        });
        return okResult(data, `Upserted product "${item.externalId}" in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_upsert_products',
      description:
        'Create or update up to 100 products in one call. Idempotent on each `externalId`. Use this to seed a catalog instead of many single upserts.',
      scope: 'admin:products',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        products: z.array(z.object(productItemShape)).min(1).max(100),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: '/products/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { entities: args.products.map((p) => buildProductBody(p)) },
        });
        return okResult(data, `Bulk-upserted ${args.products.length} product(s) into "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_products',
      description: 'List products in a workspace with optional filters and pagination. Use to audit what is indexed.',
      // Cloud list accepts admin OR search (see products.ts list handler).
      scope: ['admin:products', 'search:products'],
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        ...LIST_PAGINATION,
        categories: z.string().optional().describe('Comma-separated category names to filter by.'),
        tags: z.string().optional().describe('Comma-separated tags to filter by.'),
        status: z
          .string()
          .optional()
          .describe('Filter by the product\'s publication status (e.g. "publish"), NOT index status.'),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...query } = args;
        const data = await request(client, {
          path: '/products',
          headers: { 'X-Workspace-ID': workspaceId },
          query,
        });
        return okResult(data, `Listed products in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_product',
      description: 'Retrieve a single product by its external ID.',
      scope: 'admin:products',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: EXTERNAL_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/products/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data, `Product "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'patch_product',
      description:
        'Partially update a product. Currently supports `indexStatus` — set `hidden`/`disabled` to keep a product indexed for context but out of user-facing results, or `active` to restore it.',
      scope: 'admin:products',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: EXTERNAL_ID_ARG, indexStatus: INDEX_STATUS },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'PATCH',
          path: `/products/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { indexStatus: args.indexStatus },
        });
        return okResult(data, `Patched product "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_product',
      description: 'Delete a single product by external ID. Irreversible — confirm with the user first.',
      scope: 'admin:products',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: EXTERNAL_ID_ARG, confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/products/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data ?? { deleted: true }, `Deleted product "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_delete_products',
      description: 'Delete up to 100 products by external ID. Irreversible — confirm with the user first.',
      scope: 'admin:products',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        externalIds: z.array(z.string().min(1)).min(1).max(100),
        confirm: CONFIRM_ARG,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: '/products/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { ids: args.externalIds },
        });
        return okResult(data, `Bulk-deleted ${args.externalIds.length} product(s) from "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'search_products',
      description:
        'Semantic + keyword hybrid search across products in a workspace. Returns ranked hits with scores and snippets. Use this to verify product data is discoverable before wiring the widget.',
      scope: 'search:products',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        query: z.string().min(1).describe('Natural-language query, e.g. "waterproof hiking boots for women".'),
        limit: z.number().int().min(1).max(50).optional().describe('Max hits to return. Default 10.'),
        filters: z
          .record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.object({}).passthrough()]),
          )
          .optional()
          .describe(
            'Optional structured filters. Values can be primitives, arrays of strings, or nested operator objects. Examples: {"category": "footwear", "price_max": 200} (flat) or {"price": {"gte": 50, "lte": 200}} (range).',
          ),
      },
      handler: async ({ client }, args) => {
        // Cloud schema uses `text` (not `query`).
        const { workspaceId, query, ...rest } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/products/search',
          headers: { 'X-Workspace-ID': workspaceId },
          body: { ...rest, text: query },
        });
        return okResult(data);
      },
    })
  )
    registered++;

  // ── Posts ──────────────────────────────────────────────────────────

  if (
    maybeRegisterTool(server, ctx, {
      name: 'upsert_post',
      description:
        'Create or update a post/article in the knowledge base. Idempotent on `externalId`. Use this to seed help-center articles, blog content, or PDP long-form text that should be searchable.',
      scope: 'admin:posts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, ...postItemShape },
      handler: async ({ client }, args) => {
        const { workspaceId, ...item } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/posts',
          headers: { 'X-Workspace-ID': workspaceId },
          body: buildPostBody(item),
        });
        return okResult(data, `Upserted post "${item.externalId}" in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_upsert_posts',
      description: 'Create or update up to 100 posts/articles in one call. Idempotent on each `externalId`.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        posts: z.array(z.object(postItemShape)).min(1).max(100),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: '/posts/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { entities: args.posts.map((p) => buildPostBody(p)) },
        });
        return okResult(data, `Bulk-upserted ${args.posts.length} post(s) into "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  // NOTE: no `list_posts` — the cloud posts router has no `GET /posts` (only
  // upsert on that path). Posts discovery goes through `search_posts`; the
  // ids-only `GET /posts/ids` isn't worth a dedicated tool here.

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_post',
      description: 'Retrieve a single post by its external ID.',
      scope: 'admin:posts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: EXTERNAL_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/posts/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data, `Post "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'patch_post',
      description: 'Partially update a post. Currently supports `indexStatus` (active/hidden/disabled).',
      scope: 'admin:posts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: EXTERNAL_ID_ARG, indexStatus: INDEX_STATUS },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'PATCH',
          path: `/posts/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { indexStatus: args.indexStatus },
        });
        return okResult(data, `Patched post "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_post',
      description: 'Delete a single post by external ID. Irreversible — confirm with the user first.',
      scope: 'admin:posts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: EXTERNAL_ID_ARG, confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/posts/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data ?? { deleted: true }, `Deleted post "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_delete_posts',
      description: 'Delete up to 100 posts by external ID. Irreversible — confirm with the user first.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        externalIds: z.array(z.string().min(1)).min(1).max(100),
        confirm: CONFIRM_ARG,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: '/posts/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { ids: args.externalIds },
        });
        return okResult(data, `Bulk-deleted ${args.externalIds.length} post(s) from "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'search_posts',
      description:
        'Semantic + keyword hybrid search across posts/articles. Returns ranked hits with snippets. Use this to debug "why is the chat not answering question X" — if posts search returns nothing, the KB is missing content.',
      scope: 'search:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, query, ...rest } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/posts/search',
          headers: { 'X-Workspace-ID': workspaceId },
          body: { ...rest, text: query },
        });
        return okResult(data);
      },
    })
  )
    registered++;

  return registered;
}
