/**
 * Taxonomy tools: CRUD over a workspace's taxonomy terms (categories, tags,
 * product attributes, and other classification used to organize content).
 *
 * Mirrors the content tools' external-ID model and the X-Workspace-ID header
 * convention. `buildTaxonomyBody` translates the agent-facing `externalId` to
 * the cloud's `id`; the cloud is the source of truth for the rest.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { CONFIRM_ARG, LIST_PAGINATION, WORKSPACE_ID_SCHEMA as WORKSPACE_ID_ARG } from '../schemas/common.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

// Per-term fields (agent-facing). Shared by upsert + bulk upsert.
const taxonomyItemShape = {
  externalId: z.string().min(1).describe('Stable ID for the term (your store/CMS term ID).'),
  name: z.string().min(1).max(200).describe('Human-readable term name, e.g. "Running Shoes".'),
  slug: z.string().min(1).describe('URL-safe slug (letters, numbers, hyphens, underscores).'),
  taxonomyName: z
    .string()
    .min(1)
    .describe('The taxonomy this term belongs to, lowercase, e.g. "category", "product_cat", "pa_color".'),
  description: z.string().optional(),
  parent: z.number().int().min(0).optional().describe('Parent term id for hierarchical taxonomies (0 = top level).'),
  type: z.string().optional(),
  taxonomyLabel: z.string().optional().describe('Display label for the taxonomy, e.g. "Color".'),
  hierarchy: z.array(z.string()).optional().describe('Ancestor term names from root to parent.'),
} as const;

function buildTaxonomyBody(item: Record<string, unknown>): Record<string, unknown> {
  const { externalId, ...rest } = item as { externalId: string; [k: string]: unknown };
  return { ...rest, id: externalId };
}

export function registerTaxonomyTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'upsert_taxonomy',
      description:
        'Create or update a taxonomy term (category/tag/attribute). Idempotent on `externalId`. Use to seed the classification an agent can later filter products/posts by.',
      scope: 'admin:taxonomies',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, ...taxonomyItemShape },
      handler: async ({ client }, args) => {
        const { workspaceId, ...item } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/taxonomies',
          headers: { 'X-Workspace-ID': workspaceId },
          body: buildTaxonomyBody(item),
        });
        return okResult(data, `Upserted taxonomy term "${item.externalId}" in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_upsert_taxonomies',
      description: 'Create or update up to 100 taxonomy terms in one call. Idempotent on each `externalId`.',
      scope: 'admin:taxonomies',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        taxonomies: z.array(z.object(taxonomyItemShape)).min(1).max(100),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: '/taxonomies/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { entities: args.taxonomies.map((t) => buildTaxonomyBody(t)) },
        });
        return okResult(data, `Bulk-upserted ${args.taxonomies.length} term(s) into "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_taxonomies',
      description: 'List taxonomy terms in a workspace, optionally filtered by taxonomy name. Paginated.',
      scope: 'admin:taxonomies',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        taxonomyName: z.string().optional().describe('Filter to a single taxonomy, e.g. "category".'),
        ...LIST_PAGINATION,
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...query } = args;
        const data = await request(client, {
          path: '/taxonomies',
          headers: { 'X-Workspace-ID': workspaceId },
          query,
        });
        return okResult(data, `Listed taxonomy terms in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_taxonomy',
      description: 'Retrieve a single taxonomy term by its external ID.',
      scope: 'admin:taxonomies',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: z.string().min(1) },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/taxonomies/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data, `Taxonomy term "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_taxonomy',
      description: 'Delete a single taxonomy term by external ID. Irreversible — confirm with the user first.',
      scope: 'admin:taxonomies',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, externalId: z.string().min(1), confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/taxonomies/${encodeURIComponent(args.externalId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data ?? { deleted: true }, `Deleted taxonomy term "${args.externalId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_delete_taxonomies',
      description: 'Delete up to 100 taxonomy terms by external ID. Irreversible — confirm with the user first.',
      scope: 'admin:taxonomies',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        externalIds: z.array(z.string().min(1)).min(1).max(100),
        confirm: CONFIRM_ARG,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: '/taxonomies/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { ids: args.externalIds },
        });
        return okResult(data, `Bulk-deleted ${args.externalIds.length} term(s) from "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  return registered;
}
