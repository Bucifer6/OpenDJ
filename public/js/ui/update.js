// "A new version is available" prompt: checks at startup (after a short delay) and every 12 hours, shows a dialog with
// the release notes newer than this version, and runs "Update now" the way the platform allows (shared/update-core.js
// chooseUpdateAction; the desktop app's download / install happens in the Electron main process).
// Never interrupts a live set: while a deck plays, a recording / broadcast runs or automix is on, only a small
// "Update" badge appears in the top bar; the prompt follows once everything has been stopped for a few seconds.
import { el } from '../util.js';
import { icon } from './icons.js';
import { APP_VERSION, platform } from '../platform.js';
import { UPDATE_CONFIG } from '../update-config.js';
import { promptState, snoozeFor, skipFor, renderMarkdown, chooseUpdateAction, CHECK_INTERVAL_MS } from '../shared/update-core.js';

// e2e tests only: Playwright browsers (navigator.webdriver) never check on their own unless a test sets this
const TEST = globalThis.__opendjUpdateTest || null;
const START_DELAY_MS = TEST?.delayMs ?? 8000;
const IDLE_MS = TEST?.idleMs ?? 8000;

/** Open a web page outside the app (Electron: the browser via the main process; phones: the system). */
export function openExternal(url) {
  if (!/^https?:\/\//i.test(String(url))) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

const mb = (n) => (n ? `${Math.max(1, Math.round(n / 1048576))} MB` : '');
const dateText = (iso) => { try { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; } catch { return ''; } };

function codeBlock(text) {
  const copy = el('button', { class: 'btn xs upd-copy', title: 'Copy', 'aria-label': `Copy: ${text}`, onclick: async () => {
    try { await navigator.clipboard.writeText(text); copy.replaceChildren(icon('check')); setTimeout(() => copy.replaceChildren(icon('copy')), 1500); } catch { /* clipboard not allowed */ }
  } }, icon('copy'));
  return el('div', { class: 'upd-code' }, el('code', {}, text), copy);
}

export function setupUpdates(app) {
  const state = { result: null, pending: false, open: false, busySince: 0, idleTimer: null };
  const badge = el('button', { class: 'btn sm update-badge', hidden: true, title: 'A new version of OpenDJ is available', 'aria-label': 'Update available', onclick: () => openPrompt() },
    icon('download'), el('span', { class: 'lbl' }, 'Update'));
  const settingsBtn = document.querySelector('.topbar .btn[aria-label="Settings"]');
  settingsBtn?.before(badge);

  const isLive = () => {
    const e = app.engine;
    return !!(e?.decks?.some((d) => d.playing) || e?.recording || app.recording?.recording || app.recording?.broadcaster?.live || app.automix?.enabled);
  };

  async function fetchCheck(force) {
    try {
      const r = await fetch(`/api/update/check${force ? '?force=1' : ''}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      return r.ok ? await r.json() : null; // signed out (hosted mode) or no such endpoint: stay quiet
    } catch { return null; }
  }

  /** Check now. manual: Settings → Check now (forced, shows the prompt even when snoozed). */
  async function check({ manual = false } = {}) {
    const r = await fetchCheck(manual);
    if (!r) return manual ? { ok: false, error: 'offline' } : null;
    state.result = r;
    if (!r.available || !r.latest) { badge.hidden = true; state.pending = false; return r; }
    if (manual) { openPrompt(); return r; }
    const st = promptState({ latest: r.latest.version, current: r.current || APP_VERSION, snooze: app.settings.updateSnooze });
    badge.hidden = st === 'skipped';
    if (st === 'prompt') { state.pending = true; watchIdle(); }
    return r;
  }

  // the prompt waits for a quiet moment: nothing playing / recording / broadcasting / automixing, no other dialog open
  function watchIdle() {
    if (state.idleTimer) return;
    const tick = () => {
      if (!state.pending || state.open) { clearInterval(state.idleTimer); state.idleTimer = null; return; }
      const live = isLive();
      if (live) badge.hidden = false;
      if (live || document.querySelector('.overlay')) { state.busySince = Date.now(); return; }
      if (state.busySince && Date.now() - state.busySince < IDLE_MS) return;
      openPrompt();
    };
    state.idleTimer = setInterval(tick, 1000);
    tick();
  }

  function howText(action, info, release) {
    const asset = info?.asset;
    switch (action.type) {
      case 'instructions': return action.kind === 'hosted' ? 'This OpenDJ runs on a server: Update now shows how to update it.' : 'This OpenDJ runs from source: Update now shows how to update it.';
      case 'open':
        return { apk: 'Downloads the new Android app; open it when the download finishes and Android offers to install it.', play: 'Opens OpenDJ on Google Play.', appstore: 'Opens OpenDJ on the App Store.', testflight: 'Opens the new build in TestFlight.' }[action.kind]
          || 'Opens the release page, where you can download the new version.';
      case 'electron':
        if (!info) return '';
        if (!asset && info.action !== 'open') return 'Opens the release page, where you can download the new version.';
        if (info.kind === 'nsis') return `Downloads the installer${asset ? ` (${mb(asset.size)})` : ''}, checks it against the release’s SHA-256 checksums, then restarts OpenDJ into the installer.`;
        if (info.kind === 'appimage') return `Downloads the new AppImage${asset ? ` (${mb(asset.size)})` : ''}, checks it, replaces this one and restarts OpenDJ.`;
        if (info.kind === 'portable') return `Downloads the new portable version${asset ? ` (${mb(asset.size)})` : ''} and checks it.`;
        if (info.kind === 'dmg') return `Downloads the disk image for your Mac (${info.arch === 'arm64' ? 'Apple silicon' : 'Intel'}${asset ? `, ${mb(asset.size)}` : ''}), checks it and opens it. Then drag OpenDJ to Applications to replace the old version.`;
        if (info.kind === 'source') return 'Running from source: opens the release page.';
        if (info.kind === 'targz') return 'Opens the .tar.gz download in your browser; then unpack it in place of this folder.';
        return `Opens the .${info.kind === 'rpm' ? 'rpm' : 'deb'} download in your browser; then install it with your package manager (the command is shown).`;
      default: return '';
    }
  }

  async function openPrompt() {
    const r = state.result, info = r?.latest;
    if (!info || state.open) return;
    state.open = true; state.pending = false;
    const current = r.current || APP_VERSION;
    const native = window.opendjNative?.update;
    const action = chooseUpdateAction(info, { electron: !!native, local: platform.local, native: platform.native, os: platform.os, hosted: !!r.hosted }, UPDATE_CONFIG);
    const uid = Math.random().toString(36).slice(2, 8);

    // ---- body ----
    const notes = el('div', { class: 'upd-notes', id: `upd-notes-${uid}`, hidden: true, tabindex: -1 },
      ...(info.notes.length ? info.notes.map((s) => el('section', { class: 'upd-section' }, el('h3', {}, s.title), renderMarkdown(s.markdown, document, { headingBase: 1 })))
        : [el('p', { class: 'hint' }, 'Bug fixes and improvements.')]),
      el('a', { class: 'upd-full', href: info.url, target: '_blank', rel: 'noopener noreferrer' }, 'Full release notes on GitHub'));
    notes.addEventListener('click', (e) => { const a = e.target.closest('a[href]'); if (a) { e.preventDefault(); openExternal(a.href); } });
    const chev = icon('chevron-right', { cls: 'upd-chev' });
    const toggle = el('button', { class: 'upd-toggle', 'aria-expanded': 'false', 'aria-controls': notes.id, onclick: () => {
      const open = notes.hidden;
      notes.hidden = !open; toggle.setAttribute('aria-expanded', String(open)); toggle.classList.toggle('open', open);
    } }, chev, 'What’s new');
    const summary = info.summary?.length ? info.summary : null;
    const bar = el('div', { class: 'upd-bar', role: 'progressbar', 'aria-label': 'Download progress', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, el('span'));
    const statusText = el('div', { class: 'upd-status-text' });
    const status = el('div', { class: 'upd-status', role: 'status', 'aria-live': 'polite', hidden: true }, bar, statusText);
    const how = el('p', { class: 'hint upd-how' });
    const extra = el('div', { class: 'upd-extra' });
    const released = dateText(info.publishedAt);
    const body = el('div', { class: 'upd-body' },
      el('div', { class: 'upd-hero' }, el('div', { class: 'upd-icon' }, icon('download')),
        el('div', { class: 'upd-hero-text' }, el('div', { class: 'upd-sub' }, `You have ${current}`), released ? el('div', { class: 'upd-date' }, `Released ${released}`) : null)),
      el('p', { class: 'upd-summary' }, summary ? `New: ${summary.join(' · ')}.` : `OpenDJ ${info.version} brings fixes and improvements.`),
      toggle, notes, status, extra, how);

    let close = () => {}, box = null;
    const setStatus = (text, { warn = false, progress = null } = {}) => {
      status.hidden = false;
      status.classList.toggle('warn', warn);
      bar.hidden = progress == null;
      if (progress != null) { const pct = Math.round(progress * 100); bar.firstChild.style.width = `${pct}%`; bar.setAttribute('aria-valuenow', String(pct)); }
      statusText.textContent = text;
    };
    const nowBtn = () => box?.querySelector('.upd-now');
    const setNow = (label, disabled = false) => { const b = nowBtn(); if (b) { b.textContent = label; b.disabled = disabled; } };
    let phase = 'start', electronInfo = null, downloading = false;

    if (action.type === 'electron') native.info().then((x) => { electronInfo = x; how.textContent = howText(action, x); if (x?.ready) { phase = 'ready'; setNow('Restart to update'); } }).catch(() => {});
    else how.textContent = howText(action);

    const showInstructions = () => {
      const hosted = action.kind === 'hosted';
      extra.replaceChildren(el('div', { class: 'upd-instructions' },
        el('p', {}, hosted ? 'OpenDJ runs on your server, so the update is installed there. On the server, in the folder with docker-compose.yml:' : 'This copy runs from source (npm run web). In the OpenDJ folder:'),
        ...(hosted ? [
          el('div', { class: 'upd-label' }, 'Docker image you pulled'), codeBlock('docker compose pull && docker compose up -d'),
          el('div', { class: 'upd-label' }, 'Docker image built from source (the default)'), codeBlock('git pull && docker compose up -d --build'),
          el('div', { class: 'upd-label' }, 'Without Docker'), codeBlock('git pull && npm ci'), el('p', { class: 'hint' }, 'then restart the OpenDJ service.'),
        ] : [codeBlock('git pull && npm ci'), el('p', { class: 'hint' }, 'then start it again with npm run web. Or install the desktop app from the release page.')]),
        el('a', { class: 'upd-full', href: action.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => { e.preventDefault(); openExternal(action.url); } }, 'Release page and downloads')));
      how.textContent = 'Your library, settings and recordings stay as they are.';
      phase = 'done'; setNow('Done');
    };

    async function electronUpdate() {
      if (phase === 'ready') {
        if (isLive()) { setStatus('Stop the decks, recording, broadcast and automix first: restarting would cut the music.', { warn: true }); return; }
        setNow('Restarting…', true);
        const res = await native.install().catch((e) => ({ ok: false, error: e.message }));
        if (!res?.ok) { setStatus(`Could not start the update: ${res?.error || 'unknown error'}`, { warn: true }); setNow('Try again'); phase = 'start'; }
        else setStatus('Restarting OpenDJ to finish the update…');
        return;
      }
      downloading = true;
      setNow('Downloading…', true);
      setStatus('Starting the download…', { progress: 0 });
      const off = native.onProgress?.((p) => { if (p.total) setStatus(`Downloading… ${mb(p.received)} of ${mb(p.total)}`, { progress: p.received / p.total }); });
      const res = await native.download().catch((e) => ({ ok: false, error: e.message }));
      off?.(); downloading = false;
      if (!res?.ok) { setStatus(res?.error || 'The download failed.', { warn: true }); setNow('Try again'); return; }
      if (res.action === 'ready') { phase = 'ready'; setStatus('Downloaded and verified (SHA-256 matches the release).', { progress: 1 }); setNow('Restart to update'); how.textContent = 'OpenDJ closes, installs the new version and opens again. Your library and settings stay as they are.'; return; }
      phase = 'done'; setNow('Done');
      if (res.action === 'opened-dmg') { setStatus('Downloaded and verified. The disk image is open: drag OpenDJ to Applications to replace the old version, then quit and reopen OpenDJ.', { progress: 1 }); how.textContent = ''; return; }
      if (res.action === 'revealed') { setStatus(`Downloaded and verified: ${res.name}. It is shown in its folder: start the new version from there.`, { progress: 1 }); how.textContent = ''; return; }
      // opened in the browser (deb / rpm / tar.gz / source)
      setStatus(res.name ? `Download started in your browser: ${res.name}.` : 'The release page is open in your browser.');
      extra.replaceChildren(...(res.hint ? [el('p', {}, res.hint.text), codeBlock(res.hint.command)] : []));
      how.textContent = '';
    }

    async function updateNow() {
      if (phase === 'done') return 'done';
      if (action.type === 'instructions') { showInstructions(); return false; }
      if (action.type === 'open') {
        openExternal(action.url);
        const msg = { apk: 'Download started: open the file when it finishes to install the update. If Android asks, allow installing apps from your browser.', play: 'Opening Google Play…', appstore: 'Opening the App Store…', testflight: 'Opening TestFlight…' }[action.kind]
          || 'The release page is open: download the version for your system there.';
        setStatus(msg); how.textContent = ''; phase = 'done'; setNow('Done');
        return false;
      }
      await electronUpdate();
      return false;
    }

    const skip = el('button', { class: 'upd-skip', type: 'button', onclick: () => close('skip') }, 'Skip this version');
    const result = await app.dialogs.modal(`OpenDJ ${info.version} is available`, body, [
      { label: 'Later', value: 'later', cls: 'upd-later', action: () => { if (downloading) native?.cancel?.(); return 'later'; } },
      { label: 'Update now', primary: true, cls: 'upd-now', action: updateNow },
    ], { cls: 'update-modal', footStart: skip, onOpen: (o) => { close = o.close; box = o.box; } });
    state.open = false;
    if (downloading) native?.cancel?.();
    // Esc / ✕ / clicking outside / Later: snooze for 3 days (or until a newer version); the badge stays as a reminder
    if (result === 'skip') { badge.hidden = true; await app.setSetting('updateSnooze', skipFor(info.version)); }
    else { badge.hidden = false; await app.setSetting('updateSnooze', snoozeFor(info.version)); }
  }

  // ---- schedule ----
  let timer = null, interval = null;
  const automatic = () => !(navigator.webdriver && !TEST);
  function setAuto(on) {
    clearTimeout(timer); clearInterval(interval); timer = interval = null;
    if (!on || !automatic()) return;
    timer = setTimeout(() => check(), START_DELAY_MS);
    interval = setInterval(() => check(), CHECK_INTERVAL_MS);
  }
  setAuto(app.settings.updateCheck !== false);

  return { check, openPrompt, setAuto, badge, get result() { return state.result; }, isLive };
}
