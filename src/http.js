// Remote MCP server — a hosted, multi-tenant OAuth 2.1 Resource Server over the MCP Streamable
// HTTP transport. Unlike the stdio server (one ambient API key), every request carries the
// caller's own OAuth access token: we validate it against the OAuth authorization server, then
// FORWARD it to the Justworx API. No shared secret,
// no cross-tenant state — a fresh server+transport is built per request, bound to that token.
//
// OAuth discovery is served per spec so MCP clients (claude.ai, ChatGPT connectors) can find the
// AS and run authorization-code + PKCE + dynamic client registration on their own:
//   GET /.well-known/oauth-protected-resource  (RFC 9728 — points at the AS)
//   GET /.well-known/oauth-authorization-server (RFC 8414 — AS metadata mirror)
// A request with no/invalid token gets 401 + WWW-Authenticate: Bearer resource_metadata="…".

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';

import { JustworxApiClient } from './apiClient.js';
import { buildServer } from './server.js';

/**
 * Build the remote MCP Express app.
 * @param {object} deps
 * @param {object} deps.config   loadConfig() output
 * @param {object} deps.verifier an OAuthTokenVerifier ({ verifyAccessToken })
 * @param {(token: string) => object} [deps.clientFactory] build a Developer-API client from the
 *   caller's token (injectable for tests; defaults to a real JustworxApiClient that forwards it).
 */
export function createHttpApp({ config, verifier, clientFactory }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const resourceServerUrl = new URL(config.http.resourceUrl);

  // AS (authorization server) metadata we advertise for discovery — describes the AS's endpoints.
  const oauthMetadata = {
    issuer: config.oauth.issuer,
    authorization_endpoint: config.oauth.authorizationEndpoint,
    token_endpoint: config.oauth.tokenEndpoint,
    registration_endpoint: config.oauth.registrationEndpoint,
    jwks_uri: config.oauth.jwksUrl,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
    scopes_supported: config.oauth.scopesSupported,
  };

  app.use(mcpAuthMetadataRouter({
    oauthMetadata,
    resourceServerUrl,
    scopesSupported: config.oauth.scopesSupported,
    resourceName: 'Justworx MCP',
  }));

  app.get('/healthz', (_req, res) => res.json({ ok: true, resource: resourceServerUrl.href, transport: 'streamable-http' }));

  const bearer = requireBearerAuth({
    verifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  const factory = clientFactory
    || ((token) => new JustworxApiClient({ baseUrl: config.baseUrl, token, timeoutMs: config.timeoutMs }));

  // Stateless MCP: one server + transport per request, bound to the authenticated caller's token.
  app.post('/mcp', bearer, async (req, res) => {
    const client = factory(req.auth.token);
    const server = buildServer({ client });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  // Stateless server: no server-initiated SSE stream, no session teardown.
  const methodNotAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed; this is a stateless server, use POST /mcp' }, id: null });
  app.get('/mcp', bearer, methodNotAllowed);
  app.delete('/mcp', bearer, methodNotAllowed);

  return app;
}
