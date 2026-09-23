// Thin client for the Justworx API (/api/v2). The MCP server is just an authenticated consumer of
// that surface -- no direct backend access. Kept tiny and dependency-free (native fetch) so it's
// trivial to reason about and to stub in tests.

export class JustworxApiError extends Error {
  constructor(status, code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export class JustworxApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl e.g. https://api.justworx.com/api/v2
   * @param {string} [opts.apiKey] a jwx_live_… key (stdio / single-tenant)
   * @param {string} [opts.token]  an OAuth 2.1 access token (remote / multi-tenant) -- takes
   *   precedence over apiKey. The API accepts either as the Bearer.
   * @param {number} [opts.timeoutMs]
   * @param {typeof fetch} [opts.fetch] injectable for tests
   */
  constructor({ baseUrl, apiKey, token, timeoutMs = 30000, fetch: fetchImpl } = {}) {
    if (!baseUrl) throw new Error('JustworxApiClient: baseUrl required');
    const bearer = token || apiKey;
    if (!bearer) throw new Error('JustworxApiClient: apiKey or token required');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.bearer = bearer;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async #request(method, path, { query, body } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.bearer}`,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new JustworxApiError(0, 'NETWORK_ERROR', err.name === 'AbortError' ? 'request timed out' : err.message);
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    const json = text ? safeJson(text) : {};
    if (!res.ok) throw new JustworxApiError(res.status, json.error || 'HTTP_' + res.status, json.detail);
    return json;
  }

  whoami() { return this.#request('GET', '/me'); }
  listDevices(query) { return this.#request('GET', '/devices', { query }); }
  getDevice(serial) { return this.#request('GET', `/devices/${encodeURIComponent(serial)}`); }

  // Device HISTORY -- commands sent, replies received, values reported, connection changes.
  // NOT the same-named but different-purpose /devices/{serial}/events, which is that device's
  // event NOTIFICATION SETTINGS (enabled/verb/suffix/channel per event key), never history.
  getDeviceLog(serial, query) {
    return this.#request('GET', `/devices/${encodeURIComponent(serial)}/log`, { query });
  }

  // Each of these used to be built on a single generic dispatch call, POST
  // /devices/{serial}/commands. /api/v2 has no such endpoint any more -- every action is its own
  // REST verb+path. A caller's `confirm: true` still means "send timeoutMs: 8000"; that mapping is
  // unchanged, it now just targets the per-action endpoint instead of the old dispatcher.
  setIdValue(serial, idNumber, { value, force, timeoutMs, requestId } = {}) {
    return this.#request('PUT', `/devices/${encodeURIComponent(serial)}/ids/${idNumber}/value`, {
      body: {
        value,
        ...(force !== undefined ? { force } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  }

  startIdTimer(serial, idNumber, { value, durationMs, revertState, timeoutMs, requestId } = {}) {
    return this.#request('POST', `/devices/${encodeURIComponent(serial)}/ids/${idNumber}/timer`, {
      body: {
        value,
        durationMs,
        ...(revertState !== undefined ? { revertState } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  }

  cancelIdTimer(serial, idNumber, { timeoutMs, requestId } = {}) {
    return this.#request('DELETE', `/devices/${encodeURIComponent(serial)}/ids/${idNumber}/timer`, {
      body: {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  }

  setRuleEnabled(serial, ruleNumber, { enabled, timeoutMs, requestId } = {}) {
    return this.#request('PATCH', `/devices/${encodeURIComponent(serial)}/rules/${ruleNumber}`, {
      body: {
        enabled,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  }

  // Rules -- logic that lives on the device itself, evaluated continuously with no cloud round
  // trip, and it keeps working when the device is offline.

  listRules(serial) {
    return this.#request('GET', `/devices/${encodeURIComponent(serial)}/rules`);
  }

  // `rule` is a full RuleCreate body: { ruleNumber, type: 'digital'|'analog'|'schedule', if, then,
  // name?, enabled?, runIntervalMs?, onTrueJumpToRule?, onFalseJumpToRule?, timeoutMs?, requestId? }.
  // Reusing an existing ruleNumber REPLACES that rule.
  createRule(serial, rule) {
    return this.#request('POST', `/devices/${encodeURIComponent(serial)}/rules`, { body: rule });
  }

  deleteRule(serial, ruleNumber, { timeoutMs, requestId } = {}) {
    return this.#request('DELETE', `/devices/${encodeURIComponent(serial)}/rules/${ruleNumber}`, {
      body: {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  }

  // Deletes EVERY rule on the device. `confirm: true` is a required wire field, not the
  // client-side "wait longer" convenience the other methods use -- the API refuses this call
  // without it, no default and no inference.
  clearRules(serial, { confirm, timeoutMs, requestId } = {}) {
    if (confirm !== true) {
      throw new Error('JustworxApiClient.clearRules requires { confirm: true } -- it deletes every rule on the device and cannot be undone');
    }
    return this.#request('DELETE', `/devices/${encodeURIComponent(serial)}/rules`, {
      body: {
        confirm: true,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return { error: 'NON_JSON_RESPONSE', detail: text.slice(0, 200) }; }
}
