// Library extras: filter chips (key match, BPM ±6 %, genre), "Suggested next" strip, row size toggle and
// collapse. Mounted next to the library toolbar from app.js, so library-ui.js only needs small hooks
// (search tokens bpm:near / key:compat and setRowMode()).
//
// Mount points (stable classes): .lib-chips (after .lib-tools; holds the .lib-suggest strip), .lib-collapse-btn.
import { el } from '../util.js';
import { api } from '../api.js';
import { icon } from './icons.js';
import { toCamelot } from '../audio/analysis-core.js';
import { refFromDeck, suggestNext } from './suggest.js';

export function setupLibraryExtras(app) {
  const L = app.library;
  const tools = L.root.querySelector('.lib-tools');
  if (!tools) return null;

  // ---------- filter chips: they edit tokens in the search field, so search syntax and chips stay in sync ----------
  const hasTok = (tok) => new RegExp(`(^|\\s)${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`).test(L.search.value);
  const setTok = (re, tok) => {
    let v = L.search.value.replace(re, ' ').replace(/\s+/g, ' ').trim();
    if (tok) v = `${v} ${tok}`.trim();
    L.search.value = v;
    L.search.dispatchEvent(new Event('input', { bubbles: true }));
    renderChips();
  };
  const chip = (label, iconName, tok, title) => {
    const b = el('button', { class: 'chip', title, 'aria-pressed': 'false', onclick: () => setTok(new RegExp(`(^|\\s)${tok}(?=\\s|$)`, 'g'), hasTok(tok) ? '' : tok) }, icon(iconName), el('span', {}, label));
    b.tok = tok; return b;
  };
  const keyChip = chip('Key match', 'target', 'key:compat', 'Only tracks in a key that mixes harmonically with the master deck');
  const bpmChip = chip('BPM ±6 %', 'activity', 'bpm:near', 'Only tracks within 6 % of the master deck tempo (or half / double time)');
  const genreSel = el('select', { class: 'chip chip-sel', title: 'Filter by genre', 'aria-label': 'Genre' });
  genreSel.addEventListener('change', () => setTok(/(^|\s)genre:\S+/g, genreSel.value ? `genre:${genreSel.value}` : ''));
  const fillGenres = () => {
    const genres = [...new Set([...L.tracks.values()].map((t) => (t.genre || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const key = genres.join('|');
    if (genreSel._key === key) return;
    genreSel._key = key;
    genreSel.replaceChildren(el('option', { value: '' }, 'All genres'), ...genres.map((g) => el('option', { value: g.toLowerCase().replace(/\s+/g, '') }, g)));
  };
  const clearBtn = el('button', { class: 'chip chip-clear', title: 'Clear search and filters', onclick: () => { L.search.value = ''; L.search.dispatchEvent(new Event('input', { bubbles: true })); renderChips(); } }, icon('x'), el('span', {}, 'Clear'));
  const rowsBtn = el('button', { class: 'chip chip-rows', title: 'Larger rows with artwork', 'aria-pressed': 'false', onclick: () => { const m = app.settings.libraryRows === 'art' ? 'compact' : 'art'; app.setSetting('libraryRows', m); L.setRowMode(m); renderChips(); } }, icon('library'), el('span', {}, 'Artwork'));
  const suggestBtn = el('button', { class: 'chip chip-suggest', title: 'Show suggestions that mix well with the playing track', 'aria-pressed': 'true', onclick: () => { strip.hidden = !strip.hidden; spacer.hidden = !strip.hidden; try { localStorage.setItem('opendj.suggest', strip.hidden ? '0' : '1'); } catch {} renderChips(); refresh(true); } }, icon('sparkles'), el('span', {}, 'Suggestions'));
  const chips = el('div', { class: 'lib-chips' }, keyChip, bpmChip, genreSel, clearBtn);
  function renderChips() {
    for (const c of [keyChip, bpmChip]) { const on = hasTok(c.tok); c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on)); }
    const g = /(?:^|\s)genre:(\S+)/.exec(L.search.value)?.[1] || '';
    if ([...genreSel.options].some((o) => o.value === g)) genreSel.value = g;
    genreSel.classList.toggle('on', !!g);
    clearBtn.hidden = !L.search.value.trim();
    rowsBtn.classList.toggle('on', app.settings.libraryRows === 'art'); rowsBtn.setAttribute('aria-pressed', String(app.settings.libraryRows === 'art'));
    suggestBtn.classList.toggle('on', !strip.hidden); suggestBtn.setAttribute('aria-pressed', String(!strip.hidden));
  }
  L.search.addEventListener('input', () => renderChips());

  // ---------- suggested next ----------
  const stripTitle = el('span', { class: 'sg-title' });
  const cards = el('div', { class: 'sg-cards' });
  const strip = el('div', { class: 'lib-suggest', role: 'region', 'aria-label': 'Suggested next tracks' }, stripTitle, cards);
  const spacer = el('span', { class: 'chip-spacer' });
  chips.append(strip, spacer, suggestBtn, rowsBtn);
  try { strip.hidden = localStorage.getItem('opendj.suggest') === '0'; } catch {}
  spacer.hidden = !strip.hidden;
  const target = () => {
    const decks = app.engine.decks.slice(0, app.deckCount);
    const ref = app.engine.masterDeck() || decks.find((d) => d.playing && d.track) || decks.find((d) => d.track);
    return { ref, free: decks.find((d) => d !== ref && !d.playing) };
  };
  let sig = '';
  function refresh(force) {
    if (strip.hidden) return;
    const { ref } = target();
    const r = refFromDeck(ref);
    const s = `${r?.id}|${Math.round(r?.bpm || 0)}|${r?.cam}|${L.tracks.size}|${L.rev || 0}|${app.engine.decks.map((d) => d.track?.id).join(',')}`;
    if (!force && s === sig) return;
    sig = s;
    if (!r) {
      stripTitle.replaceChildren(icon('sparkles'), el('span', {}, 'Next'));
      cards.replaceChildren(el('div', { class: 'sg-empty' }, 'Load a track to see what mixes well with it.'));
      return;
    }
    const loaded = new Set(app.engine.decks.map((d) => d.track?.id).filter(Boolean));
    const list = suggestNext(r, L.tracks.values(), { limit: 12, exclude: loaded });
    stripTitle.replaceChildren(icon('sparkles'), el('span', {}, 'Next'));
    stripTitle.title = `Mixes well with ${ref.track.title || 'this track'} (deck ${ref.index + 1})`;
    if (!list.length) { cards.replaceChildren(el('div', { class: 'sg-empty' }, 'No close matches yet — analyse more tracks or widen your library.')); return; }
    cards.replaceChildren(...list.map(({ track: t, keyMatch, bpmDelta, reason }) => {
      const cam = toCamelot(t.key);
      const c = el('button', { class: 'sg-card', draggable: 'true', title: `${t.artist ? t.artist + ' – ' : ''}${t.title}${reason ? `\n${reason}` : ''}\nClick: load onto the free deck · drag onto a deck` },
        el('span', { class: 'sg-art', style: { backgroundImage: `url(${api.coverUrl(t.id)})` } }),
        el('span', { class: 'sg-text' }, el('span', { class: 'sg-t' }, t.title || 'Untitled'), el('span', { class: 'sg-a' }, t.artist || '')),
        el('span', { class: 'sg-meta' },
          el('span', { class: `sg-key ${cam ? `cam-${cam.replace(/\D/g, '')}` : ''} ${keyMatch ? 'match' : ''}` }, cam || '—'),
          el('span', { class: 'sg-bpm' }, t.bpm ? `${Math.round(t.bpm)}${bpmDelta != null && Math.abs(bpmDelta) >= 0.5 ? ` ${bpmDelta > 0 ? '+' : '−'}${Math.abs(bpmDelta).toFixed(0)}%` : ''}` : '')));
      c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-opendj-track', t.id); e.dataTransfer.effectAllowed = 'copy'; });
      c.addEventListener('click', () => {
        const { free } = target();
        if (!free) return app.toast('Both decks are playing: drag the suggestion onto a deck to replace its track');
        app.loadTrack(free.index, t.id).catch(() => {});
      });
      return c;
    }));
  }
  app.engine.on('master-deck', () => refresh());
  for (const d of app.engine.decks) { d.on('loaded', () => refresh()); d.on('state', () => refresh()); }
  setInterval(() => { if (!document.hidden && !document.documentElement.classList.contains('lib-collapsed')) { fillGenres(); refresh(); } }, 2500); // tempo changes, analysis results, library edits (skipped when hidden/collapsed)

  // ---------- collapse / expand ----------
  const collapseBtn = el('button', { class: 'btn sm icon-only lib-collapse-btn', title: 'Collapse the library (more room for the decks)', 'aria-label': 'Collapse library', 'aria-expanded': 'true' }, icon('chevron-down'));
  collapseBtn.addEventListener('click', () => {
    const root = document.documentElement, on = !root.classList.contains('lib-collapsed');
    root.classList.add('lib-anim');
    root.classList.toggle('lib-collapsed', on);
    collapseBtn.replaceChildren(icon(on ? 'chevron-up' : 'chevron-down'));
    collapseBtn.title = on ? 'Expand the library' : 'Collapse the library (more room for the decks)';
    collapseBtn.setAttribute('aria-expanded', String(!on));
    setTimeout(() => root.classList.remove('lib-anim'), 220);
  });
  tools.append(collapseBtn);

  tools.after(chips);
  if (app.settings.libraryRows === 'art') L.setRowMode('art');
  fillGenres(); renderChips(); refresh(true);
  return { refresh, chips, strip };
}
