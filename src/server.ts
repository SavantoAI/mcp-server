/**
 * Factory for the Savanto MCP server.
 *
 * Kept transport-agnostic so the same `createServer(...)` call can be
 * wired into stdio (today), Streamable HTTP (later), or an in-process
 * client for tests. The only async work done at creation time is the
 * whoami probe — everything else is synchronous tool registration.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { countBuiltInSkills, registerSkillPrompts } from './skills.js';
import { registerChatTools } from './tools/chat.js';
import { registerContentTools } from './tools/content.js';
import { registerCrawlTools } from './tools/crawl.js';
import { registerDiagnosticTools } from './tools/diagnostics.js';
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
    { name: 'savanto-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        prompts: {},
      },
      // MCP clients surface this to humans when they're deciding whether
      // to trust the server. Keep it short and non-marketing.
      instructions:
        'Savanto AI MCP server — tools to provision workspaces, ingest content, run crawls, and test the chat pipeline. ' +
        "Prompts below are multi-step playbooks (Skills) for common workflows like 'onboard a WordPress site'.",
    },
  );

  const ctx = { client: opts.client, who };

  let tools = 0;
  tools += registerWorkspaceTools(server, ctx);
  tools += registerCrawlTools(server, ctx);
  tools += registerContentTools(server, ctx);
  tools += registerChatTools(server, ctx);
  tools += registerDiagnosticTools(server, ctx);

  const skills = registerSkillPrompts(server);

  return { server, whoami: who, toolsRegistered: tools, skillsRegistered: skills };
}

export { countBuiltInSkills };
