// rekordbox XML ("DJ_PLAYLISTS") import/export.
import { XMLParser } from 'fast-xml-parser';

const RATING_STEPS = [0, 51, 102, 153, 204, 255];

const ARRAY_TAGS = new Set(['TRACK', 'POSITION_MARK', 'TEMPO', 'NODE']);

function num(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    // Decode valid %XX sequences one by one; leave stray '%' alone.
    return s.replace(/(%[0-9A-Fa-f]{2})+/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
  }
}

/** file://localhost/C:/Music/a%20b.mp3 -> C:\Music\a b.mp3 ; file://localhost/Users/x/a.mp3 -> /Users/x/a.mp3 */
export function locationToPath(location) {
  if (!location) return null;
  let s = String(location);
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/\/localhost(?=\/)/i, '').replace(/^file:\/\/(?=\/)/i, '').replace(/^file:/i, '');
  }
  s = safeDecode(s);
  // Windows drive letter: "/C:/Music/x.mp3" (or "C:/...")
  const drive = /^\/?([A-Za-z]):[\\/]/.exec(s);
  if (drive) return s.replace(/^\//, '').replace(/\//g, '\\');
  // UNC share: "//server/share/x.mp3"
  if (/^\/\/[^/]/.test(s)) return s.replace(/\//g, '\\');
  return s;
}

/** Local path -> rekordbox Location URL. */
export function pathToLocation(p) {
  let s = String(p || '').replace(/\\/g, '/');
  const isUnc = s.startsWith('//');
  const enc = (seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg));
  if (isUnc) {
    return 'file://localhost//' + s.slice(2).split('/').map((seg) => encodeURIComponent(seg)).join('/');
  }
  if (/^[A-Za-z]:\//.test(s)) {
    return 'file://localhost/' + s.split('/').map(enc).join('/');
  }
  if (!s.startsWith('/')) s = '/' + s;
  return 'file://localhost' + s.split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function toHex(r, g, b) {
  const h = (n) => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function fromHex(color) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color || ''));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** rekordbox track Colour "0xFF007F" <-> "#ff007f" */
export function colourToHex(c) {
  const m = /^(?:0x|#)?([0-9a-f]{6})$/i.exec(String(c || '').trim());
  return m ? '#' + m[1].toLowerCase() : null;
}
export function hexToColour(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  return m ? '0x' + m[1].toUpperCase() : undefined;
}

/**
 * Parse a rekordbox XML export.
 * @returns {{ tracks: object[], playlists: { name, path: string[], trackKeys: string[] }[] }}
 */
export function parseRekordboxXml(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
    htmlEntities: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  const doc = parser.parse(xmlString);
  const root = doc?.DJ_PLAYLISTS;
  if (!root) throw new Error('Not a rekordbox XML file (missing DJ_PLAYLISTS)');

  const collection = asArray(root.COLLECTION)[0] || {};
  const byTrackId = new Map();
  const tracks = [];
  for (const t of asArray(collection.TRACK)) {
    const location = locationToPath(t.Location);
    const tempos = asArray(t.TEMPO);
    const firstTempo = tempos[0];
    const cues = asArray(t.POSITION_MARK).map((m) => {
      const index = num(m.Num, -1);
      const cue = {
        type: index >= 0 ? 'hot' : 'memory',
        index,
        position: num(m.Start, 0),
        name: m.Name || '',
      };
      if (m.Red !== undefined || m.Green !== undefined || m.Blue !== undefined) cue.color = toHex(m.Red, m.Green, m.Blue);
      if (m.End !== undefined && m.End !== '') cue.loopEnd = num(m.End);
      return cue;
    });
    const ratingRaw = num(t.Rating, 0);
    const track = {
      trackId: t.TrackID != null ? String(t.TrackID) : null,
      location,
      title: t.Name || '',
      artist: t.Artist || '',
      album: t.Album || '',
      genre: t.Genre || '',
      bpm: num(t.AverageBpm),
      key: t.Tonality || '',
      duration: num(t.TotalTime),
      rating: Math.max(0, Math.min(5, Math.round(ratingRaw / 51))),
      comments: t.Comments || '',
      color: colourToHex(t.Colour),
      cues,
      grid: firstTempo ? { bpm: num(firstTempo.Bpm), offset: num(firstTempo.Inizio, 0) } : null,
    };
    tracks.push(track);
    if (track.trackId) byTrackId.set(track.trackId, track);
  }

  const playlists = [];
  const walk = (node, path) => {
    for (const n of asArray(node.NODE)) {
      const type = String(n.Type);
      if (type === '0') {
        walk(n, [...path, n.Name || '']);
      } else if (type === '1') {
        const keyType = String(n.KeyType ?? '0');
        const trackKeys = [];
        for (const k of asArray(n.TRACK)) {
          if (keyType === '1') trackKeys.push(locationToPath(k.Key));
          else {
            const t = byTrackId.get(String(k.Key));
            if (t) trackKeys.push(t.location);
          }
        }
        playlists.push({ name: n.Name || '', path, trackKeys });
      }
    }
  };
  const plRoot = asArray(root.PLAYLISTS)[0];
  if (plRoot) {
    // The top node is ROOT; its name is not part of the folder path.
    for (const top of asArray(plRoot.NODE)) {
      if (String(top.Type) === '0' && (top.Name || '').toUpperCase() === 'ROOT') walk(top, []);
      else walk({ NODE: [top] }, []);
    }
  }
  return { tracks, playlists };
}

// --- writer ---------------------------------------------------------------

function esc(v) {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');
}

function attrs(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
}

const KIND = { mp3: 'MP3 File', flac: 'FLAC File', wav: 'WAV File', aif: 'AIFF File', aiff: 'AIFF File', m4a: 'M4A File', aac: 'M4A File', mp4: 'M4A File', ogg: 'OGG File', alac: 'M4A File' };

function fmtNum(n, digits) {
  return Number(n).toFixed(digits);
}

/**
 * Build a rekordbox XML string.
 * tracks: [{ id, path, title, artist, album, genre, bpm, key, duration, rating, cues:[{index,position,name,type,loopEnd?,color?}], gridOffset }]
 * playlists: [{ name, trackIds, path?: string[] (folders) }]
 */
export function buildRekordboxXml({ tracks = [], playlists = [] } = {}) {
  const idMap = new Map();
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<DJ_PLAYLISTS Version="1.0.0">');
  out.push(`  <PRODUCT${attrs({ Name: 'OpenDJ', Version: '0.1.0', Company: 'OpenDJ' })}/>`);
  out.push(`  <COLLECTION Entries="${tracks.length}">`);
  tracks.forEach((t, i) => {
    const trackId = i + 1;
    idMap.set(String(t.id), trackId);
    const ext = (/\.([A-Za-z0-9]+)$/.exec(t.path || '') || [])[1]?.toLowerCase();
    const rating = RATING_STEPS[Math.max(0, Math.min(5, Math.round(Number(t.rating) || 0)))];
    const a = {
      TrackID: trackId,
      Name: t.title || '',
      Artist: t.artist || '',
      Album: t.album || '',
      Genre: t.genre || '',
      Kind: (ext && KIND[ext]) || (ext ? `${ext.toUpperCase()} File` : ''),
      TotalTime: t.duration != null ? Math.round(Number(t.duration)) : 0,
      AverageBpm: t.bpm ? fmtNum(t.bpm, 2) : '0.00',
      Tonality: t.key || '',
      Rating: rating,
      Comments: t.comments ?? t.comment ?? '',
      Colour: hexToColour(t.color),
      Location: pathToLocation(t.path),
    };
    const children = [];
    if (t.bpm) {
      children.push(`      <TEMPO${attrs({ Inizio: fmtNum(t.gridOffset || 0, 3), Bpm: fmtNum(t.bpm, 2), Metro: '4/4', Battito: 1 })}/>`);
    }
    for (const c of t.cues || []) {
      const isHot = c.type ? c.type === 'hot' : Number(c.index) >= 0;
      const m = {
        Name: c.name || '',
        Type: c.loopEnd != null ? 4 : 0,
        Start: fmtNum(c.position || 0, 3),
        End: c.loopEnd != null ? fmtNum(c.loopEnd, 3) : undefined,
        Num: isHot ? Math.max(0, Number(c.index) || 0) : -1,
      };
      const rgb = isHot ? fromHex(c.color) : null;
      if (rgb) Object.assign(m, { Red: rgb[0], Green: rgb[1], Blue: rgb[2] });
      children.push(`      <POSITION_MARK${attrs(m)}/>`);
    }
    if (children.length) {
      out.push(`    <TRACK${attrs(a)}>`);
      out.push(...children);
      out.push('    </TRACK>');
    } else {
      out.push(`    <TRACK${attrs(a)}/>`);
    }
  });
  out.push('  </COLLECTION>');

  // Build a folder tree from optional playlist.path.
  const rootNode = { folders: new Map(), lists: [] };
  for (const p of playlists) {
    let node = rootNode;
    for (const f of p.path || []) {
      if (!node.folders.has(f)) node.folders.set(f, { folders: new Map(), lists: [] });
      node = node.folders.get(f);
    }
    node.lists.push(p);
  }
  const emit = (node, name, indent) => {
    const pad = '  '.repeat(indent);
    const count = node.folders.size + node.lists.length;
    out.push(`${pad}<NODE${attrs({ Type: 0, Name: name, Count: count })}>`);
    for (const [fname, child] of node.folders) emit(child, fname, indent + 1);
    for (const p of node.lists) {
      const keys = (p.trackIds || []).map((id) => idMap.get(String(id))).filter((k) => k != null);
      const ppad = '  '.repeat(indent + 1);
      out.push(`${ppad}<NODE${attrs({ Name: p.name || '', Type: 1, KeyType: 0, Entries: keys.length })}>`);
      for (const k of keys) out.push(`${ppad}  <TRACK Key="${k}"/>`);
      out.push(`${ppad}</NODE>`);
    }
    out.push(`${pad}</NODE>`);
  };
  out.push('  <PLAYLISTS>');
  emit(rootNode, 'ROOT', 2);
  out.push('  </PLAYLISTS>');
  out.push('</DJ_PLAYLISTS>');
  return out.join('\n') + '\n';
}
