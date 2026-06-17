/**
 * Prompt tools: CRUD over a workspace's prompt suggestions — the canned
 * questions / quick-replies shown in the chat widget, optionally with a
 * pinned canned response and linked products/posts.
 *
 * Unlike products/posts, the cloud prompt schema uses `id` directly (optional —
 * auto-generated when omitted) and is strict, so there's no field translation:
 * the tool fields map 1:1 to the cloud body. Workspace via X-Workspace-ID header.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { CONFIRM_ARG, LIST_PAGINATION, WORKSPACE_ID_SCHEMA as WORKSPACE_ID_ARG } from '../schemas/common.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

// Prompt fields (agent-facing == cloud, since the cloud schema is strict and
// uses these exact names). Shared by upsert + bulk upsert.
const promptItemShape = {
  id: z.string().min(1).max(100).optional().describe('Prompt id. Omit to auto-generate; provide to update in place.'),
  prompt: z.string().min(1).max(1000).describe('The suggested question / quick-reply text shown to the visitor.'),
  title: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  cannedResponse: z
    .string()
    .max(5000)
    .optional()
    .describe('Pinned answer. With overrideMode="override" it replaces the AI answer for this prompt.'),
  responseFormat: z.enum(['markdown', 'text', 'html']).optional(),
  overrideMode: z
    .enum(['override', 'fallback'])
    .optional()
    .describe('How cannedResponse is used: "override" always; "fallback" only when the AI has no answer.'),
  productIds: z.array(z.string().max(100)).max(50).optional().describe('Product external IDs to attach to the reply.'),
  postIds: z.array(z.string().max(100)).max(50).optional(),
  followUpIds: z.array(z.string().max(100)).max(20).optional().describe('Prompt ids to suggest as follow-ups.'),
  tags: z.array(z.string().max(50)).max(20).optional(),
  categories: z.array(z.string().max(50)).max(10).optional(),
  status: z.string().max(50).optional(),
  priority: z.number().int().min(0).max(9999).optional().describe('Higher shows earlier.'),
  icon: z.string().max(10).optional().describe('Emoji or short icon token.'),
} as const;

export function registerPromptTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'upsert_prompt',
      description:
        'Create or update a prompt suggestion (a canned question shown in the widget). Provide `id` to update an existing one, omit it to create. Optionally pin a `cannedResponse` and attach products/posts.',
      scope: 'admin:prompts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, ...promptItemShape },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/prompts',
          headers: { 'X-Workspace-ID': workspaceId },
          body,
        });
        return okResult(data, `Upserted prompt in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_upsert_prompts',
      description: 'Create or update up to 100 prompt suggestions in one call.',
      scope: 'admin:prompts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        prompts: z.array(z.object(promptItemShape)).min(1).max(100),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: '/prompts/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { entities: args.prompts },
        });
        return okResult(data, `Bulk-upserted ${args.prompts.length} prompt(s) into "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_prompts',
      description: 'List prompt suggestions in a workspace. Paginated.',
      scope: ['prompts:read', 'admin:prompts'],
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, ...LIST_PAGINATION },
      handler: async ({ client }, args) => {
        const { workspaceId, ...query } = args;
        const data = await request(client, {
          path: '/prompts',
          headers: { 'X-Workspace-ID': workspaceId },
          query,
        });
        return okResult(data, `Listed prompts in "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_prompt',
      description: 'Retrieve a single prompt suggestion by id.',
      scope: 'admin:prompts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, promptId: z.string().min(1) },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/prompts/${encodeURIComponent(args.promptId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data, `Prompt "${args.promptId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'search_prompts',
      description: 'Find prompt suggestions matching a query. Useful before adding a new one to avoid duplicates.',
      // Cloud POST /prompts/search requires prompts:read ONLY (not admin).
      scope: 'prompts:read',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, query, ...rest } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/prompts/search',
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
      name: 'delete_prompt',
      description: 'Delete a single prompt suggestion by id. Irreversible — confirm with the user first.',
      scope: 'admin:prompts',
      inputSchema: { workspaceId: WORKSPACE_ID_ARG, promptId: z.string().min(1), confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/prompts/${encodeURIComponent(args.promptId)}`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data ?? { deleted: true }, `Deleted prompt "${args.promptId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_delete_prompts',
      description: 'Delete up to 100 prompt suggestions by id. Irreversible — confirm with the user first.',
      scope: 'admin:prompts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        promptIds: z.array(z.string().min(1)).min(1).max(100),
        confirm: CONFIRM_ARG,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: '/prompts/bulk',
          headers: { 'X-Workspace-ID': args.workspaceId },
          body: { ids: args.promptIds },
        });
        return okResult(data, `Bulk-deleted ${args.promptIds.length} prompt(s) from "${args.workspaceId}".`);
      },
    })
  )
    registered++;

  return registered;
}
