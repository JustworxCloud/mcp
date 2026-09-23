// Config from the environment.
//
// Two run modes share this:
//   • stdio (src/index.js)      — a client (Claude Desktop, etc.) launches a LOCAL server and
//     supplies a single JWX_API_KEY via its server-config `env` block.
//   • remote HTTP (src/http.js) — a HOSTED, multi-tenant OAuth 2.1 Resource Server. There is no
//     ambient API key; each request carries the caller's own OAuth access token (validated against
//     the authorization server below) and that token is forwarded to the Justworx API.

export function loadConfig(env = process.env) {
  const baseUrl = env.JWX_API_BASE_URL || 'https://api.justworx.com/api/v2';
  const apiKey = env.JWX_API_KEY || ''; // stdio only; unused by the remote server
  const timeoutMs = env.JWX_API_TIMEOUT_MS ? Number.parseInt(env.JWX_API_TIMEOUT_MS, 10) : 30000;

  // Remote (HTTP) server config.
  const http = {
    port: env.MCP_HTTP_PORT ? Number.parseInt(env.MCP_HTTP_PORT, 10) : 8790,
    // The public URL this server is reached at — its OAuth 2.0 *resource* identifier (RFC 8707).
    // Tokens must be audience-bound to this. e.g. https://mcp.justworx.com
    resourceUrl: env.MCP_RESOURCE_URL || 'https://mcp.justworx.com',
  };

  // OAuth 2.1 — the OAuth authorization server that issues access tokens (the same issuer the
  // Justworx API accepts). The remote MCP server is a Resource Server: it validates the AS's
  // tokens via JWKS; it never issues them. Mirror the API's oauth config so both trust the same AS.
  const oauth = {
    issuer: env.OAUTH_ISSUER || 'https://oauth.justworx.com',
    jwksUrl: env.OAUTH_JWKS_URL || '',
    // Standard AS endpoints (advertised in the AS metadata we mirror for discovery). Derived from
    // the issuer unless overridden.
    authorizationEndpoint: env.OAUTH_AUTHORIZATION_ENDPOINT || '',
    tokenEndpoint: env.OAUTH_TOKEN_ENDPOINT || '',
    registrationEndpoint: env.OAUTH_REGISTRATION_ENDPOINT || '',
    scopesSupported: (env.OAUTH_SCOPES_SUPPORTED
      || 'devices:read devices:command devices:configure devices:own events:read').split(' ').filter(Boolean),
  };
  const iss = oauth.issuer.replace(/\/$/, '');
  oauth.jwksUrl = oauth.jwksUrl || `${iss}/.well-known/jwks.json`;
  oauth.authorizationEndpoint = oauth.authorizationEndpoint || `${iss}/oauth2/auth`;
  oauth.tokenEndpoint = oauth.tokenEndpoint || `${iss}/oauth2/token`;
  oauth.registrationEndpoint = oauth.registrationEndpoint || `${iss}/oauth2/register`;

  return { baseUrl, apiKey, timeoutMs, http, oauth };
}
