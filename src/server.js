// Builds the Justworx MCP server: device tools + read-only device resources, all backed by
// the Justworx API client. Transport-agnostic -- index.js wires stdio; tests wire in-memory.

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { JustworxApiError } from './apiClient.js';

const ioState = z.union([z.enum(['high', 'low']), z.number()]).describe('high/low for digital, or a number for analog');
const serialSchema = z.string().regex(/^[A-Z0-9]{8}$/).describe("the device's 8-char serial (e.g. ABCD1234)");

// Wrap a handler so API errors surface as tool errors (not thrown), which is how
// MCP clients expect tools to report failure.
function tool(handler) {
  return async (args) => {
    try {
      const data = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      const msg = err instanceof JustworxApiError
        ? `Justworx API error ${err.status} ${err.code}${err.detail ? ': ' + err.detail : ''}`
        : `Error: ${err.message}`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  };
}

export function buildServer({ client }) {
  const server = new McpServer({ name: 'justworx', version: '0.2.0' }, {
    instructions:
      'Control and monitor Justworx devices. Use list_devices to discover devices, get_device for ' +
      'live state, and set_io/pulse_io/set_rule to actuate. Use list_rules/create_rule/delete_rule ' +
      'to manage on-device automations; clear_rules deletes all of them and needs confirm:true. Pass ' +
      'confirm:true on actuation to wait for a confirmed device reply. Locks/garage doors may require ' +
      'confirmation at the platform level.',
  });

  // ---- tools ----

  server.registerTool('list_devices', {
    title: 'List devices',
    description: 'List devices the credential can access. Optional filter: online. Cursor-paginated.',
    inputSchema: {
      online: z.boolean().optional().describe('only devices currently online, or only those that are not'),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
  }, tool((a) => client.listDevices(a)));

  server.registerTool('get_device', {
    title: 'Get device',
    description: "Full live state of one device (network, location, every configured ID and its last "
      + "known value, every rule) from its digital twin. Never touches the device, works while it's offline.",
    inputSchema: { serial: serialSchema },
  }, tool(({ serial }) => client.getDevice(serial)));

  server.registerTool('get_device_log', {
    title: 'Get device history',
    description: 'A device’s history, newest first: commands sent, replies received, values '
      + 'reported, connection changes. Reads stored data only -- not the same as get_device_events '
      + 'settings; there is no such tool because that endpoint configures notifications, not history.',
    inputSchema: {
      serial: serialSchema,
      from: z.string().describe('ISO-8601 start, defaults to 24h ago').optional(),
      to: z.string().describe('ISO-8601 end, defaults to now').optional(),
      type: z.string().describe(
        'restrict to one entry type, e.g. value_reported, value_written, rule_fired, device_online, '
        + 'device_offline, set_value, create_rule -- see the API reference for the full vocabulary',
      ).optional(),
      idNumber: z.number().int().optional().describe('only entries involving this ID'),
      ruleNumber: z.number().int().optional().describe('only entries involving this rule'),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().optional(),
    },
  }, tool(({ serial, ...q }) => client.getDeviceLog(serial, q)));

  server.registerTool('set_io', {
    title: 'Set an ID (latch)',
    description: 'Set a device ID to a value and hold it. Pass confirm:true to wait for a confirmed device reply.',
    inputSchema: {
      serial: serialSchema,
      idNumber: z.number().int(),
      value: ioState,
      force: z.boolean().optional().describe('drive the ID directly, bypassing its configured timer/delay'),
      confirm: z.boolean().optional(),
    },
  }, tool(({ serial, idNumber, value, force, confirm }) =>
    client.setIdValue(serial, idNumber, {
      value,
      ...(force !== undefined ? { force } : {}),
      ...(confirm ? { timeoutMs: 8000 } : {}),
    })));

  server.registerTool('pulse_io', {
    title: 'Pulse an ID',
    description: 'Drive an ID to a value for durationMs, then revert. Useful for momentary actions (e.g. a gate trigger).',
    inputSchema: {
      serial: serialSchema,
      idNumber: z.number().int(),
      value: ioState,
      durationMs: z.number().int().min(1),
      revertState: ioState.optional(),
      confirm: z.boolean().optional(),
    },
  }, tool(({ serial, idNumber, value, durationMs, revertState, confirm }) =>
    client.startIdTimer(serial, idNumber, {
      value,
      durationMs,
      ...(revertState !== undefined ? { revertState } : {}),
      ...(confirm ? { timeoutMs: 8000 } : {}),
    })));

  server.registerTool('cancel_timer', {
    title: 'Cancel a pending timer',
    description: 'Cancel a running pulse_io timer (or a forced write’s timer) on one ID before it reverts on its own.',
    inputSchema: {
      serial: serialSchema,
      idNumber: z.number().int(),
      confirm: z.boolean().optional(),
    },
  }, tool(({ serial, idNumber, confirm }) =>
    client.cancelIdTimer(serial, idNumber, { ...(confirm ? { timeoutMs: 8000 } : {}) })));

  server.registerTool('set_rule', {
    title: 'Enable/disable a rule',
    description: 'Enable or disable an on-device rule by its ruleNumber, leaving its definition in place.',
    inputSchema: {
      serial: serialSchema,
      ruleNumber: z.number().int(),
      enabled: z.boolean(),
      confirm: z.boolean().optional(),
    },
  }, tool(({ serial, ruleNumber, enabled, confirm }) =>
    client.setRuleEnabled(serial, ruleNumber, { enabled, ...(confirm ? { timeoutMs: 8000 } : {}) })));

  // Rules. `if`/`then` are kept loosely typed (not an exhaustive discriminated union per
  // condition/action type) -- the API validates them against `type`; this schema just needs to
  // get a plain object through.
  //
  // The `then` description below uses the same plain-language labels Justworx Studio's rule
  // builder uses, rather than this connector inventing its own wording for the same 15 actions.
  const THEN_ACTION_VOCAB =
    'setState ("Set an output"), refreshId ("Update this ID to the cloud" -- one-shot forced ' +
    'read), enableRule/disableRule ("Turn on/off another rule"), getRules ("Report this device\'s ' +
    'rules"), createId ("Configure a new IO" for a new idNumber, "Edit an existing IO" for one ' +
    'already in use), deleteId ("Delete an IO", destructive), clearIds ("Delete every IO", ' +
    'destructive+unrecoverable, needs confirm:true), setTimer ("Pulse an IO"), cancelTimer ' +
    '("Cancel a timer on one IO"), cancelAllTimers ("Cancel all timers"), reboot ("Reboot ' +
    'device"), addTelemetry ("Start reporting an IO\'s value on a schedule"), removeTelemetry ' +
    '("Stop reporting an IO\'s value"), setTracking ("Turn location tracking on/off"). ' +
    'createRule/deleteRule/clearRules are never valid here -- rule management cannot be a rule\'s ' +
    'own action.';

  server.registerTool('list_rules', {
    title: 'List rules',
    description: 'List every rule stored on a device.',
    inputSchema: { serial: serialSchema },
  }, tool(({ serial }) => client.listRules(serial)));

  server.registerTool('create_rule', {
    title: 'Create or replace a rule',
    description: 'Create an on-device rule, or replace an existing one by reusing its ruleNumber. '
      + '`if` shape depends on `type`: digital {id, state, forMs?}, analog {id, mode, threshold?/variance?, '
      + 'forMs?}, schedule {startTime, endTime, daysOfWeek?, startDate?, endDate?}. `then` is any action the '
      + 'device supports except createRule/deleteRule/clearRules (getRules and refreshId are fine -- reading '
      + "changes nothing). runIntervalMs (default 500) can't go below 500.",
    inputSchema: {
      serial: serialSchema,
      ruleNumber: z.number().int().describe('reusing an existing number REPLACES that rule'),
      type: z.enum(['digital', 'analog', 'schedule']),
      if: z.record(z.any()).describe('the condition, shaped by type -- see tool description'),
      then: z.record(z.any()).describe(`the action to fire when the condition is met. type selects it: ${THEN_ACTION_VOCAB}`),
      name: z.string().max(120).nullable().optional().describe('label only, never sent to the device'),
      enabled: z.boolean().optional().describe('default true'),
      runIntervalMs: z.number().int().min(500).optional().describe('how often the device checks the condition, default 500'),
      onTrueJumpToRule: z.number().int().optional(),
      onFalseJumpToRule: z.number().int().optional(),
      confirm: z.boolean().optional(),
      requestId: z.string().optional(),
    },
  }, tool(({ serial, confirm, ...rule }) =>
    client.createRule(serial, { ...rule, ...(confirm ? { timeoutMs: 8000 } : {}) })));

  server.registerTool('delete_rule', {
    title: 'Delete a rule',
    description: 'Delete one rule by ruleNumber.',
    inputSchema: {
      serial: serialSchema,
      ruleNumber: z.number().int(),
      confirm: z.boolean().optional(),
    },
  }, tool(({ serial, ruleNumber, confirm }) =>
    client.deleteRule(serial, ruleNumber, { ...(confirm ? { timeoutMs: 8000 } : {}) })));

  server.registerTool('clear_rules', {
    title: 'Delete ALL rules on a device',
    description: 'Deletes EVERY rule on a device. Cannot be undone. Unlike confirm on the other '
      + 'tools here (which just waits for the device\'s reply), confirm here is a required safety '
      + 'gate the API refuses this call without -- it must be passed explicitly every time; never '
      + 'infer it from a vague request like "clean up the rules."',
    inputSchema: {
      serial: serialSchema,
      confirm: z.literal(true).describe('REQUIRED, must be exactly true -- confirms deleting every rule on the device'),
      requestId: z.string().optional(),
    },
  }, tool(({ serial, confirm, requestId }) => client.clearRules(serial, { confirm, ...(requestId ? { requestId } : {}) })));

  // ---- resources (read-only context) ----

  server.registerResource('devices', 'justworx://devices', {
    title: 'Devices',
    description: 'The list of devices the credential can access.',
    mimeType: 'application/json',
  }, async (uri) => {
    const data = await client.listDevices({});
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  });

  server.registerResource('device', new ResourceTemplate('justworx://devices/{serial}', { list: undefined }), {
    title: 'Device state',
    description: 'Live twin state for a single device.',
    mimeType: 'application/json',
  }, async (uri, { serial }) => {
    const data = await client.getDevice(Array.isArray(serial) ? serial[0] : serial);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
  });

  return server;
}
