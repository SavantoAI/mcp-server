import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodObject, ZodRawShape, z } from 'zod';
import { SavantoApiError, type SavantoClient } from './utils/fetch.js';
import { errorResult } from './utils/result.js';
import type { Whoami } from './whoami.js';
import { hasScope } from './whoami.js';

/**
 * Bundled runtime context passed to every tool handler. Keeping this in
 * one object avoids threading four arguments through every call site and
 * keeps the handler signatures short enough to read at a glance.
 */
export interface ToolContext {
  client: SavantoClient;
  who: Whoami;
}

// Zod v4 removed `objectOutputType` from its public exports. The equivalent
// is `z.infer` over a `ZodObject` built from the same shape, which gives us
// the validated/transformed output type for the tool's arguments.
type ArgsFromShape<Shape extends ZodRawShape> = z.infer<ZodObject<Shape>>;

export interface ToolDefinition<Shape extends ZodRawShape> {
  /** `snake_case` name; this is what the agent calls by. Keep short. */
  name: string;
  /**
   * One-sentence description of what the tool does, tuned for tool-picking
   * LLMs. Start with a verb ("Create a workspace …"); mention the
   * resource returned; avoid marketing prose.
   */
  description: string;
  /** Optional title for UI — defaults to the tool name. */
  title?: string;
  /**
   * Scope(s) this tool requires. Omit for tools that work with any key. A
   * single string requires exactly that scope; an array means OR — the key
   * needs ANY one of them. Use the array form to mirror cloud routes that
   * accept multiple scopes (e.g. list endpoints that allow read OR admin).
   */
  scope?: string | string[];
  /** Zod shape for the input arguments. Use `{}` for no arguments. */
  inputSchema: Shape;
  /**
   * MCP behavioural hints. By default these are DERIVED from the tool name
   * (get_/list_/search_/whoami → read-only; delete_/bulk_delete_ → destructive;
   * upsert_/update_/patch_/delete_ → idempotent). Set explicitly only to
   * override — e.g. the no-persist POST tools (generate_/validate_/test_/
   * discover_) are read-only despite not matching a read prefix.
   */
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  /**
   * The handler. Throw `SavantoApiError` for API failures — the registry
   * wraps it into an MCP-shaped error response. Any other thrown value
   * will bubble up as an MCP internal error.
   */
  handler: (ctx: ToolContext, args: ArgsFromShape<Shape>) => Promise<CallToolResult>;
}

/**
 * Registers a tool on the MCP server, but only if the current key has
 * the scope that tool requires. "Not registered" is semantically cleaner
 * than "registered but always 403s" — agents won't try to use tools they
 * can't see, and the tool catalog stays accurate to the caller's identity.
 *
 * The `never` casts on the handler are required because the MCP SDK has
 * a deeply-overloaded `registerTool` signature (five overloads, union
 * types in each) and TypeScript can't prove our generic `Shape` satisfies
 * all of them without hitting instantiation-depth limits. We keep the
 * strongly-typed surface on the caller side (ToolDefinition is fully
 * inferred) and erase it at the one-line boundary to the SDK.
 */
export function maybeRegisterTool<Shape extends ZodRawShape>(
  server: McpServer,
  ctx: ToolContext,
  def: ToolDefinition<Shape>,
): boolean {
  if (def.scope !== undefined) {
    // OR semantics: the key needs any one of the listed scopes. An empty array
    // matches nothing and fails closed (a mistaken `scope: []` won't expose the
    // tool); omit `scope` entirely for tools that require no scope.
    const required = Array.isArray(def.scope) ? def.scope : [def.scope];
    if (!required.some((s) => hasScope(ctx.who, s))) return false;
  }
  const wrappedHandler = async (rawArgs: unknown): Promise<CallToolResult> => {
    try {
      return await def.handler(ctx, rawArgs as ArgsFromShape<Shape>);
    } catch (err) {
      if (err instanceof SavantoApiError) return errorResult(err);
      throw err;
    }
  };
  // Derive MCP behavioural hints from the naming convention, with explicit
  // overrides. These let clients auto-approve safe reads and flag destructive
  // writes in their approval UI.
  const n = def.name;
  const annotations = {
    title: def.title ?? def.name,
    readOnlyHint: def.readOnly ?? /^(get_|list_|search_|whoami$)/.test(n),
    destructiveHint: def.destructive ?? /^(delete_|bulk_delete_)/.test(n),
    idempotentHint: def.idempotent ?? /^(upsert_|bulk_upsert_|update_|patch_|delete_|bulk_delete_)/.test(n),
  };
  // biome-ignore lint/suspicious/noExplicitAny: SDK overload resolution — see comment above.
  (server.registerTool as any)(
    def.name,
    {
      title: def.title ?? def.name,
      description: def.description,
      inputSchema: def.inputSchema,
      annotations,
    },
    wrappedHandler,
  );
  return true;
}
