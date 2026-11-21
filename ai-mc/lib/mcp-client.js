// Minimal MCP client (Streamable HTTP, JSON responses) for OpenDJ's remote-control server (Settings → Remote control).
// AI MC drives the DJ through it: queue the next track, the transition style, when to mix out, the track structure.
const PROTOCOL = '2025-06-18';

export class McpClient {
  constructor({ url = 'http://127.0.0.1:47800/mcp', token = '' } = {}) { this.url = url; this.token = token; this.session = null; this.nextId = 1; }

  get configured() { return !!(this.url && this.token); }

  async post(body) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${this.token}`, 'MCP-Protocol-Version': PROTOCOL };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const r = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const sid = r.headers.get('mcp-session-id');
    if (sid) this.session = sid;
    if (r.status === 202) return null;
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { throw new Error(`OpenDJ MCP ${r.status}: ${text.slice(0, 160)}`); }
    if (r.status === 404 && this.session) { this.session = null; throw Object.assign(new Error('session expired'), { retry: true }); }
    if (j.error) throw new Error(`OpenDJ MCP: ${j.error.message}`);
    return j.result;
  }

  async connect() {
    this.session = null;
    await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'AI MC', version: '1.0' } } });
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async tools() {
    if (!this.session) await this.connect();
    return (await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/list' })).tools.map((t) => t.name);
  }

  /** Calls a tool; returns its structured result, throws its error text. Reconnects once if the session expired. */
  async call(name, args = {}) {
    if (!this.configured) throw new Error('MCP nu e configurat (adresa și tokenul din OpenDJ → Settings → Remote control)');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (!this.session) await this.connect();
        const r = await this.post({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } });
        if (r.isError) throw new Error(r.content?.[0]?.text || `${name} a eșuat`);
        return r.structuredContent ?? r.content;
      } catch (e) {
        if (!e.retry || attempt) throw e;
      }
    }
  }
}
