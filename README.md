# jwx-mcp

The **Justworx MCP server** — exposes Justworx devices to AI agents (Claude, ChatGPT,
agent frameworks) as **MCP tools** (control) and **resources** (read-only state), backed
entirely by the public **Justworx API** (`/api/v2`).

It is a **thin, standalone client** of that API: it calls it directly over HTTPS, holding
no device keys — actuation flows through the API to the Justworx platform.

Two run modes, one server core (the tools/resources are transport-agnostic):
- **stdio** (`src/index.js`) — a client (Claude Desktop, etc.) launches it locally with a single
  `jwx_live_` API key. This is the local/desktop path.
- **remote** (`src/http-entry.js`) — a **hosted, multi-tenant OAuth 2.1 Resource Server** over the
  MCP **Streamable HTTP** transport, for clients that can't launch a local process (claude.ai web,
  ChatGPT connectors). Each caller brings **their own OAuth access token**; see below.

## Tools

| Tool | What |
|------|------|
| `list_devices` | List accessible devices (filter: `online`; cursor-paginated). |
| `get_device` | Full live twin state of one device (IDs, rules, network, location). |
| `get_device_log` | Device history, newest first (time window + type/idNumber/ruleNumber filter). |
| `set_io` | Set an ID's value and hold it. `confirm:true` waits for a confirmed device reply. |
| `pulse_io` | Drive an ID for `durationMs` then revert (momentary actions, e.g. a gate trigger). |
| `cancel_timer` | Cancel a pending timer on an ID before it reverts on its own. |
| `set_rule` | Enable/disable an on-device rule. |
| `list_rules` | List every rule stored on a device. |
| `create_rule` | Create a rule, or replace one by reusing its `ruleNumber`. |
| `delete_rule` | Delete one rule by number. |
| `clear_rules` | Delete EVERY rule on a device. Cannot be undone; requires `confirm: true`. |

**No abstract-command tool.** Each ID may carry a `capability` (`type`/`names`/`secure`, e.g.
`GarageDoor` / `["Door"]`) when the owner has authored one — `get_device` returns it per ID — but
there is no capability-*command* endpoint on `/api/v2`. Actuation stays at the raw ID level:
`set_io`/`pulse_io` against the ID number, using `capability.names[0]` (when present) as the
human label.

## Resources

- `justworx://devices` — the accessible device list.
- `justworx://devices/{serial}` — live state for one device.

## Configure & run

The server speaks **stdio** (how MCP clients launch a local server). It needs a Justworx API
key — issue one via **[Justworx Studio](https://studio.justworx.com)**.

```jsonc
// Claude Desktop / MCP client config
{
  "mcpServers": {
    "justworx": {
      "command": "node",
      "args": ["/absolute/path/to/jwx-mcp/src/index.js"],
      "env": {
        "JWX_API_KEY": "jwx_live_…",
        "JWX_API_BASE_URL": "https://api.justworx.com/api/v2"
      }
    }
  }
}
```

Inspect it locally with the MCP Inspector:

```sh
JWX_API_KEY=jwx_live_… npx @modelcontextprotocol/inspector node src/index.js
```

## Remote mode (hosted, OAuth 2.1)

> **Connecting a client?** See **[CONNECT.md](CONNECT.md)** for one-step setup with Cursor, Windsurf,
> Cline, and other MCP clients (point them at `https://mcp.justworx.com/mcp` and log in) — no API key.

For hosted clients (claude.ai web, ChatGPT connectors) that can't spawn a local process, run the
**Streamable HTTP** server. It is a standard **OAuth 2.1 Resource Server**: it does not issue tokens,
it **validates** the ones from the OAuth authorization server and **forwards** each caller's token
to the Justworx API (which accepts either an API key or an OAuth token). Fully multi-tenant — a
fresh server is built per request, bound to that caller's token; no shared key, no cross-tenant state.

```sh
npm run start:http     # → http://0.0.0.0:$MCP_HTTP_PORT/mcp
```

- **Endpoint:** `POST /mcp` (Streamable HTTP, stateless). `GET /healthz` for liveness.
- **OAuth discovery** (so clients self-register + authorize): `GET /.well-known/oauth-protected-resource`
  (RFC 9728 → points at the AS) and `GET /.well-known/oauth-authorization-server` (RFC 8414 mirror).
  An unauthenticated call returns `401` + `WWW-Authenticate: Bearer resource_metadata="…"`.
- **Tokens** must be audience-bound (RFC 8707) to `MCP_RESOURCE_URL`; scopes map to the Justworx API's
  scopes (`devices:read`, `devices:command`, `devices:configure`, `devices:own`, `events:read`).

> **Deployment:** run this server behind an HTTPS reverse proxy or tunnel and publish it at your
> resource URL (e.g. **`mcp.justworx.com`**). It validates tokens from the OAuth authorization server
> at `https://oauth.justworx.com`. The OAuth Resource-Server layer is complete and covered by tests
> against a stub issuer. See `DEPLOY-REMOTE.md`.

## Config (env)

| Var | Default | Notes |
|-----|---------|-------|
| `JWX_API_KEY` | *(stdio only)* | A `jwx_live_` Justworx API key (local/stdio mode). |
| `JWX_API_BASE_URL` | `https://api.justworx.com/api/v2` | API base; point at a local instance for testing. |
| `JWX_API_TIMEOUT_MS` | `30000` | Per-request timeout. |
| `MCP_HTTP_PORT` | `8790` | Remote server listen port. |
| `MCP_RESOURCE_URL` | `https://mcp.justworx.com` | This server's public URL = its OAuth resource id (token audience). |
| `OAUTH_ISSUER` | `https://oauth.justworx.com` | The OAuth authorization server (issuer) whose tokens are accepted. |
| `OAUTH_JWKS_URL` | `<issuer>/.well-known/jwks.json` | AS JWKS for token validation. |

## Test

```sh
npm test   # node:test — connects a real MCP client over an in-memory transport
```

Tests drive an actual MCP `Client` against the server with an injected fake API client. The remote
(HTTP) suite additionally drives a real Streamable-HTTP MCP client against a stub OAuth
authorization server (local keypair + JWKS) to prove token verification and per-caller forwarding.

## Layout

```
src/apiClient.js   thin fetch client for /api/v2 (bearer: api key OR OAuth token)
src/server.js      buildServer({client}) — tools + resources (transport-agnostic)
src/config.js      env config (stdio + remote/OAuth)
src/index.js       stdio entrypoint
src/oauth.js       OAuth 2.1 token verifier (JWKS) — Resource Server side
src/http.js        remote app: Streamable HTTP + OAuth discovery + per-request token forwarding
src/http-entry.js  remote entrypoint (npm run start:http)
test/server.test.js  stdio: MCP client ⇄ server over in-memory transport
test/http.test.js    remote: real Streamable-HTTP MCP client + stub AS (JWKS) → authed tool calls
```
