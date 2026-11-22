// Settings > Remote control: the AI-assistant (MCP) switch, permissions, address, token and audit log.
import { el } from '../util.js';

const put = (body) => fetch('/api/mcp/config', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => { const j = await r.json(); if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`); return j; });
const SCOPES = [['read', 'Read status and search the library (metadata only)'], ['playback', 'Control playback and mixing: decks, automix and transitions, mixer, EQ, FX, tempo, key, loops, AI stems, sampler, spoken MC lines'], ['broadcast', 'Start and stop the configured broadcast targets (by id; credentials never leave OpenDJ)']];

export function remoteSettingsPane(app) {
  const root = el('div', { class: 'form remote-settings' });
  const tokenBox = el('div', { class: 'remote-token' });
  const showToken = (token) => {
    const inp = el('input', { class: 'inp mono', readonly: true, value: token, 'aria-label': 'Access token', onfocus: (e) => e.target.select() });
    tokenBox.replaceChildren(el('p', { class: 'warn' }, 'Copy this token now: it is shown only once. Anyone with it can do what the permissions below allow.'), el('div', { class: 'row' }, inp,
      el('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(token); app.toast('Token copied'); } catch { inp.select(); } } }, 'Copy')));
  };
  const render = async () => {
    let c;
    try { c = await (await fetch('/api/mcp/config', { credentials: 'same-origin' })).json(); } catch (e) { root.replaceChildren(el('p', { class: 'hint' }, `Remote control is not available: ${e.message}`)); return; }
    const on = el('input', { type: 'checkbox', checked: c.enabled, 'data-mcp': 'enabled' });
    on.addEventListener('change', async () => { try { const r = await put({ enabled: on.checked }); if (r.token) { await render(); showToken(r.token); } else render(); } catch (e) { app.toast(e.message); on.checked = !on.checked; } });
    const scopes = SCOPES.map(([k, label]) => {
      const box = el('input', { type: 'checkbox', checked: c.scopes.includes(k), 'data-scope': k });
      box.addEventListener('change', async () => { const list = SCOPES.map(([s]) => s).filter((s) => root.querySelector(`[data-scope="${s}"]`).checked); try { await put({ scopes: list }); } catch (e) { app.toast(e.message); } });
      return el('label', { class: 'check' }, box, ` ${label}`);
    });
    const host = el('select', { class: 'sel', 'data-mcp': 'host', disabled: c.hosted }, el('option', { value: '127.0.0.1' }, 'This computer only (127.0.0.1, recommended)'), el('option', { value: '0.0.0.0' }, 'All networks (0.0.0.0): other devices can connect'));
    host.value = c.host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0';
    host.addEventListener('change', async () => {
      if (host.value !== '127.0.0.1' && !(await app.dialogs.confirm('Expose remote control on your network? Any device on your networks that has the token can then control OpenDJ. Use it only on a network you trust; "This computer only" is safer.'))) { host.value = '127.0.0.1'; return; }
      try { await put({ host: host.value }); render(); } catch (e) { app.toast(e.message); }
    });
    const port = el('input', { class: 'inp', type: 'number', min: 1024, max: 65535, value: c.port, disabled: c.hosted, style: { width: '90px' }, 'data-mcp': 'port' });
    port.addEventListener('change', async () => { try { await put({ port: Number(port.value) }); render(); } catch (e) { app.toast(e.message); } });
    const status = c.enabled ? (c.error ? `Not running: ${c.error}` : c.running ? `Running at ${c.url}` : 'Starting…') : 'Off';
    const auditList = el('ol', { class: 'remote-audit' });
    const loadAudit = async () => {
      try {
        const { entries } = await (await fetch('/api/mcp/audit', { credentials: 'same-origin' })).json();
        auditList.replaceChildren(...entries.slice(0, 60).map((e) => el('li', { class: e.ok ? '' : 'bad' }, el('time', {}, new Date(e.at).toLocaleTimeString()), ` ${e.tool}`, e.args ? el('code', {}, ` ${e.args}`) : null, e.ok ? '' : ` — ${e.error}`, el('small', {}, ` (${e.ip})`))));
        if (!entries.length) auditList.append(el('li', { class: 'hint' }, 'No activity yet.'));
      } catch { /* */ }
    };
    root.replaceChildren(...[
      el('p', { class: 'hint' }, 'Let an AI assistant (an MCP client such as Claude Desktop or Claude Code) control OpenDJ: status, library search, decks, automix, sampler, dedications and your broadcast targets. It never gets your files, folders, settings or passwords.'),
      el('label', { class: 'check' }, on, ' Allow AI assistants to control OpenDJ (MCP)'),
      el('p', { class: 'hint', 'data-mcp': 'status' }, `Status: ${status}${c.enabled && !c.pageConnected ? ' · waiting for this window' : ''}`),
      c.exposed ? el('p', { class: 'warn', 'data-mcp': 'exposed' }, '⚠ Remote control is reachable from other devices on your networks. Only the token protects it; switch back to "This computer only" unless you need this.') : null,
      el('h4', {}, 'Permissions'), ...scopes,
      c.hosted ? el('p', { class: 'hint' }, `Hosted server: the endpoint is ${location.origin}${c.url}. Clients need a signed-in session cookie and the token.`)
        : el('div', { class: 'row' }, el('label', { class: 'field' }, el('span', {}, 'Address'), host), el('label', { class: 'field' }, el('span', {}, 'Port'), port)),
      el('h4', {}, 'Access token'),
      el('p', { class: 'hint' }, c.hasToken ? 'A token exists (only its hash is stored). Clients send it as "Authorization: Bearer <token>". A new token disconnects every client.' : 'A token is created when you turn remote control on.'),
      tokenBox,
      el('button', { class: 'btn sm', onclick: async () => { const r = await (await fetch('/api/mcp/token', { method: 'POST', credentials: 'same-origin' })).json(); showToken(r.token); } }, c.hasToken ? 'Create a new token' : 'Create token'),
      el('h4', {}, 'Activity'), el('button', { class: 'btn xs', onclick: loadAudit }, 'Refresh'), auditList,
    ].filter(Boolean));
    loadAudit();
  };
  render();
  return root;
}
