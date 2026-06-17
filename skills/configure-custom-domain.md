---
title: Configure a custom domain
use: Run this when the user wants to add or change a custom capability (e.g. order tracking, account lookup) backed by their MCP servers or REST APIs.
tools: [list_workspaces, list_custom_domains, discover_tools, generate_domain_config, validate_custom_domain, test_domain_connection, create_custom_domain, update_custom_domain]
---

# Configure a custom domain

A *custom domain* is a customer-defined capability the chat assistant can route to — e.g. "order tracking" backed by a Shopify MCP server, or "account lookup" backed by a REST API. This skill follows a **validate-before-write** flow so a misconfigured domain never reaches live traffic.

The golden path is: **discover → generate → validate → test → create**. Don't skip validate/test, and create disabled first.

## Step 1 — Select the workspace and see what exists

Call `list_workspaces`, confirm the target with the user, then `list_custom_domains` to see what's already configured. If you're changing an existing domain, note its `id` — you'll pass it to `validate_custom_domain` and `update_custom_domain`.

## Step 2 — Discover the backing tools

Ask which MCP server(s) or API(s) back this capability. Call `discover_tools` with their `{ name, url }` to confirm they're reachable and to see the actual tool names. If discovery fails, stop and resolve connectivity/auth with the user before going further — a domain pointing at unreachable tools is worse than none.

## Step 3 — Draft the config

Either:
- Call `generate_domain_config` with a plain-English `description` (and optional `references` — docs URLs or pasted text) to get an AI-drafted config, **or**
- Hand-author the fields if the user knows exactly what they want.

Key fields: `classifierPrompt` (when triage should route here), `agentPrompt` (how the domain agent behaves), `progressMessage`, and the `mcpServers` / `apiEndpoints` from Step 2.

## Step 4 — Validate

Call `validate_custom_domain` with the draft (pass the existing `id` if editing). It returns:
- **prompt-quality issues** — vague/over-broad classifier prompts, etc.
- **overlap warnings** — where this domain's classifier would compete with an existing one (the usual cause of mis-routing).

Resolve issues before proceeding. If overlap is flagged, tighten the `classifierPrompt` to carve out a distinct trigger, then re-validate.

## Step 5 — Test classification

Call `test_domain_connection` with the config and 1–5 representative visitor messages. Confirm the queries you *expect* to route here do, and that unrelated ones don't. Iterate on the `classifierPrompt` until routing looks right.

## Step 6 — Create (disabled), then enable

Call `create_custom_domain` with `enabled: false`. Do a final `test_domain_connection` against the saved domain, then `update_custom_domain` with `enabled: true` once the user is happy.

For an edit to an existing domain, use `update_custom_domain` (partial — only the fields you pass change); re-validate first.

## Notes

- Always confirm with the user before enabling a domain on live traffic, and before any `delete_custom_domain` (which requires `confirm: true`).
- These tools require a tenant-admin secret key; they won't be available to a publishable widget key.
