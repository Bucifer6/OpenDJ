// Play history grouped into sessions (a new session starts after a gap of more than 2 hours), with setlist export.
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonSafe, writeJsonAtomic } from './jsonstore.js';

export const SESSION_GAP_MS = 2 * 3600 * 1000;

export class History {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'history.json');
    this.data = { version: 1, sessions: [] };
    this.loadErrors = [];
    const r = readJsonSafe(this.file);
    if (r.error) { this.loadErrors.push(r.error); console.error('[opendj]', r.error); }
    if (Array.isArray(r.data?.sessions)) this.data = { ...r.data, sessions: r.data.sessions.filter((s) => s && Array.isArray(s.entries)) };
  }

  save() {
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      try { this.flush(); } catch (e) {
        console.error('[opendj] saving play history failed:', e.message);
        this.onError?.(e);
        this._t = setTimeout(() => this.save(), 5000);
      }
    }, 400);
  }
  flush() {
    clearTimeout(this._t);
    writeJsonAtomic(this.file, this.data);
  }

  /** Record a play. Returns the session it was added to. */
  record(track, at = Date.now()) {
    const sessions = this.data.sessions;
    let s = sessions.at(-1);
    if (!s || at - (s.endedAt || s.startedAt) > SESSION_GAP_MS) {
      s = { id: crypto.randomBytes(6).toString('hex'), startedAt: at, endedAt: at, entries: [] };
      sessions.push(s);
    }
    s.entries.push({
      trackId: track.id, at,
      title: track.title || '', artist: track.artist || '', bpm: track.bpm || null, key: track.key || null, duration: track.duration || null,
    });
    s.endedAt = at;
    this.save();
    return s;
  }

  list() {
    return this.data.sessions.map((s) => ({ id: s.id, name: s.name || null, startedAt: s.startedAt, endedAt: s.endedAt, count: s.entries.length })).reverse();
  }
  get(id) { return this.data.sessions.find((s) => s.id === id) || null; }
  remove(id) { this.data.sessions = this.data.sessions.filter((s) => s.id !== id); this.save(); }
  rename(id, name) { const s = this.get(id); if (s) { s.name = String(name || '').slice(0, 120) || undefined; this.save(); } return s; }
  replaceAll(data) { this.data = { version: 1, sessions: Array.isArray(data?.sessions) ? data.sessions : [] }; this.save(); }
}

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function sessionTitle(s) {
  if (s.name) return s.name;
  const d = new Date(s.startedAt);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm(s.startedAt)}`;
}

/**
 * Export a session as a setlist.
 * @param format 'txt' ("HH:MM Artist – Title"), 'csv' or 'm3u8'
 * @param resolvePath (trackId) => local file path or null, for m3u8
 */
export function exportSession(s, format = 'txt', resolvePath = () => null) {
  const e = s.entries;
  if (format === 'csv') {
    const rows = [['#', 'Time', 'Artist', 'Title', 'BPM', 'Key', 'Length'].join(',')];
    e.forEach((x, i) => rows.push([i + 1, hhmm(x.at), x.artist, x.title, x.bpm ? Number(x.bpm).toFixed(1) : '', x.key || '', x.duration ? `${Math.floor(x.duration / 60)}:${pad(Math.floor(x.duration % 60))}` : ''].map(csvCell).join(',')));
    return rows.join('\r\n') + '\r\n';
  }
  if (format === 'm3u8' || format === 'm3u') {
    const lines = ['#EXTM3U'];
    for (const x of e) {
      const p = resolvePath(x.trackId);
      if (!p) continue;
      lines.push(`#EXTINF:${Math.round(x.duration || -1)},${x.artist ? x.artist + ' - ' : ''}${x.title}`);
      lines.push(p);
    }
    return lines.join('\n') + '\n';
  }
  const head = `${sessionTitle(s)}\n\n`;
  return head + e.map((x) => `${hhmm(x.at)} ${x.artist ? `${x.artist} – ` : ''}${x.title}`).join('\n') + '\n';
}
