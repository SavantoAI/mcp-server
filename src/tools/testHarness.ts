/**
 * Shared test harness for the per-domain MCP tool test files.
 *
 * Each `*.test.ts` owns its own `vi.mock('../utils/fetch.js')` (mocking is
 * file-scoped in vitest) and passes the resulting request spy to
 * `createRequestProbe` to get the `lastRequest*` accessors. `makeServer` /
 * `ctxFor` are mock-independent and live here so they aren't copied per file.
 *
 * The fake server emulates `McpServer.registerTool`: it stores name +
 * inputSchema + handler, and on `call()` Zod-parses the raw args against the
 * advertised inputSchema first — exactly like the SDK at runtime — so a test
 * can't paper over a misnamed tool field by handing the handler cloud-shaped
 * args directly.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Mock, vi } from 'vitest';
import { type ZodRawShape, z } from 'zod';
import type { SavantoClient } from '../utils/fetch.js';
import type { Whoami } from '../whoami.js';

export const CLIENT: SavantoClient = { baseUrl: 'http://localhost:3001', apiKey: 'if_sk_test' };

export interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (rawArgs: unknown) => Promise<unknown>;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

export function makeServer() {
  const calls: RegisteredTool[] = [];
  const registerTool = vi.fn(
    (
      name: string,
      meta: { description: string; inputSchema: ZodRawShape },
      handler: (rawArgs: unknown) => Promise<unknown>,
    ) => {
      const compiled = z.object(meta.inputSchema);
      calls.push({
        name,
        description: meta.description,
        inputSchema: meta.inputSchema,
        handler,
        async call(args) {
          const parsed = compiled.parse(args);
          return handler(parsed);
        },
      });
    },
  );
  return {
    server: { registerTool } as unknown as McpServer,
    calls,
    byName(name: string): RegisteredTool | undefined {
      return calls.find((c) => c.name === name);
    },
    names(): string[] {
      return calls.map((c) => c.name);
    },
  };
}

export function ctxFor(scopes: string[], keyType: Whoami['keyType'] = 'secret') {
  return {
    client: CLIENT,
    who: { tenantId: 't-1', tier: 'pro', apiKeyId: 'k-1', keyType, scopes } as Whoami,
  };
}

/**
 * Bind the `lastRequest*` accessors to a file's hoisted `request` mock. Each
 * test file: `const { lastRequestBody, ... } = createRequestProbe(hoisted.request);`
 */
export function createRequestProbe(requestMock: Mock) {
  const lastInit = () => (requestMock.mock.calls.at(-1) ?? [])[1] as Record<string, unknown> | undefined;
  return {
    lastRequestBody: (): Record<string, unknown> => (lastInit()?.body as Record<string, unknown>) ?? {},
    lastRequestHeaders: (): Record<string, string> => (lastInit()?.headers as Record<string, string>) ?? {},
    lastRequestPath: (): string => (lastInit()?.path as string) ?? '',
  };
}
