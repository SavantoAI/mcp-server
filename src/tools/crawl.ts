/**
 * Crawl tools.
 *
 * Crawls are long-running (minutes to hours). The agent-friendly shape of
 * this surface is: start a crawl and return a `crawlId`, then poll
 * `get_crawl_status` until the crawl reaches a terminal state. Agents
 * should NOT block on the initial `start_crawl` response — the tool
 * description makes that explicit so the model doesn't wait for a
 * "finished" signal that never comes.
 *
 * The crawl config tool is separate so an agent can tune exclude
 * patterns, depth, and sitemap preferences BEFORE kicking off a long
 * crawl — much cheaper than running to completion and discovering the
 * crawler indexed the /tag/ and /author/ pages.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

const WORKSPACE_ID_ARG = z.string().min(1).describe('Target workspace slug.');

export function registerCrawlTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'start_crawl',
      description:
        'Kick off a website crawl. Returns immediately with a crawlId — DO NOT wait for completion, instead call get_crawl_status periodically (every 10-30s) until status is "completed", "failed", or "cancelled". A full site typically takes 5-60 minutes.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        siteUrl: z
          .string()
          .url()
          .describe('Starting URL, e.g. "https://example.com". The crawler will follow internal links from here.'),
        strategy: z
          .enum(['full', 'smart'])
          .optional()
          .describe(
            '"full" re-indexes everything; "smart" only re-crawls pages whose content hash changed. Default "smart".',
          ),
        maxPages: z
          .number()
          .int()
          .min(1)
          .max(100000)
          .optional()
          .describe('Hard cap on pages crawled. Default set by crawl config.'),
      },
      handler: async ({ client }, args) => {
        // Translate the agent-friendly `siteUrl` to the cloud's `url` field.
        // We keep the tool schema's name because `siteUrl` reads more
        // naturally to an LLM picking args; the cloud contract is the
        // source of truth for the wire shape.
        const { workspaceId, siteUrl, ...rest } = args;
        const data = await request(client, {
          method: 'POST',
          path: '/crawl',
          headers: { 'X-Workspace-ID': workspaceId },
          body: { ...rest, url: siteUrl },
        });
        return okResult(data, `Crawl started for workspace "${workspaceId}".`);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_crawl_status',
      description:
        'Check the progress of a crawl by crawlId. Returns status (running | completed | failed | cancelled) along with pagesFound/Indexed/Skipped counters. Poll this after start_crawl to know when the crawl is done.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        crawlId: z.string().min(1).describe('The crawlId returned from start_crawl.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: `/crawl/${encodeURIComponent(args.crawlId)}/status`,
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_crawl_history',
      description:
        'List recent crawls for a workspace, most recent first. Useful for auditing scheduled crawls and reviewing pageIndexed counts over time.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        limit: z.number().int().min(1).max(100).optional().describe('How many crawls to return. Default 20.'),
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: '/crawl/history',
          headers: { 'X-Workspace-ID': args.workspaceId },
          query: args.limit ? { limit: args.limit } : undefined,
        });
        return okResult(data);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'get_crawl_config',
      description:
        'Read the current crawl configuration for a workspace — exclude patterns, depth, schedule, sitemap URL. Always call this before updating the config, so you do not accidentally blow away existing settings.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
      },
      handler: async ({ client }, args) => {
        const data = await request(client, {
          path: '/crawl/config',
          headers: { 'X-Workspace-ID': args.workspaceId },
        });
        return okResult(data);
      },
    })
  )
    registered++;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'update_crawl_config',
      description:
        'Replace the crawl configuration for a workspace. Accepts regex exclude / include patterns, CSS exclude selectors, recrawl strategy, schedule, page cap, and the preferred hour for scheduled runs. The cloud REPLACES the config — any field you omit reverts to its default. To tweak one setting without losing the rest, ALWAYS call get_crawl_config first and pass its values back in alongside your change.',
      scope: 'admin:posts',
      inputSchema: {
        workspaceId: WORKSPACE_ID_ARG,
        strategy: z
          .enum(['full', 'smart'])
          .optional()
          .describe(
            '"full" re-indexes everything; "smart" only re-crawls pages whose content hash changed. Default "smart".',
          ),
        schedule: z
          .enum(['none', 'daily', 'weekly', 'monthly'])
          .optional()
          .describe('How often to re-crawl automatically. "none" disables scheduled crawls.'),
        preferredHour: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe('UTC hour (0-23) at which the scheduled crawl should run.'),
        maxPages: z.number().int().min(1).max(100000).optional().describe('Hard cap on pages per crawl.'),
        excludePatterns: z
          .array(z.string())
          .optional()
          .describe(
            'Regex URL patterns to skip. Max 50 entries, each ≤200 chars. Example: ["/tag/", "/author/", "\\\\?replytocom="].',
          ),
        includePatterns: z
          .array(z.string())
          .optional()
          .describe('Regex URL patterns to restrict the crawl to. Omit to crawl the whole origin.'),
        excludeSelectors: z
          .array(z.string())
          .optional()
          .describe(
            'CSS selectors whose content should be stripped before indexing, e.g. ["header", ".cookie-banner"].',
          ),
        overagesEnabled: z
          .boolean()
          .optional()
          .describe("Allow crawls to exceed the tier's monthly page quota (billed as overage)."),
      },
      handler: async ({ client }, args) => {
        const { workspaceId, ...body } = args;
        const data = await request(client, {
          method: 'PUT',
          path: '/crawl/config',
          headers: { 'X-Workspace-ID': workspaceId },
          body,
        });
        return okResult(data, `Crawl config updated for "${workspaceId}".`);
      },
    })
  )
    registered++;

  return registered;
}
