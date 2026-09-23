import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildServer } from '../src/server.js';
import { JustworxApiError } from '../src/apiClient.js';

// A realistic 8-char [A-Z0-9]{8} device serial — devices are identified by this serial number.
const SERIAL = 'ABCD1234';
const MISSING_SERIAL = 'ZZZZ9999';

// A fake Justworx API client that records calls and returns canned data shaped like the real
// /api/v2 contract.
class FakeApi {
  constructor() { this.calls = []; }
  async listDevices(q) { this.calls.push(['listDevices', q]); return { items: [{ serial: SERIAL, name: null, online: true, lastSeenAt: 't', access: 'owner' }], nextCursor: null }; }
  async getDevice(serial) {
    this.calls.push(['getDevice', serial]);
    if (serial === MISSING_SERIAL) throw new JustworxApiError(404, 'NOT_FOUND');
    return { serial, online: true, ids: [{ idNumber: 10, type: 'digitalOutput', value: 'low' }], rules: [], at: 't' };
  }
  async getDeviceLog(serial, q) { this.calls.push(['getDeviceLog', serial, q]); return { serial, items: [{ type: 'device_online', at: 't' }], nextCursor: null, at: 't' }; }
  async setIdValue(serial, idNumber, body) {
    this.calls.push(['setIdValue', serial, idNumber, body]);
    return body.timeoutMs ? { status: 'confirmed', serial, idNumber, value: body.value, at: 't' } : { status: 'sent', serial };
  }
  async startIdTimer(serial, idNumber, body) {
    this.calls.push(['startIdTimer', serial, idNumber, body]);
    return body.timeoutMs
      ? { status: 'confirmed', serial, idNumber, value: body.value, revertsInMs: body.durationMs, at: 't' }
      : { status: 'sent', serial };
  }
  async cancelIdTimer(serial, idNumber, body) {
    this.calls.push(['cancelIdTimer', serial, idNumber, body]);
    return body.timeoutMs ? { status: 'confirmed', serial, idNumber, restoredTo: 'low', at: 't' } : { status: 'sent', serial };
  }
  async setRuleEnabled(serial, ruleNumber, body) {
    this.calls.push(['setRuleEnabled', serial, ruleNumber, body]);
    return body.timeoutMs ? { status: 'confirmed', serial, ruleNumber, enabled: body.enabled, at: 't' } : { status: 'sent', serial };
  }
  async listRules(serial) { this.calls.push(['listRules', serial]); return { serial, items: [{ ruleNumber: 3, type: 'digital', enabled: true }], at: 't' }; }
  async createRule(serial, rule) { this.calls.push(['createRule', serial, rule]); return { status: 'sent', serial, ruleNumber: rule.ruleNumber, type: rule.type, result: 'ok', at: 't' }; }
  async deleteRule(serial, ruleNumber, body) { this.calls.push(['deleteRule', serial, ruleNumber, body]); return { status: 'sent', serial, ruleNumber, at: 't' }; }
  async clearRules(serial, body) {
    this.calls.push(['clearRules', serial, body]);
    if (body.confirm !== true) throw new JustworxApiError(400, 'CONFIRM_REQUIRED');
    return { status: 'sent', serial, cleared: 2, result: 'ok', at: 't' };
  }
}

let fake;
let client;

before(async () => {
  fake = new FakeApi();
  const server = buildServer({ client: fake });
  client = new Client({ name: 'test', version: '1.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
});

beforeEach(() => { fake.calls = []; });

const parse = (res) => JSON.parse(res.content[0].text);

test('advertises the expected tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'cancel_timer', 'clear_rules', 'create_rule', 'delete_rule', 'get_device', 'get_device_log',
    'list_devices', 'list_rules', 'pulse_io', 'set_io', 'set_rule',
  ]);
});

test('list_devices has no status/productId filter any more, and returns data', async () => {
  const res = await client.callTool({ name: 'list_devices', arguments: { online: true } });
  assert.notEqual(res.isError, true);
  assert.equal(parse(res).items[0].serial, SERIAL);
  assert.deepEqual(fake.calls[0], ['listDevices', { online: true }]);
});

test('get_device returns the twin; API 404 surfaces as a tool error', async () => {
  const ok = await client.callTool({ name: 'get_device', arguments: { serial: SERIAL } });
  assert.equal(parse(ok).serial, SERIAL);

  const miss = await client.callTool({ name: 'get_device', arguments: { serial: MISSING_SERIAL } });
  assert.equal(miss.isError, true);
  assert.match(miss.content[0].text, /NOT_FOUND/);
});

test('get_device_log calls GET .../log, not the events-settings endpoint', async () => {
  const res = await client.callTool({ name: 'get_device_log', arguments: { serial: SERIAL, type: 'value_reported' } });
  assert.notEqual(res.isError, true);
  assert.deepEqual(fake.calls[0], ['getDeviceLog', SERIAL, { type: 'value_reported' }]);
});

test('set_io with confirm adds timeoutMs:8000 → confirmed', async () => {
  const res = await client.callTool({ name: 'set_io', arguments: { serial: SERIAL, idNumber: 10, value: 'high', confirm: true } });
  assert.equal(parse(res).status, 'confirmed');
  assert.deepEqual(fake.calls[0], ['setIdValue', SERIAL, 10, { value: 'high', timeoutMs: 8000 }]);
});

test('set_io without confirm is fire-and-forget → sent, no timeoutMs', async () => {
  const res = await client.callTool({ name: 'set_io', arguments: { serial: SERIAL, idNumber: 10, value: 'low' } });
  assert.equal(parse(res).status, 'sent');
  assert.deepEqual(fake.calls[0][3], { value: 'low' });
});

test('set_io passes force through', async () => {
  await client.callTool({ name: 'set_io', arguments: { serial: SERIAL, idNumber: 1, value: 'high', force: true } });
  assert.deepEqual(fake.calls[0][3], { value: 'high', force: true });
});

test('pulse_io maps durationMs and revertState onto startIdTimer', async () => {
  await client.callTool({ name: 'pulse_io', arguments: { serial: SERIAL, idNumber: 10, value: 'high', durationMs: 3000, revertState: 'low' } });
  assert.deepEqual(fake.calls[0], ['startIdTimer', SERIAL, 10, { value: 'high', durationMs: 3000, revertState: 'low' }]);
});

test('cancel_timer maps onto cancelIdTimer', async () => {
  await client.callTool({ name: 'cancel_timer', arguments: { serial: SERIAL, idNumber: 10, confirm: true } });
  assert.deepEqual(fake.calls[0], ['cancelIdTimer', SERIAL, 10, { timeoutMs: 8000 }]);
});

test('set_rule maps ruleNumber onto setRuleEnabled', async () => {
  await client.callTool({ name: 'set_rule', arguments: { serial: SERIAL, ruleNumber: 3, enabled: false } });
  assert.deepEqual(fake.calls[0], ['setRuleEnabled', SERIAL, 3, { enabled: false }]);
});

test('list_rules maps onto listRules', async () => {
  const res = await client.callTool({ name: 'list_rules', arguments: { serial: SERIAL } });
  assert.equal(parse(res).items[0].ruleNumber, 3);
  assert.deepEqual(fake.calls[0], ['listRules', SERIAL]);
});

test('create_rule passes ruleNumber/type/if/then through, confirm adds timeoutMs:8000', async () => {
  const rule = { ruleNumber: 12, type: 'digital', if: { id: 5, state: 'high' }, then: { type: 'setState', idNumber: 6, value: 'high' }, confirm: true };
  const res = await client.callTool({ name: 'create_rule', arguments: { serial: SERIAL, ...rule } });
  assert.notEqual(res.isError, true);
  assert.deepEqual(fake.calls[0], ['createRule', SERIAL, {
    ruleNumber: 12, type: 'digital', if: { id: 5, state: 'high' }, then: { type: 'setState', idNumber: 6, value: 'high' }, timeoutMs: 8000,
  }]);
});

test('delete_rule maps ruleNumber onto deleteRule', async () => {
  await client.callTool({ name: 'delete_rule', arguments: { serial: SERIAL, ruleNumber: 3 } });
  assert.deepEqual(fake.calls[0], ['deleteRule', SERIAL, 3, {}]);
});

test('clear_rules requires confirm:true -- schema rejects it missing, API call carries it', async () => {
  let errored = false;
  try {
    const res = await client.callTool({ name: 'clear_rules', arguments: { serial: SERIAL } });
    errored = res.isError === true;
  } catch {
    errored = true;
  }
  assert.equal(errored, true, 'clear_rules without confirm must fail, not silently wipe every rule');

  const res = await client.callTool({ name: 'clear_rules', arguments: { serial: SERIAL, confirm: true } });
  assert.equal(parse(res).cleared, 2);
  assert.deepEqual(fake.calls.at(-1), ['clearRules', SERIAL, { confirm: true }]);
});

test('invalid tool input is rejected (missing required serial)', async () => {
  let errored = false;
  try {
    const res = await client.callTool({ name: 'get_device', arguments: {} });
    errored = res.isError === true;
  } catch {
    errored = true; // SDK may throw on schema violation
  }
  assert.equal(errored, true);
});

test('exposes a devices list resource and a per-device template', async () => {
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'justworx://devices'));

  const { resourceTemplates } = await client.listResourceTemplates();
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === 'justworx://devices/{serial}'));

  const list = await client.readResource({ uri: 'justworx://devices' });
  assert.equal(JSON.parse(list.contents[0].text).items[0].serial, SERIAL);

  const one = await client.readResource({ uri: `justworx://devices/${SERIAL}` });
  assert.equal(JSON.parse(one.contents[0].text).serial, SERIAL);
  assert.deepEqual(fake.calls.at(-1), ['getDevice', SERIAL]);
});
