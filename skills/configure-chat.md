---
title: Tune chat widget behavior
use: Run this when the user wants to adjust chat persona, special instructions, allowed domains, or other widget settings.
tools: [list_workspaces, get_workspace_settings, chat]
---

# Tune chat widget behavior

This skill walks through inspecting and changing a workspace's chat configuration. v1 of the MCP server surfaces chat *inspection* and *testing* but not direct widget-config mutation — that's on the roadmap. For now: read the config, test changes via chat queries, and guide the user to the dashboard for the final save.

## Step 1 — Select a workspace

Call `list_workspaces` and ask the user which one to tune.

## Step 2 — Read the current settings

Call `get_workspace_settings` for the chosen `workspaceId`. Summarize the relevant fields back: `specialInstructions`, persona / tone fields, allowed domains, and live-agent configuration.

## Step 3 — Diagnose with real queries

Ask the user what behavior they want to change ("too chatty", "too formal", "doesn't push upsells enough", "refuses to answer off-topic questions too aggressively"). Send 2-3 representative queries through the `chat` tool to get a baseline.

## Step 4 — Recommend changes

Based on the current settings and the observed chat behavior, recommend specific edits the user should make in the dashboard at **Dashboard → Workspaces → [workspace] → Chat settings**:

- **Persona / tone**: add a sentence like "Always respond in a concise, slightly playful tone" to special instructions.
- **Upsell policy**: "When a product question is asked, always offer one related product at the end."
- **Safety**: "Do not answer questions about competitors; redirect to our brand."

## Step 5 — After the user saves

Ask the user to say "done" when they've saved the change. Re-run the same 2-3 queries via `chat` and compare. Flag any regressions.

## Notes

The direct `update_chat_widget_config` tool is deferred to a later MCP release; the schema is large and easy to corrupt, so v1 deliberately keeps the human in the loop for this one.
