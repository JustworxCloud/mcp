// Remote MCP server (OAuth 2.1 Resource Server over Streamable HTTP). Drives the REAL MCP
// Streamable-HTTP client against the server, authenticating with a token from a stub authorization
// server (local keypair + JWKS). Proves: OAuth discovery is served, unauthenticated → 401, a valid
// token authorizes tool calls, and the caller's token is FORWARDED per-request (multi-tenant).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createHttpApp } from '../src/http.js';
import { createTokenVerifier } from '../src/oauth.js';

const RESOURCE = 'https://mcp.test.local';
const ISSUER = 'https://oauth.test.local';

const config = {
  baseUrl: 'https://gw.test.local/api/v2',
  timeoutMs: 5000,
  http: { port: 0, resourceUrl: RESOURCE },
  oauth: {
    issuer: ISSUER,
    jwksUrl: 'unused-in-tests',
    authorizationEndpoint: `${ISSUER}/oauth2/auth`,
    tokenEndpoint: `${ISSUER}/oauth2/token`,
    registrationEndpoint: `${ISSUER}/oauth2/register`,
    scopesSupported: ['devices:read', 'devices:command', 'devices:configure', 'devices:own', 'events:read'],
  },
};

let server, baseUrl, priv, forwardedToken;

// Fake Justworx API client — captures the forwarded token + returns canned data shaped like the
// real /api/v2 contract. These fixtures test auth/token-forwarding only, so fields these tests
// don't assert on (like `ids[].capability`) are omitted rather than filled in.
function fakeClientFactory(token) {
  forwardedToken = token;
  return {
    listDevices: async () => ({ items: [{ serial: 'ABCD1234', name: 'Gate', online: true, lastSeenAt: 't', access: 'owner' }], nextCursor: null }),
    getDevice: async (serial) => ({ serial, online: true, ids: [], rules: [], at: 't' }),
    getDeviceLog: async (serial) => ({ serial, items: [], nextCursor: null, at: 't' }),
    setIdValue: async (serial, idNumber, body) => (body.timeoutMs ? { status: 'confirmed', serial, idNumber, value: body.value, at: 't' } : { status: 'sent', serial }),
    startIdTimer: async (serial, idNumber, body) => (body.timeoutMs ? { status: 'confirmed', serial, idNumber, value: body.value, at: 't' } : { status: 'sent', serial }),
    cancelIdTimer: async (serial, idNumber, body) => (body.timeoutMs ? { status: 'confirmed', serial, idNumber, restoredTo: 'low', at: 't' } : { status: 'sent', serial }),
    setRuleEnabled: async (serial, ruleNumber, body) => (body.timeoutMs ? { status: 'confirmed', serial, ruleNumber, enabled: body.enabled, at: 't' } : { status: 'sent', serial }),
    listRules: async (serial) => ({ serial, items: [], at: 't' }),
    createRule: async (serial, rule) => ({ status: 'sent', serial, ruleNumber: rule.ruleNumber, type: rule.type, result: 'ok', at: 't' }),
    deleteRule: async (serial, ruleNumber) => ({ status: 'sent', serial, ruleNumber, at: 't' }),
    clearRules: async (serial) => ({ status: 'sent', serial, cleared: 0, result: 'ok', at: 't' }),
  };
}

before(async () => {
  const kp = await generateKeyPair('ES256');
  priv = kp.privateKey;
  const pub = await exportJWK(kp.publicKey);
  pub.kid = 'test-key'; pub.alg = 'ES256';
  const jwks = createLocalJWKSet({ keys: [pub] });
  const verifier = createTokenVerifier({ issuer: ISSUER, audience: RESOURCE, jwks });
  const app = createHttpApp({ config, verifier, clientFactory: fakeClientFactory });
  await new Promise((r) => { server = app.listen(0, r); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

function mintToken({ scope = 'devices:read devices:command', sub = 'user_1', exp = '5m', aud = RESOURCE } = {}) {
  return new SignJWT({ scope })
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(ISSUER).setAudience(aud).setSubject(sub)
    .setIssuedAt().setExpirationTime(exp).sign(priv);
}

function mcpClient(token) {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  });
  return { client: new Client({ name: 'test', version: '0' }), transport };
}

test('serves OAuth protected-resource metadata (RFC 9728) pointing at the AS', async () => {
  const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(j.resource.startsWith(RESOURCE));
  assert.ok(j.authorization_servers.includes(ISSUER));
  assert.deepEqual(j.scopes_supported, config.oauth.scopesSupported);
});

test('serves AS metadata mirror (RFC 8414)', async () => {
  const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.issuer, ISSUER);
  assert.ok(j.code_challenge_methods_supported.includes('S256'));
});

test('unauthenticated → 401 with WWW-Authenticate resource_metadata', async () => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') || '', /resource_metadata=/);
});

test('valid token → tools/list + get_device; caller token is forwarded (multi-tenant)', async () => {
  const token = await mintToken({ sub: 'user_alice' });
  const { client, transport } = mcpClient(token);
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['list_devices', 'get_device', 'set_io', 'pulse_io', 'set_rule', 'list_rules', 'create_rule', 'delete_rule', 'clear_rules']) assert.ok(names.includes(n), `missing ${n}`);

  const out = await client.callTool({ name: 'get_device', arguments: { serial: 'ABCD1234' } });
  assert.match(out.content[0].text, /ABCD1234/);
  assert.equal(forwardedToken, token); // the caller's own token reached the Justworx API client

  await transport.close();
});

test('a different caller forwards a DIFFERENT token (no cross-tenant leakage)', async () => {
  const token = await mintToken({ sub: 'user_bob' });
  const { client, transport } = mcpClient(token);
  await client.connect(transport);
  await client.callTool({ name: 'list_devices', arguments: {} });
  assert.equal(forwardedToken, token);
  await transport.close();
});

test('token audience with a trailing slash is accepted (PRM resource is …/ )', async () => {
  // The advertised resource is a URL.href (`https://mcp.test.local/`); the AS binds `aud` to whatever
  // the client sent, so a token with the slash form must still verify against the no-slash config.
  const token = await mintToken({ aud: RESOURCE + '/' });
  const { client, transport } = mcpClient(token);
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.length > 0);
  await transport.close();
});

test('wrong audience → 401 (RFC 8707 resource-binding enforced)', async () => {
  const token = await mintToken({ aud: 'https://someone-elses-resource.example' });
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
});

test('bad token → connect fails (401)', async () => {
  const { client, transport } = mcpClient('not.a.valid.jwt');
  await assert.rejects(() => client.connect(transport));
  try { await transport.close(); } catch { /* already closed */ }
});

test('expired token → 401', async () => {
  const token = await mintToken({ exp: '-1s' });
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(res.status, 401);
});
