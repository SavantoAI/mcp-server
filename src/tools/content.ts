/**
 * Content tools: products, posts, and semantic search over both.
 *
 * The upsert tools use Savanto's "external ID" model — callers decide the
 * ID (usually the store's native product/post ID), and upsert is
 * idempotent keyed on it. Agents provisioning a fresh workspace typically
 * combine these with a `list` or CSV read on the source system to seed
 * the KB without relying on a crawl.
 *
 * The two search tools are important enough to expose even though they
 * duplicate the chat tool's functionality — they return structured
 * results (hits + scores + snippets) which an agent can reason over,
 * whereas `chat` returns a conversational string.
 *
 * ── Field-name translation ─────────────────────────────────────────
 * The tool input schemas are agent-friendly (`externalId`, `query`,
 * `category`, camelCase stockStatus). The cloud contract uses
 * (`id`, `text`, `categories[]`, lowercase stockStatus). Each handler
 * translates at the boundary so the wire payload matches what the cloud
 * Zod schemas accept. If you touch these translations, update
 * `tools.test.ts` which imports the cloud schemas to round-trip-verify
 * the outgoing body.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

const WORKSPACE_ID_ARG = z.string().min(1).describe('Target workspace slug.');

const STOCK_STATUS_MAP = {
  inStock: 'instock',
  outOfStock: 'outofstock',
  preorder: 'onbackorder',
} as const;

export function registerContentTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'upsert_product',
      description:
        'Create or update a product in the knowledge base. Idempotent on `externalId` — re-calling with the same externalId updates the existing document and regenerates embeddings.',
      scope: 'admin:products',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
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
          .describe(
            'Single primary category. For multi-category products, pass `categories` instead. If BOTH are given, `category` is prepended and duplicates are removed.',
          ),
        categories: z
          .array(z.string())
          .optional()
          .describe(
            'List of categories. Merged with `category` when both are given — `category` is prepended, `categories` order is preserved, duplicates removed.',
          ),
        tags: z.array(z.string()).optional(),
        brands: z.array(z.string()).optional(),
        stockStatus: z
          .enum(['inStock', 'outOfStock', 'preorder'])
          .optional()
          .describe("Stock state. `preorder` maps to the cloud's `onbackorder`."),
        sku: z.string().optional(),
      },
      handler: async ({ client }, args) => {
        // Cloud schema uses `id` (not `externalId`), `categories[]` (not
        // `category`), and lowercase stock-status enum values. Translate
        // here; keep the agent-facing names readable above.
        const { workspaceId, externalId, category, categories, stockStatus, ...rest } = args;
        const mergedCategories: string[] | undefined =
          category || (categories && categories.length > 0)
            ? Array.from(new Set([...(category ? [category] : []), ...(categories ?? [])]))
            : undefined;
        const body: Record<string, unknown> = {
          ...rest,
          id: externalId,
          ...(mergedCategories ? { categories: mergedCategories } : {}),
          ...(stockStatus ? { stockStatus: STOCK_STATUS_MAP[stockStatus] } : {}),
        };
        const data = await request(client, {
          method: 'POST',
          path: '/products',
          headers: { 'X-Workspace-ID': workspaceId },
          body,
        });
        return okResult(data, `Upserted product "${externalId}" in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'upsert_post',
      description:
        'Create or update a post/article in the knowledge base. Idempotent on `externalId`. Use this to seed help-center articles, blog content, or PDP long-form text that should be searchable.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        externalId: z.string().min(1),
        title: z.string().min(1),
        content: z.string().min(1).describe('Full body text (markdown or plain text). Will be chunked and embedded.'),
        url: z.string().url().optional(),
        excerpt: z.string().optional(),
        tags: z.array(z.string()).optional(),
        categories: z.array(z.string()).optional(),
        publishedAt: z.string().datetime().optional(),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, externalId, ...rest } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/posts',
          headers: { 'X-Workspace-ID': workspaceId },
          body: { ...rest, id: externalId },
        });
        return okResult(data, `Upserted post "${externalId}" in "${workspaceId}".`);
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
          // Mirror cloud/src/routes/products.ts → searchSchema.filters:
          // each value can be a primitive, an array of strings, OR a
          // nested operator object like { gte: 50, lte: 200 } or
          // { in: ['a', 'b'] }. Without the object branch the tool
          // would reject the very ranges the cloud knows how to handle
          // and force agents into the flat `price_min`/`price_max`
          // shape, which silently doesn't compose with other ranges.
          // Use the two-arg form of `.record(key, value)` — Zod v3 accepts
          // both `.record(value)` and `.record(key, value)`, but Zod v4
          // requires the key schema explicitly. The two-arg form is the
          // forward-compatible spelling.
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
