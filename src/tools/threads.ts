/**
 * Thread tools: search, inspect, and prune conversation threads — the "review
 * what actually happened" half of the observe → refine loop. An agent searches
 * for failing conversations (e.g. unresolved queries), reads the transcript, and
 * uses that to decide what content/config to change.
 *
 * Tenant-level, scope threads:admin (ADMIN_THREADS). get_thread_messages also
 * accepts the chat scope (the cloud route allows admin:threads OR chat).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { CONFIRM_ARG } from '../schemas/common.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

const THREAD_ID_ARG = z.string().min(1).describe('Thread id (from search_threads).');

export function registerThreadTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'search_threads',
      description:
        'Search conversation threads with filters. `hasUnresolvedQueries: true` surfaces conversations where the assistant could not answer — the best starting point for finding gaps to fix. Supports text, date range, message/token bounds, and sorting.',
      scope: 'threads:admin',
      inputSchema: {
        query: z.string().optional().describe('Free-text match across the transcript.'),
        userId: z.string().optional(),
        dateFrom: z.string().optional().describe('ISO date (inclusive lower bound).'),
        dateTo: z.string().optional().describe('ISO date (inclusive upper bound).'),
        limit: z.number().int().min(1).max(100).optional().describe('Max threads (default 10).'),
        offset: z.number().int().min(0).optional(),
        minMessages: z.number().int().min(0).optional(),
        maxMessages: z.number().int().min(0).optional(),
        minTokens: z.number().int().min(0).optional(),
        maxTokens: z.number().int().min(0).optional(),
        hasUnresolvedQueries: z.boolean().optional().describe('Only threads with at least one unresolved query.'),
        sortBy: z.enum(['timestamp', 'messageCount', 'tokenCount']).optional(),
        sortOrder: z.enum(['asc', 'desc']).optional(),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, { method: 'POST', path: '/threads/search', body: args });
        return okResult(data, 'Thread search results.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_thread_analytics',
      description: 'Aggregate thread analytics (volume, message/token distributions, unresolved-query rate).',
      scope: 'threads:admin',
      inputSchema: {},
      handler: async ({ client }) => {
        const data = await request(client, { path: '/threads/analytics' });
        return okResult(data, 'Thread analytics.');
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_thread',
      description: 'Retrieve a single thread (metadata + summary) by id.',
      scope: 'threads:admin',
      inputSchema: { threadId: THREAD_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: `/threads/${encodeURIComponent(args.threadId)}` });
        return okResult(data, `Thread "${args.threadId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_thread_messages',
      description:
        'Retrieve the full message transcript for a thread. Use after search_threads to read what went wrong.',
      // Cloud route allows admin:threads OR chat.
      scope: ['threads:admin', 'chat'],
      inputSchema: { threadId: THREAD_ID_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, { path: `/threads/${encodeURIComponent(args.threadId)}/messages` });
        return okResult(data, `Transcript for thread "${args.threadId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'delete_thread',
      description: 'Delete a single conversation thread by id. Irreversible — confirm with the user first.',
      scope: 'threads:admin',
      inputSchema: { threadId: THREAD_ID_ARG, confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          method: 'DELETE',
          path: `/threads/${encodeURIComponent(args.threadId)}`,
        });
        return okResult(data ?? { deleted: true }, `Deleted thread "${args.threadId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'bulk_delete_threads',
      description: 'Delete multiple conversation threads by id. Irreversible — confirm with the user first.',
      scope: 'threads:admin',
      inputSchema: { threadIds: z.array(z.string().min(1)).min(1).max(100), confirm: CONFIRM_ARG },
      handler: async ({ client }, args) => {
        const data = await request(client, { method: 'DELETE', path: '/threads', body: { ids: args.threadIds } });
        return okResult(data, `Deleted ${args.threadIds.length} thread(s).`);
      },
    })
  )
    registered++;

  return registered;
}
