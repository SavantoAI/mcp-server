/**
 * Factory for the Savanto MCP server.
 *
 * Kept transport-agnostic so the same `createServer(...)` call can be
 * wired into stdio (today), Streamable HTTP (later), or an in-process
 * client for tests. The only async work done at creation time is the
 * whoami probe — everything else is synchronous tool registration.
 */

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Single source of truth for the advertised version — read from package.json at
// runtime (rootDir excludes it from a static import). Resolves to the package
// root in both dev (src/) and the built dist/.
const { version: PACKAGE_VERSION } = createRequire(import.meta.url)('../package.json') as { version: string };

import { countBuiltInSkills, registerSkillPrompts } from './skills.js';
import { registerAnalyticsTools } from './tools/analytics.js';
import { registerChatTools } from './tools/chat.js';
import { registerConfigTools } from './tools/config.js';
import { registerContentTools } from './tools/content.js';
import { registerCrawlTools } from './tools/crawl.js';
import { registerDiagnosticTools } from './tools/diagnostics.js';
import { registerPromptTools } from './tools/prompts.js';
import { registerTaxonomyTools } from './tools/taxonomies.js';
import { registerThreadTools } from './tools/threads.js';
import { registerWebhookTools } from './tools/webhooks.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import type { SavantoClient } from './utils/fetch.js';
import { fetchWhoami, type Whoami } from './whoami.js';

export interface CreateServerOptions {
  client: SavantoClient;
  /** Pre-resolved whoami to short-circuit the initial request (useful in tests). */
  whoami?: Whoami;
}

export interface CreatedServer {
  server: McpServer;
  whoami: Whoami;
  toolsRegistered: number;
  skillsRegistered: number;
}

/**
 * Build an MCP server wired to the Savanto API. Runs a whoami probe at startup;
 * throws {@link SavantoApiError} when the key is invalid or the API is unreachable.
 */
export async function createServer(opts: CreateServerOptions): Promise<CreatedServer> {
  const who = opts.whoami ?? (await fetchWhoami(opts.client));
  const server = new McpServer(
    { name: 'savanto-mcp', version: PACKAGE_VERSION },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
      // MCP clients surface this to humans when they're deciding whether
      // to trust the server. Keep it short and non-marketing.
      instructions:
        'Savanto AI MCP server — configure, populate, and operate a Savanto-powered store assistant. ' +
        'Tools cover workspace configuration (settings, custom domains, widget branding), content ' +
        '(products, posts, taxonomies, prompt suggestions), automation (webhooks), and observability ' +
        '(search/chat/feedback analytics and conversation threads) — so you can stand a workspace up, ' +
        'then see what is underperforming and refine it. Tools are filtered to your API key’s scopes. ' +
        'The prompts below are multi-step Skills (playbooks) for common workflows like onboarding a ' +
        'store or auditing and improving an existing one.',
    },
  );

  const ctx = { client: opts.client, who };

  let tools = 0;
  tools += registerWorkspaceTools(server, ctx);
  tools += registerConfigTools(server, ctx);
  tools += registerCrawlTools(server, ctx);
  tools += registerContentTools(server, ctx);
  tools += registerTaxonomyTools(server, ctx);
  tools += registerPromptTools(server, ctx);
  tools += registerWebhookTools(server, ctx);
  tools += registerAnalyticsTools(server, ctx);
  tools += registerThreadTools(server, ctx);
  tools += registerChatTools(server, ctx);
  tools += registerDiagnosticTools(server, ctx);

  const skills = registerSkillPrompts(server);

  return { server, whoami: who, toolsRegistered: tools, skillsRegistered: skills };
}

export { countBuiltInSkills };
