#!/usr/bin/env node
// Boot the remote MCP server (OAuth 2.1 Resource Server over Streamable HTTP). Hosted, multi-tenant.
// Env: JWX_API_BASE_URL, MCP_HTTP_PORT, MCP_RESOURCE_URL, OAUTH_ISSUER, OAUTH_JWKS_URL.

import { loadConfig } from './config.js';
import { createTokenVerifier } from './oauth.js';
import { createHttpApp } from './http.js';

const cfg = loadConfig();
const verifier = createTokenVerifier({
  issuer: cfg.oauth.issuer,
  jwksUrl: cfg.oauth.jwksUrl,
  audience: cfg.http.resourceUrl, // RFC 8707: tokens must be bound to this resource
});

const app = createHttpApp({ config: cfg, verifier });
app.listen(cfg.http.port, () => {
  process.stderr.write(
    `jwx-mcp (remote): listening on :${cfg.http.port} → gateway ${cfg.baseUrl}\n` +
    `  resource=${cfg.http.resourceUrl}  issuer=${cfg.oauth.issuer}\n`,
  );
});
