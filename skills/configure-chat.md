---
title: Tune chat widget behavior
use: Run this when the user wants to adjust chat persona, special instructions, or chat widget presentation.
tools: [list_workspaces, get_workspace_settings, update_workspace_settings, get_chat_widget_config, update_chat_widget_config, generate_color_scheme, chat]
---

# Tune chat widget behavior

The MCP server can now both read and write a workspace's chat configuration. There are two distinct surfaces:

- **AI behaviour** — `update_workspace_settings` (special instructions, business description, live-agent handoff). This shapes *what the assistant says*.
- **Presentation** — `update_chat_widget_config` (greeting, layout, theme/colors). This shapes *how the widget looks*.

Always read the current config first, make a **partial** change (only the fields you intend), then re-test.

## Step 1 — Select a workspace

Call `list_workspaces` and ask the user which one to tune.

## Step 2 — Read the current config

Call `get_workspace_settings` for AI behaviour and/or `get_chat_widget_config` for presentation. Summarize the relevant fields back: `specialInstructions`, live-agent configuration, greeting/title, theme.

## Step 3 — Diagnose with real queries

Ask what the user wants to change ("too chatty", "too formal", "doesn't push upsells enough"). Send 2-3 representative queries through `chat` to get a baseline.

## Step 4 — Make the change (partial)

- **Persona / tone / policy** → `update_workspace_settings` with `specialInstructions`, e.g. "Always respond in a concise, slightly playful tone" or "When a product question is asked, offer one related product at the end." Only the fields you pass change.
- **Handoff** → `update_workspace_settings` with `liveAgent` (e.g. `manualHandoff: true`, an `escalationPrompt`).
- **Look & feel** → `update_chat_widget_config` (greeting, `cardLayout`, theme). For colors, call `generate_color_scheme` with the brand hex first, then apply the returned theme.

## Step 5 — Re-test

Re-run the same 2-3 queries via `chat` and compare. Flag any regressions. For presentation changes, tell the user to reload their site's widget to see them.

## Notes

- `update_workspace_settings` and `update_chat_widget_config` are partial merges — they never clobber fields you didn't pass. Still, read-before-write so you know the starting point.
- The widget config is large; `update_chat_widget_config` advertises the common fields and passes the rest through to the server, which validates. Pass `resetToDefaults: true` to restore widget defaults.
