/**
 * Analytics tools: read-only observability over search and chat usage — the
 * "observe" half of the configure → observe → refine loop. An agent uses these
 * to find what's underperforming (zero-result searches, low-rated chats), then
 * fixes it with the content/config tools.
 *
 * These are tenant-level reads (scope tenant:admin / ADMIN_TENANT). `workspaceId`
 * is an optional QUERY filter here (not the X-Workspace-ID header the content
 * tools use) — omit it for tenant-wide analytics.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

const WORKSPACE_FILTER = z.string().optional().describe('Restrict to a single workspace; omit for tenant-wide.');
// Cloud clamps days to 90 and topN to 50 (analytics.ts parseIntParam); advertise
// the real ceilings so an agent doesn't think it got a wider window than it did.
const DAYS = z.number().int().min(1).max(90).optional().describe('Look-back window in days (default 30, max 90).');

export function registerAnalyticsTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_search_analytics',
      description:
        'Search usage analytics: top queries, volume, and zero-result rate over the window. Use to spot what visitors search for and where the catalog has gaps.',
      scope: 'tenant:admin',
      inputSchema: {
        days: DAYS,
        topN: z.number().int().min(1).max(50).optional().describe('How many top queries to return (max 50).'),
        source: z.string().optional().describe('Comma-separated sources to filter, e.g. "widget,native".'),
        workspaceId: WORKSPACE_FILTER,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: '/analytics/search', query: args });
        return okResult(data, 'Search analytics.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_chat_analytics',
      description:
        'Chat usage analytics: conversation volume, resolution/handoff signals, and trends over the window. Use to gauge how well the assistant is answering.',
      scope: 'tenant:admin',
      inputSchema: { days: DAYS },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: '/analytics/chat', query: args });
        return okResult(data, 'Chat analytics.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_feedback_analytics',
      description: 'Aggregate feedback analytics (thumbs up/down rates and trends) over a date range.',
      scope: 'tenant:admin',
      inputSchema: {
        dateFrom: z.string().optional().describe('ISO date (inclusive lower bound).'),
        dateTo: z.string().optional().describe('ISO date (inclusive upper bound).'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: '/analytics/feedback', query: args });
        return okResult(data, 'Feedback analytics.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'list_feedback',
      description:
        'List/search visitor feedback entries. Filter by `rating: "negative"` to pull up exactly the answers users marked unhelpful — pair with get_thread_messages to see the failing conversation, then fix the content/config.',
      scope: 'feedback:admin',
      inputSchema: {
        rating: z.enum(['positive', 'negative']).optional(),
        query: z.string().optional().describe('Substring to match in feedback text.'),
        threadId: z.string().optional(),
        userId: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        limit: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).optional(),
        sortOrder: z.enum(['asc', 'desc']).optional(),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: '/feedback', query: args });
        return okResult(data, 'Feedback entries.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'search_search_logs',
      description:
        'Query the raw search-log history with filters. Set `zeroResultsOnly: true` to surface exactly which visitor searches returned nothing — the highest-signal list for deciding what content/products to add.',
      scope: 'tenant:admin',
      inputSchema: {
        query: z.string().optional().describe('Substring to match against logged search text.'),
        zeroResultsOnly: z.boolean().optional().describe('Only return searches that produced no results.'),
        source: z.union([z.string(), z.array(z.string())]).optional(),
        type: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional(),
        sortBy: z.string().optional(),
        sortOrder: z.enum(['asc', 'desc']).optional(),
        workspaceId: WORKSPACE_FILTER,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { method: 'POST', path: '/analytics/searches/search', body: args });
        return okResult(data, 'Search-log results.');
      },
    })
  )
    registered++;

  return registered;
}
