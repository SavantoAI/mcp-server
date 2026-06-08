/**
 * Helpers to build the `CallToolResult` shape the MCP SDK expects.
 *
 * The SDK accepts free-form `content` blocks, but agents universally
 * benefit from a consistent JSON-text payload they can parse. We wrap
 * each tool's return value in a single `text` block containing the
 * pretty-printed JSON body, plus a short summary line so chat UIs that
 * render tool output inline still have something human-readable.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { SavantoApiError } from './fetch.js';

export function okResult(data: unknown, summary?: string): CallToolResult {
  const text = summary ? `${summary}\n\n${JSON.stringify(data, null, 2)}` : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: isJsonObject(data) ? data : { value: data },
  };
}

export function errorResult(err: SavantoApiError): CallToolResult {
  const payload = {
    error: {
      status: err.status,
      code: err.code,
      type: err.errorType,
      param: err.param,
      message: err.message,
    },
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Savanto API error (${err.status}${err.code ? ` ${err.code}` : ''}): ${err.message}`,
      },
      { type: 'text', text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
