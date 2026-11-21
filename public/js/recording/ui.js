// Recording & broadcasting UI: topbar additions (size readout, settings ▾, LIVE button) and the
// "Record & stream" panel with Record / Recordings / Broadcast tabs.
import { el } from '../util.js';
import { icon } from '../ui/icons.js';
import { MixRecorder } from './recorder.js';
import { Broadcaster } from './broadcaster.js';
import { recApi, castApi } from './http.js';
import { hms, liveDetail } from './status.js';
import { platform, unavailable } from '../platform.js';

const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`);
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('p', { class: 'hint' }, hint) : null);
const sel = (value, options, onchange) => { const s = el('select', { class: 'sel', onchange: () => onchange(s.value) }, ...options.map(([v, l]) => el('option', { value: v }, l))); s.value = String(value ?? ''); return s; };
const inp = (value, onchange, attrs = {}) => { const i = el('input', { class: 'inp', value: value ?? '', ...attrs }); i.addEventListener('change', () => onchange(attrs.type === 'number' ? Number(i.value) : i.value)); return i; };
const chk = (label, value, onchange) => { const c = el('input', { type: 'checkbox', checked: !!value, onchange: () => onchange(c.checked) }); return el('label', { class: 'rec-check' }, c, el('span', {}, label)); };

const RTMP_PRESETS = [
  ['', 'Custom RTMP server'],
  ['rtmp://live.twitch.tv/app', 'Twitch'],
  ['rtmp://a.rtmp.youtube.com/live2', 'YouTube Live'],
  ['rtmp://rtmp.mixcloud.com/broadcast', 'Mixcloud Live'],
  ['rtmps://live-api-s.facebook.com:443/rtmp', 'Facebook Live'],
];
const STATE_LABEL = { idle: 'Idle', connecting: 'Connecting…', reconnecting: 'Reconnecting…', live: 'ON AIR', error: 'Error', stopped: 'Stopped' };

/** Create the recorder + broadcaster and their UI. Returns the controller app.js wires the REC button to. */
export function setupRecording(app) {
  const engine = app.engine;
  const recorder = new MixRecorder(engine);
  const broadcaster = new Broadcaster(engine);
  const toast = (m) => (app.toast ? app.toast(m) : console.log(m));

  // ---- topbar ----
  const sizeEl = el('span', { class: 'rec-size', title: 'Recording size on disk' });
  const moreBtn = el('button', { class: 'btn sm rec-more', title: 'Recording format, folder, recordings and live streaming', onclick: () => ctl.openPanel('record'), 'aria-label': 'Recording options' }, icon('chevron-down'));
  const liveBtn = el('button', { class: 'btn sm live-btn', title: 'Broadcast live (Icecast, Shoutcast, Twitch / YouTube via RTMP)', onclick: () => ctl.toggleBroadcast() }, icon('live'), el('span', { class: 'lbl' }, 'LIVE'));
  const liveLbl = liveBtn.lastChild;
  const anchor = app.recTime || app.recBtn;
  if (anchor?.parentNode) anchor.after(sizeEl, moreBtn, ...(unavailable('broadcast') ? [] : [liveBtn])); // mobile: no live streaming
  if (app.recBtn) app.recBtn.title = 'Record your mix to disk (WAV / FLAC / MP3 / AAC / Opus). R = start / stop';
  let lastCastError = null;
  const topbarTick = setInterval(() => {
    const outs = broadcaster.status?.outputs || [];
    liveBtn.classList.toggle('active', broadcaster.live);
    liveBtn.classList.toggle('warn', broadcaster.live && outs.some((o) => o.state !== 'live'));
    const listeners = outs.reduce((s, o) => s + (o.listeners || 0), 0);
    // ON AIR only once at least one output really is live; until then say what is happening
    const onAir = outs.some((o) => o.state === 'live');
    const liveTxt = !broadcaster.live ? 'LIVE' : onAir ? `ON AIR${listeners ? ` · ${listeners}` : ''}` : outs.some((o) => o.state === 'reconnecting' || o.state === 'error') ? 'RECONNECTING…' : 'CONNECTING…';
    if (liveLbl.textContent !== liveTxt) liveLbl.textContent = liveTxt;
    if (sizeEl.textContent !== (recorder.recording ? mb(recorder.bytes) : '')) sizeEl.textContent = recorder.recording ? mb(recorder.bytes) : '';
    if (broadcaster.live && !onAir && outs[0]?.error && outs[0].error !== lastCastError) { lastCastError = outs[0].error; toast(`⚠ Broadcast: ${outs[0].error}`); }
    if (onAir) lastCastError = null;
  }, 500);
  recorder.on('state', (on) => { app.recBtn?.classList.toggle('active', on); if (!on && app.recTime) app.recTime.textContent = ''; });
  recorder.on('warning', (m) => toast(`⚠ ${m}`));
  recorder.on('error', (e) => toast(`⚠ Recording stopped: ${e.message}`));
  recorder.on('stopped', (r) => {
    if (!r) return;
    if (r.error && !r.name) toast(`⚠ ${r.error}`);
    else toast(`Saved ${r.parts?.length > 1 ? `${r.parts.length} files` : `"${r.name}"`} (${mb(r.bytes || 0)}${r.tracks?.length ? `, ${r.tracks.length} tracks in the cue sheet` : ''})${r.error ? ` ⚠ ${r.error}` : ''}`);
  });
  broadcaster.on('error', (e) => toast(`⚠ Broadcast stopped: ${e.message}`));
  broadcaster.on('warning', (m) => toast(`⚠ ${m}`));

  const ctl = {
    recorder, broadcaster,
    get recording() { return recorder.recording; },
    async start(opts) {
      try { await recorder.start(opts); toast('Recording started'); } catch (e) {
        toast(`⚠ Could not start recording: ${e.message}`);
        if (e.code === 'needs-ffmpeg') ctl.openPanel('record');
      }
    },
    async stop() { return recorder.stop(); },
    toggle(opts) { return recorder.recording ? ctl.stop() : ctl.start(opts); },
    async toggleBroadcast() {
      if (broadcaster.live) { await broadcaster.stop(); toast('Broadcast stopped'); return; }
      const cfg = await castApi.config().catch(() => null);
      if (!cfg?.config?.targets?.some((t) => t.enabled)) { ctl.openPanel('broadcast'); return; }
      try { await broadcaster.start(); toast('Going live…'); } catch (e) { toast(`⚠ ${e.message}`); ctl.openPanel('broadcast'); }
    },
    openPanel: (tab) => openPanel(app, ctl, tab),
    dispose() { clearInterval(topbarTick); sizeEl.remove(); moreBtn.remove(); liveBtn.remove(); },
  };
  return ctl;
}

// ------------------------------------------------------------------ panel

function openPanel(app, ctl, tab = 'record') {
  const { recorder, broadcaster } = ctl;
  const tabs = unavailable('broadcast') ? { record: 'Record', recordings: 'Recordings' } : { record: 'Record', recordings: 'Recordings', broadcast: 'Broadcast' };
  if (!tabs[tab]) tab = 'record';
  const tabBar = el('div', { class: 'tabs' });
  const pane = el('div', { class: 'tab-pane rec-panel' });
  let timer = null;
  const show = async (k) => {
    clearInterval(timer); timer = null;
    for (const b of tabBar.children) b.classList.toggle('active', b.dataset.k === k);
    fill(pane, el('p', { class: 'hint' }, 'Loading…'));
    try { await builders[k](); } catch (e) { fill(pane, el('p', { class: 'rec-error' }, e.message)); }
  };
  for (const [k, label] of Object.entries(tabs)) tabBar.append(el('button', { class: 'tab', 'data-k': k, onclick: () => show(k) }, label));
  const live = (fn, ms = 500) => { fn(); timer = setInterval(() => { if (!pane.isConnected) { clearInterval(timer); return; } fn(); }, ms); };

  const builders = {
    async record() {
      const info = await recApi.config();
      let cfg = info.config;
      const save = async (patch) => { try { const r = await recApi.saveConfig(patch); cfg = r.config; info.folder = r.folder; folderIn.value = r.folder; renderFmt(); } catch (e) { app.toast?.(`⚠ ${e.message}`); } };
      const fmtSel = sel(cfg.format, info.formats.map((f) => [f.id, f.label + (f.available ? '' : ' — needs FFmpeg')]), (v) => save({ format: v }));
      for (const o of fmtSel.options) o.disabled = !info.formats.find((f) => f.id === o.value)?.available;
      const brWrap = el('div');
      const renderFmt = () => {
        const f = info.formats.find((x) => x.id === cfg.format);
        fill(brWrap, f?.bitrates
          ? field('Bitrate', sel(f.bitrates.includes(Number(cfg.bitrate)) ? cfg.bitrate : f.bitrate, f.bitrates.map((b) => [b, `${b} kbps`]), (v) => save({ bitrate: Number(v) })))
          : field('Bit depth', sel(cfg.bits, [[16, '16-bit'], [24, '24-bit']], (v) => save({ bits: Number(v) }))));
      };
      renderFmt();
      const folderIn = inp(info.folder, (v) => save({ folder: v }));
      const browse = el('button', { class: 'btn', onclick: async () => { const p = await app.dialogs?.pickFolder('Recordings folder'); if (p) save({ folder: p }); } }, 'Browse…');
      const status = el('div', { class: 'rec-status' });
      const tracks = el('ol', { class: 'rec-tracks' });
      const btn = el('button', { class: 'btn primary rec-go', onclick: async () => { btn.disabled = true; try { await ctl.toggle(); } finally { btn.disabled = false; } } });
      const meterL = el('div', { class: 'rec-meter-bar' }), meterR = el('div', { class: 'rec-meter-bar' });
      fill(pane, 
        el('div', { class: 'rec-grid' },
          field('Format', fmtSel, info.local ? 'AAC / Opus where this device can encode them.' : info.ffmpeg ? null : 'FFmpeg was not found: only WAV is available.'),
          brWrap,
          info.local ? null : field('Split into a new file every', el('div', { class: 'row' }, inp(cfg.splitMinutes || '', (v) => save({ splitMinutes: v }), { type: 'number', min: 0, max: 1440, placeholder: 'off', style: { width: '90px' } }), el('span', { class: 'hint' }, 'minutes (empty = one file)'))),
          field('Artist name (cue sheet / tags)', inp(cfg.artist, (v) => save({ artist: v }), { placeholder: 'DJ name' })),
        ),
        info.local ? el('p', { class: 'hint' }, 'Recordings are saved in the app. Share or save them from the Recordings tab (⬇).')
          : field('Save recordings to', el('div', { class: 'row' }, folderIn, browse), info.folder === info.defaultFolder ? null : `Default: ${info.defaultFolder}`),
        el('div', { class: 'row rec-opts' },
          chk('Write a cue sheet + tracklist (.cue / .txt) from the tracks you play', cfg.cue, (v) => save({ cue: v })),
          field('Log a track after it is audible for', el('div', { class: 'row' }, inp(cfg.minTrackSeconds, (v) => save({ minTrackSeconds: v }), { type: 'number', min: 0, max: 120, style: { width: '70px' } }), el('span', { class: 'hint' }, 's')))),
        el('div', { class: 'rec-live' }, btn, status, el('div', { class: 'rec-meter' }, meterL, meterR)),
        el('h4', { class: 'rec-h' }, 'Tracklist'), tracks,
      );
      live(() => {
        const on = recorder.recording;
        btn.textContent = on ? '■ Stop recording' : '● Start recording';
        btn.classList.toggle('danger', on); btn.classList.toggle('primary', !on);
        const s = recorder.server;
        fill(status, on
          ? el('div', {}, el('b', { class: 'rec-dot' }, '● REC '), `${hms(recorder.elapsed)} · ${mb(recorder.bytes)}`, s?.name ? el('div', { class: 'hint' }, s.name) : null,
            recorder.backlog > 4 * 1048576 ? el('div', { class: 'rec-error' }, `Upload backlog ${mb(recorder.backlog)}`) : null, s?.gaps ? el('div', { class: 'rec-error' }, `${s.gaps} lost chunk(s) filled with silence`) : null)
          : el('div', { class: 'hint' }, s?.name ? `Last: ${s.name} (${hms(s.seconds)}, ${mb(s.bytes || 0)})` : 'Not recording'));
        const [l, r] = on ? recorder.peak : [0, 0];
        meterL.style.width = `${Math.min(100, l * 100)}%`; meterR.style.width = `${Math.min(100, r * 100)}%`;
        meterL.classList.toggle('clip', l >= 0.99); meterR.classList.toggle('clip', r >= 0.99);
        const list = recorder.tracker?.logged || [];
        if (tracks.childElementCount !== list.length) fill(tracks, ...list.map((t) => el('li', {}, el('span', { class: 'rec-t' }, hms(t.t)), ` ${t.artist ? t.artist + ' – ' : ''}${t.title}`)));
        if (!list.length && !tracks.childElementCount) fill(tracks, el('li', { class: 'hint' }, on ? 'Tracks appear here once they are audible on the master.' : 'Start a recording to build a tracklist.'));
      });
    },

    async recordings() {
      const r = await recApi.list();
      const audio = el('audio', { controls: true, class: 'rec-audio', preload: 'none' });
      const rows = r.recordings.map((x) => el('div', { class: 'rec-row' },
        el('div', { class: 'rec-row-main' }, el('div', { class: 'rec-name', title: x.path }, x.name),
          el('div', { class: 'hint' }, [x.recording ? '● recording now' : hms(x.duration), mb(x.size), new Date(x.mtime).toLocaleString()].join(' · '),
            x.cue ? el('a', { href: recApi.fileUrl(x.cue, true), class: 'rec-link' }, ' .cue') : null, x.txt ? el('a', { href: recApi.fileUrl(x.txt), target: '_blank', class: 'rec-link' }, ' .txt') : null)),
        el('button', { class: 'btn sm', title: 'Play', disabled: x.recording, onclick: () => { audio.src = recApi.fileUrl(x.name); audio.play().catch(() => {}); } }, '▶'),
        el('a', { class: 'btn sm rec-dl', title: platform.local ? 'Share / save to Files' : 'Download', href: recApi.fileUrl(x.name, true) }, platform.native ? '⇪' : '⬇'),
        window.opendjNative?.reveal ? el('button', { class: 'btn sm', title: 'Show in folder', onclick: () => window.opendjNative.reveal(x.path) }, '📂') : null,
        el('button', { class: 'btn sm danger', title: 'Delete (with its .cue / .txt)', disabled: x.recording, onclick: async () => {
          if (!(await (app.dialogs?.confirm(`Delete "${x.name}"? This cannot be undone.`) ?? confirm(`Delete "${x.name}"?`)))) return;
          try { await recApi.remove(x.name); } catch (e) { app.toast?.(`⚠ ${e.message}`); }
          builders.recordings();
        } }, '🗑')));
      fill(pane, el('p', { class: 'hint' }, `Folder: ${r.folder}`), audio, ...(rows.length ? rows : [el('p', { class: 'hint' }, 'No recordings yet.')]));
    },

    async broadcast() {
      const info = await castApi.config();
      let targets = info.config.targets.map((t) => ({ ...t }));
      const list = el('div', { class: 'bc-targets' });
      const statusBox = el('div', { class: 'bc-status' });
      const goBtn = el('button', { class: 'btn primary', onclick: async () => { goBtn.disabled = true; try { await persist(); await ctl.toggleBroadcast(); } finally { goBtn.disabled = false; } } });
      const persist = async () => {
        const r = await castApi.saveConfig({ targets, updateMetadata: metaChk.querySelector('input').checked });
        targets = r.config.targets.map((t) => ({ ...t })); render();
      };
      const saveBtn = el('button', { class: 'btn', onclick: async () => { try { await persist(); app.toast?.('Stream settings saved'); } catch (e) { app.toast?.(`⚠ ${e.message}`); } } }, 'Save');
      const metaChk = chk('Send "now playing" (artist – title) to the server', info.config.updateMetadata !== false, () => {});
      const add = (type) => { targets.push({ type, enabled: true, name: type === 'rtmp' ? 'RTMP stream' : type === 'shoutcast' ? 'Shoutcast' : 'Icecast', port: 8000, mount: '/live', format: 'mp3', bitrate: 128 }); render(); };
      const render = () => fill(list, ...targets.map((t, i) => targetForm(t, () => { targets.splice(i, 1); render(); }, render, info.formats)),
        targets.length ? null : el('p', { class: 'hint' }, 'Add a stream target: an Icecast or Shoutcast radio server, or an RTMP service (Twitch, YouTube Live, Mixcloud Live) — audio with a still image.'));
      render();
      fill(pane, 
        info.ffmpeg ? null : el('p', { class: 'rec-error' }, 'Broadcasting needs FFmpeg, which was not found on the server.'),
        list,
        el('div', { class: 'row bc-add' }, el('span', { class: 'hint' }, 'Add:'), ...[['icecast', '+ Icecast'], ['shoutcast', '+ Shoutcast'], ['rtmp', '+ RTMP (Twitch / YouTube / Mixcloud)']].map(([k, l]) => el('button', { class: 'btn sm', onclick: () => add(k) }, l))),
        metaChk,
        el('p', { class: 'hint' }, 'Passwords and stream keys are stored on the server only (secrets.json in the data folder) and are never shown again.'),
        el('div', { class: 'row bc-actions' }, saveBtn, goBtn),
        statusBox,
      );
      live(() => {
        goBtn.textContent = broadcaster.live ? '■ Stop broadcast' : '● Go live';
        goBtn.classList.toggle('danger', broadcaster.live); goBtn.classList.toggle('primary', !broadcaster.live);
        const outs = broadcaster.live ? broadcaster.status?.outputs || [] : [];
        fill(statusBox, ...outs.map((o) => el('div', { class: `bc-out bc-${o.state}` },
          el('b', {}, o.name), ` ${STATE_LABEL[o.state] || o.state}`,
          liveDetail(o),
          o.reconnects ? ` · ${o.reconnects} reconnect(s)` : '',
          o.song ? el('div', { class: 'hint' }, `Now playing: ${o.song}`) : null,
          o.error ? el('div', { class: 'rec-error' }, o.error) : null, o.metaError ? el('div', { class: 'hint' }, o.metaError) : null)));
      }, 1000);
    },
  };

  function targetForm(t, remove, rerender, formats) {
    const set = (k) => (v) => { t[k] = v; };
    const secretIn = (key, has, label) => inp('', (v) => { t[key] = v; }, { type: 'password', autocomplete: 'new-password', placeholder: has ? '•••••• (saved — type to replace)' : label });
    const head = el('div', { class: 'row bc-head' },
      chk('', t.enabled !== false, set('enabled')),
      inp(t.name, set('name'), { style: { flex: 1 } }),
      el('span', { class: 'bc-type' }, t.type === 'rtmp' ? 'RTMP' : t.type === 'shoutcast' ? 'Shoutcast' : 'Icecast'),
      el('button', { class: 'btn sm danger', onclick: remove, title: 'Remove' }, icon('x')));
    let body;
    if (t.type === 'rtmp') {
      const urlIn = inp(t.rtmpUrl, set('rtmpUrl'), { placeholder: 'rtmp://…' });
      body = el('div', { class: 'rec-grid' },
        field('Service', sel(RTMP_PRESETS.some(([u]) => u && u === t.rtmpUrl) ? t.rtmpUrl : '', RTMP_PRESETS, (v) => { if (v) { t.rtmpUrl = v; urlIn.value = v; } })),
        field('Server URL', urlIn, 'Copy it from your streaming dashboard.'),
        field('Stream key', secretIn('streamKey', t.hasStreamKey, 'stream key')),
        field('Still image (server path, PNG/JPG)', inp(t.image, set('image'), { placeholder: 'OpenDJ logo' })),
        field('Audio bitrate', sel(t.audioBitrate || 160, [[128, '128 kbps'], [160, '160 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']], (v) => { t.audioBitrate = Number(v); })),
        field('Video', sel(t.resolution || '1280x720', [['1280x720', '720p'], ['1920x1080', '1080p'], ['854x480', '480p']], set('resolution'))));
    } else {
      const ice = t.type === 'icecast';
      body = el('div', { class: 'rec-grid' },
        field('Host', inp(t.host, set('host'), { placeholder: 'radio.example.com' })),
        field('Port', inp(t.port || 8000, set('port'), { type: 'number', min: 1, max: 65535 })),
        ice ? field('Mount point', inp(t.mount || '/live', set('mount'))) : field('Server version', sel(t.shoutcastVersion || 1, [[1, 'Shoutcast v1 (source port = port + 1)'], [2, 'Shoutcast v2 (stream ID)']], (v) => { t.shoutcastVersion = Number(v); rerender(); })),
        ice ? field('User', inp(t.username || 'source', set('username'))) : (Number(t.shoutcastVersion) === 2 ? field('Stream ID (sid)', inp(t.sid || 1, set('sid'), { type: 'number', min: 1 })) : field('Source port', inp(t.sourcePort || '', set('sourcePort'), { type: 'number', placeholder: 'port + 1' }))),
        field('Password', secretIn('password', t.hasPassword, 'source password')),
        field('Format', sel(t.format || 'mp3', formats.filter((f) => ice || f.id !== 'opus').map((f) => [f.id, f.label]), set('format'))),
        field('Bitrate', sel(t.bitrate || 128, [64, 96, 128, 160, 192, 256, 320].map((b) => [b, `${b} kbps`]), (v) => { t.bitrate = Number(v); })),
        field('Station name', inp(t.stationName, set('stationName'), { placeholder: 'OpenDJ live' })),
        field('Genre', inp(t.genre, set('genre'))),
        field('Website', inp(t.url, set('url'), { placeholder: 'https://…' })),
        ice ? field('Protocol', sel(t.protocol || 'auto', [['auto', 'Auto (PUT, then SOURCE)'], ['put', 'HTTP PUT (Icecast 2.4+)'], ['source', 'SOURCE (older Icecast)']], set('protocol'))) : null,
        el('div', { class: 'rec-checks' }, ice ? chk('TLS (https)', t.tls, set('tls')) : null, chk('List in public directory', t.public, set('public'))));
    }
    return el('div', { class: 'bc-target' }, head, body);
  }

  show(tab in tabs ? tab : 'record');
  return app.dialogs?.modal
    ? app.dialogs.modal('Record & stream', el('div', {}, tabBar, pane), [{ label: 'Close', primary: true, value: true }], { wide: true }).finally(() => clearInterval(timer))
    : (document.body.append(el('div', { class: 'overlay' }, el('div', { class: 'modal wide' }, tabBar, pane))), null);
}
