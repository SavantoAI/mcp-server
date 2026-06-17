/**
 * Webhook tools: CRUD over a tenant's event webhooks (delivery of chat/content
 * events to external endpoints), plus a connectivity test and delivery stats.
 *
 * Webhooks are tenant-level (not workspace-scoped), so these tools take no
 * workspaceId / X-Workspace-ID. Advanced delivery config (retryPolicy,
 * authConfig, schedule, eventFilters, payloadTemplate) is omitted for now — the
 * cloud schema is non-strict so those simply aren't sent; basic webhooks work.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { CONFIRM_ARG } from '../schemas/common.js';
import { request, SavantoApiError } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

const WEBHOOK_ID_ARG = z.string().min(1).describe('Webhook id (from create_webhook / list_webhooks).');
const HTTP_METHOD = z.enum(['POST', 'PUT', 'PATCH']);

// Optional delivery fields shared by create + update (so they can't drift).
// name/url/events/status differ in required-ness or enum between the two, so
// they're spelled out per tool.
const webhookCommonFields = {
  description: z.string().max(1000).optional(),
  method: HTTP_METHOD.optional().describe('HTTP method for delivery. Default POST.'),
  secret: z.string().optional().describe('Signing secret used to compute the delivery signature.'),
  timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Per-delivery timeout (1000–60000 ms).'),
  headers: z.record(z.string(), z.string()).optional().describe('Static headers to send with each delivery.'),
} as const;

export function registerWebhookTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'create_webhook',
      description:
        'Register a webhook endpoint to receive event notifications. Requires a name, a target URL, and at least one event type. Use test_webhook afterward to verify connectivity.',
      scope: 'admin:webhooks',
      inputSchema: {
        name: z.string().min(1).max(255),
        url: z.string().url(),
        events: z.array(z.string()).min(1).describe('Event types to subscribe to, e.g. ["chat.completed"].'),
        status: z.enum(['active', 'inactive']).optional(),
        ...webhookCommonFields,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { method: 'POST', path: '/webhooks', body: args });
        return okResult(data, `Created webhook "${args.name}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_webhooks',
      description: "List the tenant's webhooks with optional filters, pagination, and sorting.",
      scope: 'admin:webhooks',
      inputSchema: {
        page: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        status: z.enum(['active', 'inactive', 'suspended']).optional(),
        events: z.string().optional().describe('Filter by event type.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: '/webhooks', query: args });
        return okResult(data, 'Listed webhooks.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_webhook',
      description: 'Retrieve a single webhook by id.',
      scope: 'admin:webhooks',
      inputSchema: { webhookId: WEBHOOK_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: `/webhooks/${encodeURIComponent(args.webhookId)}` });
        return okResult(data, `Webhook "${args.webhookId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_webhook',
      description: 'Update a webhook (partial — only supplied fields change). At least one field must be provided.',
      scope: 'admin:webhooks',
      inputSchema: {
        webhookId: WEBHOOK_ID_ARG,
        name: z.string().min(1).max(255).optional(),
        url: z.string().url().optional(),
        events: z.array(z.string()).min(1).optional(),
        status: z.enum(['active', 'inactive', 'suspended']).optional(),
        ...webhookCommonFields,
      },
      handler: async ({ client }, args) => {
        const { webhookId, ...body } = args;
        if (Object.keys(body).length === 0) {
          throw new SavantoApiError({
            status: 400,
            message: 'At least one field to update must be provided',
            code: 'INVALID_REQUEST',
          });
        }
        const data = await request(client, {
          method: 'PUT',
          path: `/webhooks/${encodeURIComponent(webhookId)}`,
          body,
        });
        return okResult(data, `Updated webhook "${webhookId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'test_webhook',
      description: 'Send a test event to a webhook to verify connectivity. Does not affect real deliveries.',
      scope: 'admin:webhooks',
      inputSchema: { webhookId: WEBHOOK_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'POST',
          path: `/webhooks/${encodeURIComponent(args.webhookId)}/test`,
        });
        return okResult(data, `Sent a test event to webhook "${args.webhookId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_webhook_stats',
      description: 'Retrieve delivery statistics (success/failure counts, recent deliveries) for a webhook.',
      scope: 'admin:webhooks',
      inputSchema: { webhookId: WEBHOOK_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: `/webhooks/${encodeURIComponent(args.webhookId)}/stats` });
        return okResult(data, `Delivery stats for webhook "${args.webhookId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_webhook',
      description: 'Delete a webhook by id. Irreversible — confirm with the user first.',
      scope: 'admin:webhooks',
      inputSchema: { webhookId: WEBHOOK_ID_ARG, confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/webhooks/${encodeURIComponent(args.webhookId)}`,
        });
        return okResult(data ?? { deleted: true }, `Deleted webhook "${args.webhookId}".`);
      },
    })
  )
    registered++;

  return registered;
}
