# @savantoai/mcp-server

Public publish mirror for **`@savantoai/mcp-server`**, the Savanto AI MCP
(Model Context Protocol) server.

> This repository is a **read-only mirror**. Do not open PRs here.
>
> The canonical source lives in the Savanto monorepo at `sdks/mcp/`. Releases
> are cut with `scripts/release-mcp.sh <version>`, which snapshots that
> directory into this repo and pushes a `v<x.y.z>` tag. The tag triggers
> `.github/workflows/publish.yml`, which publishes to npmjs.org with sigstore
> provenance via npm Trusted Publishing (OIDC).
>
> This mirror exists because npm provenance requires a **public** source
> repository — the monorepo is private.

## Install

```bash
npx @savantoai/mcp-server
```

See the package README (synced from the monorepo on each release) for usage.
