/**
 * Chat tool — the single most useful tool for an agent validating a
 * workspace. After provisioning, the agent should send a couple of
 * representative customer questions through `chat` to confirm the KB is
 * answering accurately, then report the transcript back to the human.
 *
 * We expose a non-streaming variant only: MCP tool responses aren't
 * naturally streaming, and the latency difference for dev/validation use
 * cases is negligible.
 */

import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { maybeRegisterTool, type ToolContext } from '../context.js';
import { request } from '../utils/fetch.js';
import { okResult } from '../utils/result.js';

export function registerChatTools(server: McpServer, ctx: ToolContext): number {
  let registered = 0;

  if (
    maybeRegisterTool(server, ctx, {
      name: 'chat',
      description:
        "Send a message through Savanto's multi-agent chat pipeline and get a full, non-streamed response back. Use this to sanity-check that a newly-provisioned workspace answers real customer questions accurately. Supports threading via threadId.",
      scope: 'chat',
      inputSchema: {
        workspaceId: z.string().min(1).describe('Workspace to query against.'),
        message: z.string().min(1).describe('Visitor-style question, e.g. "Do you ship to Canada?"'),
        threadId: z
          .string()
          .optional()
          .describe('Existing conversation ID; omit to start a new thread. Reuse to maintain context across turns.'),
        stream: z.literal(false).optional().describe('Must be false (or omitted) — MCP does not carry streams.'),
      },
      handler: async ({ client }, args) => {
        // The cloud contract requires a non-empty `threadId` on every
        // call (threading state is part of the chat pipeline, even for
        // one-shot turns). LLMs are poor at minting unique IDs and tend
        // to reuse fixed strings across sessions, so we generate one
        // here whenever the caller omits it.
        const { workspaceId, threadId, ...rest } = args;
        const effectiveThreadId = threadId && threadId.trim().length > 0 ? threadId : `mcp-${randomUUID()}`;
        const data = await request(client, {
          method: 'POST',
          path: '/chat',
          headers: { 'X-Workspace-ID': workspaceId },
          body: { ...rest, threadId: effectiveThreadId, stream: false },
          timeoutMs: 120_000,
        });
        return okResult(data);
      },
    })
  )
    registered++;

  return registered;
}
