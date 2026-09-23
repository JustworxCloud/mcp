# Connect Justworx to your MCP client

The Justworx MCP server is hosted at **`https://mcp.justworx.com/mcp`**. Point any MCP client that
supports remote (Streamable HTTP) servers at it — no install, no API key. On first connect your client
opens a browser to **log in to Justworx** and approve access (OAuth 2.1 authorization-code + PKCE);
the client stores the token and refreshes it automatically.

Once connected, ask your assistant things like *"list my Justworx devices"* or *"turn on the porch
light"*. Devices are identified by their 8-character serial number.

---

## Cursor

Add the server to `~/.cursor/mcp.json` (or **Settings → MCP → Add new MCP server**):

```json
{
  "mcpServers": {
    "justworx": {
      "url": "https://mcp.justworx.com/mcp"
    }
  }
}
```

Reload Cursor. When you first use a Justworx tool, Cursor opens a browser to authorize.

## Windsurf

Add the server to `~/.codeium/windsurf/mcp_config.json` (or **Cascade → MCP settings → Add server**).
Windsurf uses `serverUrl` for remote servers:

```json
{
  "mcpServers": {
    "justworx": {
      "serverUrl": "https://mcp.justworx.com/mcp"
    }
  }
}
```

Refresh Cascade's MCP servers, then authorize in the browser when prompted.

## Cline (VS Code)

Open the **MCP Servers** panel → **Remote Servers** → **Add server**, and enter the URL
`https://mcp.justworx.com/mcp`. (Equivalently, edit `cline_mcp_settings.json`:)

```json
{
  "mcpServers": {
    "justworx": {
      "type": "streamableHttp",
      "url": "https://mcp.justworx.com/mcp"
    }
  }
}
```

Cline opens the authorization page on first use.

---

## Verify it works

1. Confirm the server shows as **connected** (a green dot / the tool list appears) in your client.
2. Ask the assistant: **"List my Justworx devices."** It calls `list_devices` and returns your devices
   by serial number.
3. Try an action: **"Turn on `<device name>`."** Locks and garage doors ask for confirmation.

If the client shows *"no tools available"* right after linking, disconnect and reconnect once — the
first authorization has to complete before the tool list loads.

## Tools available
`list_devices`, `get_device`, `get_device_log`, `set_io`, `pulse_io`, `cancel_timer`, `set_rule`,
`list_rules`, `create_rule`, `delete_rule`, `clear_rules` — plus the `justworx://devices` and
`justworx://devices/{serial}` resources. See the [README](README.md).

## Directories

The Justworx remote MCP server is listed in the public MCP directories so clients can discover it:

| Directory | Listing |
|---|---|
| Model Context Protocol registry | `justworx` — remote (Streamable HTTP), OAuth |
| Glama, PulseMCP, mcp.so, Smithery | `Justworx` — control & monitor Justworx devices |

**Canonical listing metadata** (use for any new directory):

- **Name:** Justworx
- **Server URL:** `https://mcp.justworx.com/mcp`
- **Transport:** Streamable HTTP (remote)
- **Auth:** OAuth 2.1 (authorization-code + PKCE) — users log in to Justworx
- **Description:** Monitor and control your Justworx devices from any MCP client — list devices, read
  live state, actuate, and subscribe to events.
- **Homepage / docs:** https://build.justworx.com
