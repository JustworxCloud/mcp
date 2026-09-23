# Remote MCP deployment (mcp.justworx.com)

Run `jwx-mcp` as a hosted OAuth 2.1 Resource Server so managed connectors (claude.ai web, ChatGPT)
can use it over the MCP Streamable HTTP transport. The server issues no tokens and holds no secret:
it validates each caller's OAuth access token and forwards it to the Justworx API.

## Prerequisites
- The Justworx API (`https://api.justworx.com/api/v2`) accepts OAuth access tokens from the
  authorization server (issuer `https://oauth.justworx.com`), in addition to `jwx_live_` API keys.
- The OAuth authorization server is reachable and its JWKS is published
  (`https://oauth.justworx.com/.well-known/jwks.json`).

## Steps

### 1. Config — `.env`
Copy `.env.example` -> `.env` (no secrets; the server forwards each caller's token). The defaults
already point at the live Justworx API and the public authorization server. Confirm
`MCP_RESOURCE_URL=https://mcp.justworx.com`.

### 2. Install the service
```powershell
cd <repo> ; npm ci
powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1   # installs + starts the service
curl http://127.0.0.1:$MCP_HTTP_PORT/healthz
curl http://127.0.0.1:$MCP_HTTP_PORT/.well-known/oauth-protected-resource   # PRM -> points at the AS
```

### 3. Public hostname
Put an HTTPS reverse proxy or tunnel in front of the loopback port so `mcp.justworx.com` reaches
`http://127.0.0.1:$MCP_HTTP_PORT` (the same pattern used for the `api` and `oauth` hosts).

### 4. Dynamic Client Registration (RFC 7591)
Managed MCP connectors (claude.ai, ChatGPT) self-register via Dynamic Client Registration. The
authorization server must expose an RFC 7591 `POST /oauth2/register` endpoint that creates a client
constrained to safe grants/scopes and HTTPS redirect URIs, and advertise `registration_endpoint` in
its RFC 8414 metadata. Registration can be open; the authorization itself is gated by user login +
consent at the authorization server.

### 5. Verify end-to-end
Add the connector in claude.ai / ChatGPT pointing at `https://mcp.justworx.com/mcp`. It discovers the
authorization server via the protected-resource metadata (PRM), runs authorize -> login -> consent ->
token (authorization-code + PKCE), and calls a tool; confirm serial-keyed results.

## Notes
- Stateless server: no shared key, no cross-tenant state — a fresh server is built per request bound
  to the caller's token. Tokens are audience-bound (RFC 8707) to `MCP_RESOURCE_URL`.
- Rollback: stop the service (purely additive; nothing else depends on it).

### Token audience (RFC 8707)
claude.ai / ChatGPT request a token with `resource=<this server>`, and this server's verifier enforces
`aud`. If the authorization server ignores the RFC 8707 `resource` parameter and only honours a native
`audience` claim (and requires the client to allow-list it), register clients with
`audience:[MCP_RESOURCE]` and translate `resource` -> `audience` at the authorize endpoint — otherwise
tokens carry no `aud` and every `POST /mcp` returns 401 ("no tools available"). The verifier accepts the
resource with or without a trailing slash (the PRM advertises a `URL.href`, i.e. `…/`), so a cosmetic
slash cannot cause a reject.
- A client created before audience binding was configured has no `aud` -> the user must DISCONNECT and
  RECONNECT the connector.
