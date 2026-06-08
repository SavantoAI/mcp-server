# @savantoai/mcp-server

A local [Model Context Protocol](https://modelcontextprotocol.io) server that exposes your Savanto AI workspace to Claude, ChatGPT, Cursor, and any other MCP-compatible client — so an AI agent can provision workspaces, ingest content, kick off crawls, and chat on your behalf.

## What it does

Once configured, your agent gains a curated set of tools that mirror the Savanto REST API:

| Category       | Tools                                                                                                 | Scope required   |
| -------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
| Workspaces     | `list_workspaces`, `create_workspace`, `update_workspace`, `delete_workspace`, `get_workspace_settings` | `tenant:admin`   |
| Crawl          | `start_crawl`, `get_crawl_status`, `get_crawl_history`, `get_crawl_config`, `update_crawl_config`       | `admin:posts`    |
| Content        | `upsert_product`, `upsert_post`                                                                         | `admin:products`, `admin:posts` |
| Search         | `search_products`, `search_posts`                                                                       | `search:products`, `search:posts` |
| Chat           | `chat`                                                                                                  | `chat`           |
| Diagnostics    | `whoami`, `get_tenant_usage`                                                                            | (none) / `tenant:admin` |

Tools are **scope-gated at startup** — the server probes `/tenant/whoami` with your key and only registers tools your key can actually use. An agent is never shown a tool it would get a 403 for.

The server also exposes **Skills** (MCP prompts) — step-by-step playbooks for common multi-tool workflows:

- `onboard-wordpress` – provision a workspace, install the plugin, verify the first sync
- `onboard-shopify` – Shopify app onboarding with a merchant walkthrough
- `configure-chat` – tune persona, special instructions, and handoff rules
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

> "Create a new Savanto workspace called `acme-store` for the Shopify platform, then start a crawl of `https://acme.test` and let me know when it finishes."

> "Search my `acme-store` workspace for products matching 'waterproof hiking boots' in the $100–$200 range."

> "Tune the chat persona for `acme-store` to be enthusiastic about outdoor adventure."

The agent will pick the right tools automatically. You can also invoke a Skill explicitly — e.g. in Claude Desktop, `/onboard-shopify` kicks off that full playbook.

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
