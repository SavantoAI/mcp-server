#!/usr/bin/env node
/**
 * stdio entry point — what Claude Desktop, Cursor, and Windsurf spawn
 * when they boot the MCP server. Reads the API key from the environment,
 * probes whoami, advertises tools, then hands the transport over.
 *
 * Strictly: all human-facing output must go to stderr. MCP treats stdout
 * as the JSON-RPC transport — any stray `console.log` during startup
 * will corrupt the protocol frame and confuse the client.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { describeApiKeyError, loadApiKey, resolveBaseUrl } from './auth.js';
import { createServer } from './server.js';
import { SavantoApiError } from './utils/fetch.js';

async function main(): Promise<void> {
  const keyResult = loadApiKey();
  if (!keyResult.ok) {
    process.stderr.write(`[savanto-mcp] ${describeApiKeyError(keyResult.error)}\n`);
    process.exit(1);
  }
  const baseUrl = resolveBaseUrl();
  const client = { apiKey: keyResult.apiKey, baseUrl };

  let created: Awaited<ReturnType<typeof createServer>>;
  try {
    created = await createServer({ client });
  } catch (err) {
    if (err instanceof SavantoApiError) {
      process.stderr.write(
        `[savanto-mcp] Could not authenticate against ${baseUrl}: HTTP ${err.status}${err.code ? ` ${err.code}` : ''} — ${err.message}\n`,
      );
      process.stderr.write(
        '[savanto-mcp] Check that SAVANTO_API_KEY is a valid secret key (not revoked) and that SAVANTO_API_URL points at the right environment.\n',
      );
    } else {
      process.stderr.write(`[savanto-mcp] Startup failed: ${(err as Error).message}\n`);
    }
    process.exit(1);
  }

  const { server, whoami, toolsRegistered, skillsRegistered } = created;
  process.stderr.write(
    `[savanto-mcp] Connected as ${whoami.tenantId} (${whoami.keyType} key, tier=${whoami.tier}).\n` +
      `[savanto-mcp] Registered ${toolsRegistered} tool(s), ${skillsRegistered} skill(s). Base URL: ${baseUrl}\n`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[savanto-mcp] Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
