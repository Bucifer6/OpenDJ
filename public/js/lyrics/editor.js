// Lyrics editor dialog: paste / type lyrics, tap-to-sync lines while the deck plays, nudge the offset,
// import / export .lrc, look the track up on LRCLIB, save (optionally writing Song.lrc next to the audio file).
// Keys while the dialog is open (outside the text box): Space / Enter = tap the current line, Backspace = undo the
// last tap, ↑ / ↓ = move the cursor, P = play / pause the deck, ← / → = seek ∓5 s.
import { el } from '../util.js';
import { parseLrc, buildLrc, formatTime, plainToLines, lyricStateAt } from './lrc.js';

/** Editor model helpers (pure, exported for tests). */
export function linesFromLyrics(l) {
  if (l?.synced?.length) return l.synced.map((x) => ({ t: x.t, text: x.text, ...(x.words ? { words: x.words } : {}) }));
  return plainToLines(l?.plain || '');
}
export function tapLine(lines, i, t) {
  const out = lines.map((l) => ({ ...l }));
  const l = out[i];
  if (!l) return out;
  if (l.words && l.t != null) { const d = t - l.t; l.words = l.words.map((w) => ({ ...w, t: Math.max(0, Math.round((w.t + d) * 1000) / 1000) })); }
  else if (l.words) delete l.words;
  l.t = Math.max(0, Math.round(t * 1000) / 1000);
  return out;
}
export function linesToLyrics(lines) {
  const timed = lines.filter((l) => l.t != null).sort((a, b) => a.t - b.t);
  if (timed.length) return { synced: timed.map((l) => ({ t: l.t, text: l.text, ...(l.words ? { words: l.words } : {}) })), plain: lines.map((l) => l.text).join('\n') };
  return { synced: [], plain: lines.map((l) => l.text).join('\n').trim() };
}

export function openLyricsEditor(app, deck, mgr) {
  const track = deck.track;
  if (!track) { app.toast?.('Load a track first'); return null; }
  let lines = linesFromLyrics(mgr.get(track.id));
  let cursor = Math.max(0, lines.findIndex((l) => l.t == null));
  if (cursor < 0 || cursor >= lines.length) cursor = 0;
  const history = [];
  let textMode = !lines.length;

  const list = el('div', { class: 'lyr-ed-list', tabindex: 0, 'aria-label': 'Lyrics lines' });
  const textarea = el('textarea', { class: 'inp lyr-ed-text', rows: 14, spellcheck: false, placeholder: 'Paste lyrics (plain text or .lrc) here, then press "Use text" and tap along while the track plays.' });
  const timeEl = el('span', { class: 'lyr-ed-time' }, '00:00.00');
  const status = el('span', { class: 'hint' });
  const fileIn = el('input', { type: 'file', accept: '.lrc,.txt,text/plain', hidden: true });
  const writeLrc = el('input', { type: 'checkbox' });
  const online = el('input', { type: 'checkbox' });
  mgr.settings().then((s) => { writeLrc.checked = !!s.writeLrc; online.checked = !!s.online; }).catch(() => {});
  online.addEventListener('change', () => mgr.saveSettings({ online: online.checked }).catch((e) => app.toast?.(e.message)));

  const heard = () => mgr.heardTime(deck);
  const render = () => {
    list.replaceChildren(...lines.map((l, i) => el('div', { class: `lyr-ed-row ${i === cursor ? 'cursor' : ''} ${l.t == null ? 'untimed' : ''}`, 'data-i': i },
      el('button', { class: 'btn xs lyr-ed-t', title: l.t == null ? 'Not synced yet' : 'Jump the deck here', onclick: () => { if (l.t != null) deck.seek(Math.max(0, l.t - 1)); } }, l.t == null ? '--:--.--' : formatTime(l.t)),
      el('span', { class: 'lyr-ed-line', onclick: () => { cursor = i; render(); } }, l.text || '♪'))));
    list.querySelector('.cursor')?.scrollIntoView?.({ block: 'nearest' });
    const synced = lines.filter((l) => l.t != null).length;
    status.textContent = `${synced}/${lines.length} lines synced`;
    textarea.hidden = !textMode; list.hidden = textMode;
    useTextBtn.hidden = !textMode; editTextBtn.hidden = textMode;
  };
  const tap = () => {
    if (!lines.length) return;
    history.push({ lines, cursor });
    lines = tapLine(lines, cursor, heard());
    cursor = Math.min(lines.length - 1, cursor + 1);
    render();
  };
  const undo = () => { const h = history.pop(); if (h) { ({ lines, cursor } = h); render(); } };
  const shift = (dt) => { history.push({ lines, cursor }); lines = lines.map((l) => (l.t == null ? l : tapLine([l], 0, l.t + dt)[0])); render(); };
  const useText = () => {
    const p = parseLrc(textarea.value);
    lines = p.synced.length ? linesFromLyrics(p) : plainToLines(textarea.value);
    cursor = Math.max(0, lines.findIndex((l) => l.t == null)); if (cursor < 0) cursor = 0;
    textMode = false; render();
  };
  const editText = () => { textarea.value = lines.some((l) => l.t != null) ? buildLrc(linesToLyrics(lines), { ti: track.title, ar: track.artist }) : lines.map((l) => l.text).join('\n'); textMode = true; render(); textarea.focus(); };
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0]; fileIn.value = '';
    if (!f) return;
    textarea.value = await f.text();
    useText();
  });
  const exportLrc = () => {
    const blob = new Blob([buildLrc(linesToLyrics(lines), { ti: track.title, ar: track.artist, al: track.album })], { type: 'text/plain' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${[track.artist, track.title].filter(Boolean).join(' - ') || 'lyrics'}.lrc` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  };
  const findOnline = async () => {
    status.textContent = 'Searching LRCLIB…';
    try {
      const l = await mgr.fetch(track.id, { online: true, refresh: true });
      if (!l.synced.length && !l.plain) { status.textContent = 'Nothing found online'; return; }
      history.push({ lines, cursor });
      lines = linesFromLyrics(l); cursor = 0; textMode = false; render();
      status.textContent = `Loaded from ${l.source || 'online'}: check and save`;
    } catch (e) { status.textContent = e.message; }
  };

  const playBtn = el('button', { class: 'btn sm', onclick: () => { app.engine?.resume?.(); deck.togglePlay(); } }, '▶❚❚');
  const useTextBtn = el('button', { class: 'btn sm primary', onclick: useText }, 'Use text');
  const editTextBtn = el('button', { class: 'btn sm', onclick: editText }, 'Edit text');
  const tools = el('div', { class: 'lyr-ed-tools' },
    playBtn,
    el('button', { class: 'btn sm', title: 'Back 5 s', onclick: () => deck.seek(Math.max(0, deck.position - 5)) }, '⏪ 5s'),
    timeEl,
    el('button', { class: 'btn sm primary lyr-ed-tap', title: 'Space / Enter: set the cursor line to what is playing now', onclick: tap }, 'TAP'),
    el('button', { class: 'btn sm', title: 'Backspace: undo', onclick: undo }, 'Undo'),
    el('button', { class: 'btn sm', title: 'All lines 100 ms earlier', onclick: () => shift(-0.1) }, '−0.1 s'),
    el('button', { class: 'btn sm', title: 'All lines 100 ms later', onclick: () => shift(0.1) }, '+0.1 s'),
    el('span', { class: 'tb-spacer' }),
    useTextBtn, editTextBtn,
    el('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'Import .lrc'),
    el('button', { class: 'btn sm', onclick: exportLrc }, 'Export .lrc'),
    el('button', { class: 'btn sm', title: 'Look this track up on lrclib.net (sends artist, title, album and duration)', onclick: findOnline }, 'Find online'));
  const body = el('div', { class: 'lyr-ed' }, tools, list, textarea, fileIn,
    el('div', { class: 'lyr-ed-foot' }, status,
      el('label', { class: 'lyr-ed-chk', title: 'Writes Song.lrc next to the audio file (local files only)' }, writeLrc, 'Also write .lrc file'),
      el('label', { class: 'lyr-ed-chk', title: 'Automatically look up missing lyrics on lrclib.net' }, online, 'Online lookups (LRCLIB)')),
    el('p', { class: 'hint' }, 'Tap: Space / Enter · Undo: Backspace · Cursor: ↑ ↓ · Play: P · Seek: ← →'));

  const onKey = (e) => {
    if (!body.isConnected) return;
    if (e.target === textarea || /INPUT|SELECT/.test(e.target.tagName)) return;
    if (e.key === ' ' || e.key === 'Enter') { if (e.target.tagName === 'BUTTON' && e.key === 'Enter') return; e.preventDefault(); tap(); }
    else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); cursor = Math.min(lines.length - 1, cursor + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); cursor = Math.max(0, cursor - 1); render(); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); deck.togglePlay(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); deck.seek(Math.max(0, deck.position + (e.key === 'ArrowLeft' ? -5 : 5))); }
  };
  document.addEventListener('keydown', onKey);
  let raf = 0;
  const live = () => {
    raf = requestAnimationFrame(live);
    const t = heard();
    timeEl.textContent = formatTime(t);
    playBtn.classList.toggle('active', deck.playing);
    const st = lyricStateAt(linesToLyrics(lines), t);
    const idx = st.line ? lines.indexOf(lines.find((l) => l.t === st.line.t && l.text === st.line.text)) : -1;
    for (const r of list.children) r.classList.toggle('now', Number(r.dataset.i) === idx);
  };
  render(); live();
  if (textMode) setTimeout(() => textarea.focus(), 40);

  const title = `Lyrics — ${[track.artist, track.title].filter(Boolean).join(' – ') || 'Untitled'}`;
  const done = app.dialogs.modal(title, body, [
    { label: 'Remove my edits', action: async () => { await mgr.remove(track.id); app.toast?.('Lyrics edits removed'); return true; } },
    { label: 'Cancel', value: null },
    {
      label: 'Save', primary: true, action: async () => {
        if (textMode && textarea.value.trim()) useText();
        const l = linesToLyrics(lines);
        if (!l.synced.length && !l.plain) { app.toast?.('Nothing to save'); return false; }
        try { const r = await mgr.save(track.id, { ...l, writeLrc: writeLrc.checked }); app.toast?.(r.wroteLrc ? `Lyrics saved (and ${r.wroteLrc.split(/[\\/]/).pop()})` : 'Lyrics saved'); return true; }
        catch (e) { app.toast?.(e.message); return false; }
      },
    },
  ], { wide: true });
  done.finally(() => { cancelAnimationFrame(raf); document.removeEventListener('keydown', onKey); });
  return done;
}
