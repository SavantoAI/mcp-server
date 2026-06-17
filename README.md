# @savantoai/mcp-server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your Savanto AI workspace to Claude, ChatGPT, Cursor, and any other MCP-compatible client — so you can **configure, populate, and operate your store's AI assistant by talking to your own AI**, instead of clicking through a dashboard.

## What it does

Once configured, your agent gains a curated set of tools that mirror the Savanto REST API, spanning the full **configure → observe → refine** loop:

| Category | Representative tools | Scope |
| --- | --- | --- |
| Workspaces | `list_workspaces`, `create_workspace`, `update_workspace`, `delete_workspace` | `tenant:admin` |
| Configuration | `get_workspace_settings`, `update_workspace_settings`, custom-domain CRUD, `discover_tools`, `generate_domain_config`, `validate_custom_domain`, `test_domain_connection`, `generate_color_scheme`, chat/search widget config | `config:admin` |
| Content | `upsert_product`/`upsert_post` (+ `bulk_*`, `list_*`, `get_*`, `patch_*`, `delete_*`) | `admin:products`, `admin:posts` |
| Taxonomies | `upsert_taxonomy`, `bulk_upsert_taxonomies`, `list/get/delete_taxonomy` | `admin:taxonomies` |
| Prompts | `upsert_prompt`, `list_prompts`, `search_prompts`, `delete_prompt` (+ bulk) | `admin:prompts`, `prompts:read` |
| Webhooks | `create_webhook`, `list/get/update/delete_webhook`, `test_webhook`, `get_webhook_stats` | `admin:webhooks` |
| Crawl | `start_crawl`, `get_crawl_status`/`history`/`config`, `update_crawl_config` | `admin:posts` |
| Search | `search_products`, `search_posts` | `search:products`, `search:posts` |
| Analytics | `get_search_analytics`, `get_chat_analytics`, `get_feedback_analytics`, `search_search_logs`, `list_feedback` | `tenant:admin`, `feedback:admin` |
| Threads | `search_threads`, `get_thread`, `get_thread_messages`, `get_thread_analytics`, `delete_thread`, `bulk_delete_threads` | `threads:admin` |
| Chat | `chat` | `chat` |
| Diagnostics | `whoami`, `get_tenant_usage` | (none) / `tenant:admin` |

Two things keep the surface safe and legible to clients:

- **Scope-gated at startup** — the server probes `/tenant/whoami` and only registers tools your key can actually use. An agent is never shown a tool it would get a 403 for, and a publishable widget key sees almost nothing.
- **Annotated** — every tool carries MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can auto-approve safe reads and flag destructive writes; deletes additionally require an explicit `confirm: true`.

The server also exposes **Skills** (MCP prompts) — step-by-step playbooks for common multi-tool workflows:

- `onboard-store-end-to-end` – create a workspace, ingest content, configure behaviour + branding, smoke-test
- `onboard-wordpress` / `onboard-shopify` – platform-specific onboarding walkthroughs
- `configure-chat` – tune persona, special instructions, and handoff rules
- `configure-custom-domain` – wire a custom capability (order tracking, account lookup) to MCP servers / REST APIs
- `audit-and-improve` – the observe→refine loop: find failing chats / zero-result searches / negative feedback and fix them
- `debug-empty-search` – diagnose why a product search returns no hits
- `migrate-from-competitor` – bulk-import from another chat vendor's export

## Requirements

- Node.js 20 or later
- A **secret** Savanto API key (starts with `if_sk_…`). Create one in the [API Keys page](https://savanto.ai/dashboard/api-keys) of your dashboard.
  > Publishable keys (`if_pk_…`) are client-side and cannot provision workspaces — the server will refuse to start with one.

## Quick start

No global install needed — run it with `npx`:

```bash
export SAVANTO_API_KEY=if_sk_your_key_here
npx -y @savantoai/mcp-server
```

Point to a non-production cloud (staging, local dev):

```bash
export SAVANTO_API_URL=http://localhost:3001
```

## Remote server (preview)

In addition to the local stdio server above, the same tool surface can run as a
**hosted HTTP server** so clients connect to a URL instead of spawning `npx` —
no local Node, no per-machine config. This is the path toward one-click
"Connect to Claude/ChatGPT" (OAuth) onboarding; today it accepts your secret key
as a Bearer token.

```bash
# Each client authenticates per-request — there is NO server-wide key.
SAVANTO_API_URL=https://api.savanto.ai PORT=8080 npx -y -p @savantoai/mcp-server savanto-mcp-http
```

The server mounts the MCP endpoint at `/mcp` and a liveness probe at `/healthz`.
Clients send their key as `Authorization: Bearer if_sk_…`; the tool surface is
scope-gated to that key's tenant, exactly as in the stdio server. Point an MCP
client that supports remote (Streamable HTTP) servers at
`https://your-host/mcp` with that bearer token.

> Auth is currently the raw secret key. A future release replaces it with
> OAuth-issued, tenant-scoped tokens so customers can connect with zero key
> handling — the transport and tool layer are unchanged by that swap.

## Client configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "savanto": {
      "command": "npx",
      "args": ["-y", "@savantoai/mcp-server"],
      "env": {
        "SAVANTO_API_KEY": "if_sk_your_key_here"
      }
    }
  }
}
```

Restart Claude Desktop. You should see a hammer/tool icon in the message bar; the Savanto tools are listed there.

### Cursor

In Cursor settings → **Features → Model Context Protocol** → **Add new MCP server**:

```json
{
  "savanto": {
    "command": "npx",
    "args": ["-y", "@savantoai/mcp-server"],
    "env": { "SAVANTO_API_KEY": "if_sk_your_key_here" }
  }
}
```

### Cline / Roo / other VS Code agents

Add to the extension's MCP config (usually a JSON file under `~/.cline` or similar):

```json
{
  "mcpServers": {
    "savanto": {
      "command": "npx",
      "args": ["-y", "@savantoai/mcp-server"],
      "env": { "SAVANTO_API_KEY": "if_sk_your_key_here" }
    }
  }
}
```

### OpenAI Agents / Responses API

```python
from openai import OpenAI
from mcp import StdioServerParameters

server = StdioServerParameters(
    command="npx",
    args=["-y", "@savantoai/mcp-server"],
    env={"SAVANTO_API_KEY": "if_sk_your_key_here"},
)
```

### Local MCP Inspector (for debugging)

```bash
npx @modelcontextprotocol/inspector npx @savantoai/mcp-server
```

The Inspector gives you a web UI to list tools, call them directly, and watch request/response payloads — great for confirming your key is wired correctly before handing the server to an agent.

## Example prompts

Once the server is registered in your MCP client, try:

> "Set up a new Savanto workspace for `acme-store`, crawl `https://acme.test`, give it an outdoor-adventure tone, and brand the widget around `#0a7d2c`." *(end-to-end onboarding)*

> "Look at `acme-store`'s last 30 days — what are visitors searching for that returns nothing, and which conversations went unresolved? Then add content to fix the top few." *(the observe→refine loop)*

> "Add an order-tracking capability to `acme-store` backed by our MCP server at `https://mcp.acme.test/orders`, validate it, and test it before enabling." *(custom domain)*

> "Why did this conversation get a thumbs-down?" — pull `list_feedback`, read the thread, and propose a fix.

The agent picks the right tools automatically (and clients can auto-approve the read-only ones). You can also invoke a Skill explicitly — e.g. in Claude Desktop, `/onboard-store-end-to-end` or `/audit-and-improve` kicks off that full playbook.

## Environment variables

| Variable          | Default                         | Purpose                                          |
| ----------------- | ------------------------------- | ------------------------------------------------ |
| `SAVANTO_API_KEY` | _(required)_                    | Your secret API key (`if_sk_…`).                 |
| `SAVANTO_API_URL` | `https://api.savanto.ai`        | Override for staging / local dev.                |

## Security

- Always use **separate API keys per agent / machine** — so you can revoke one without affecting the others. The [API Keys page](https://savanto.ai/dashboard/api-keys) tracks the last-used timestamp of each key.
- Keys are passed via environment variables, never logged. The server prints a one-line identity banner on startup (to stderr) showing the tenant id and scope list — no secrets.
- The server runs over stdio and never opens a network port. It only speaks to the Savanto API host you point it at.
- `delete_workspace` requires an explicit `confirm: true` parameter in the tool call — a safety gate against hallucinated destructive operations.

## Local development

From the repo root:

```bash
npm install
npm run build --workspace=@savantoai/mcp-server
SAVANTO_API_KEY=if_sk_… SAVANTO_API_URL=http://localhost:3001 node sdks/mcp/dist/stdio.js
```

Run the tests:

```bash
npm run test --workspace=@savantoai/mcp-server
```

## License

MIT. See [LICENSE](./LICENSE).
