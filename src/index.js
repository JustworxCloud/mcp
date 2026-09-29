#!/usr/bin/env node
// stdio entrypoint — the standard way an MCP client launches a local server.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { JustworxApiClient } from './apiClient.js';
import { buildServer } from './server.js';

const cfg = loadConfig();
if (!cfg.apiKey) {
  process.stderr.write('jwx-mcp: JWX_API_KEY is not set — export a jwx_live_ Justworx API key.\n');
  process.exit(1);
}

const client = new JustworxApiClient(cfg);
const server = buildServer({ client });
const transport = new StdioServerTransport();

await server.connect(transport);
process.stderr.write(`jwx-mcp: connected (stdio) → ${cfg.baseUrl}\n`);
