// "Export to CDJ USB": writes a rekordbox device library (PIONEER/rekordbox/export.pdb, PIONEER/USBANLZ/…,
// PIONEER/Artwork/…, Contents/<Artist>/<Album>/<file>) for Pioneer CDJ / XDJ players.
//
// Modes: 'update' (default) keeps an existing export on the stick: its tracks keep their IDs, its playlists and
// history stay, exported playlists with the same name and folder are replaced. 'replace' writes a fresh database
// (audio files already on the stick are reused when identical). `dryRun` only plans and estimates the size.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { buildPdb } from './pdb-writer.js';
import { readExportDb } from './pdb-reader.js';
import { buildAnlz } from './anlz-writer.js';
import { cdjWaveforms } from './waveforms.js';
import { keyName, colorId, fileTypeOf, beatGrid, cueLists, phraseStructure, safeSegment, anlzDir, u2For } from './model.js';
import { planFormat, ffmpegEncoders, convertAudio, decodeMono, scaleArt } from './formats.js';
import { decodeWaveform, computeWaveform, detectBpm } from '../../public/js/audio/analysis-core.js';

export const SIDECAR = 'PIONEER/opendj-export.json';
const PDB_PATH = 'PIONEER/rekordbox/export.pdb';

const today = () => new Date().toISOString().slice(0, 10);
const dateOf = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString().slice(0, 10) : today());
const statOk = (f) => fs.promises.stat(f).catch(() => null);
const toDevice = (rel) => '/' + rel.split(path.sep).join('/');
const fromDevice = (root, dev) => path.join(root, ...String(dev).replace(/^\/+/, '').split('/'));

async function writeAtomic(file, data) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

/** Folder path + name of an OpenDJ playlist ("Gigs / 2026" folder -> ['Gigs', '2026']). */
const playlistPath = (p) => (p.folder ? String(p.folder).split('/').map((s) => s.trim()).filter(Boolean) : []);

class IdPool {
  constructor(rows, key = (r) => r.name) {
    this.map = new Map(); this.rows = [...rows]; this.max = 0; this.key = key;
    for (const r of rows) { this.max = Math.max(this.max, r.id); const k = key(r); if (!this.map.has(k)) this.map.set(k, r); }
  }
  get(name, make) {
    if (!name) return 0;
    const k = this.key({ name, ...(make || {}) });
    let r = this.map.get(k);
    if (!r) { r = { id: ++this.max, name, ...(make || {}) }; this.map.set(k, r); this.rows.push(r); }
    return r.id;
  }
}

/**
 * Plan + run an export.
 * @param {object} ctx { library, emit?, playlistTrackIds?(p), readable?(file), ffmpeg?: { path, encoders } , signal? }
 * @param {object} req { targetDir, playlistIds, mode: 'update'|'replace', profile: 'nxs2'|'legacy', dryRun,
 *                       artwork (default true), threeBand (.2EX, default false), phrases (default true),
 *                       analyzeMissing (default true: FFmpeg-decode tracks without a waveform) }
 */
export async function exportToCdj(ctx, req) {
  const { library } = ctx;
  const emit = (p) => ctx.emit?.('cdj-export', { jobId: req.jobId, ...p });
  const signal = ctx.signal;
  const check = () => { if (signal?.aborted) throw Object.assign(new Error('Export cancelled'), { name: 'AbortError' }); };
  const root = path.resolve(String(req.targetDir || ''));
  const st = await statOk(root);
  if (!st?.isDirectory()) throw Object.assign(new Error('The export target is not a folder (is the USB stick mounted?)'), { status: 400 });
  const opts = { mode: req.mode === 'replace' ? 'replace' : 'update', profile: req.profile === 'legacy' ? 'legacy' : 'nxs2', artwork: req.artwork !== false, threeBand: !!req.threeBand, phrases: req.phrases !== false, analyzeMissing: req.analyzeMissing !== false, dryRun: !!req.dryRun };
  const trackIdsOf = ctx.playlistTrackIds || ((p) => p.trackIds || []);
  const readable = ctx.readable || (() => true);
  let ff = ctx.ffmpeg?.path ? { ...ctx.ffmpeg } : null;
  if (ff && !('libmp3lame' in (ff.encoders || {}))) ff.encoders = { ...(ff.encoders || {}), ...(await ffmpegEncoders(ff.path)) };

  // ---------------------------------------------------------------- playlists + tracks
  const playlists = (Array.isArray(req.playlistIds) ? req.playlistIds : []).map((id) => library.getPlaylist(id)).filter(Boolean);
  if (!playlists.length) throw Object.assign(new Error('Choose at least one playlist'), { status: 400 });
  const order = []; const seen = new Set();
  for (const p of playlists) for (const tid of trackIdsOf(p)) if (!seen.has(tid)) { seen.add(tid); order.push(tid); }

  const skipped = []; const warnings = [];
  const items = [];
  for (const tid of order) {
    const t = library.getTrack(tid);
    if (!t) continue;
    const src = t.localPath || (t.sourceType === 'local' || !t.sourceType ? t.path : null);
    const label = [t.artist, t.title].filter(Boolean).join(' - ') || path.basename(String(src || tid));
    if (!src) { skipped.push({ id: tid, title: label, reason: 'streaming track: download it for offline use first' }); continue; }
    if (!readable(src)) { skipped.push({ id: tid, title: label, reason: 'file is outside the allowed music folders' }); continue; }
    const sst = await statOk(src);
    if (!sst?.isFile()) { skipped.push({ id: tid, title: label, reason: 'file missing (drive disconnected?)' }); continue; }
    const plan = planFormat({ file: src, codec: t.codec, sampleRate: t.sampleRate, hasVideo: t.hasVideo }, { profile: opts.profile, ffmpeg: ff });
    if (plan.action === 'skip') { skipped.push({ id: tid, title: label, reason: plan.reason }); continue; }
    items.push({ t, src, sst, plan, label });
  }

  // ---------------------------------------------------------------- existing export
  let old = null; let sidecar = { version: 1, tracks: {} };
  const pdbFile = path.join(root, ...PDB_PATH.split('/'));
  if (await statOk(pdbFile)) {
    try { old = readExportDb(await fs.promises.readFile(pdbFile)); } catch (e) { warnings.push(`The existing export.pdb could not be read (${e.message}); writing a new one.`); }
  }
  try { const s = JSON.parse(await fs.promises.readFile(path.join(root, ...SIDECAR.split('/')), 'utf8')); if (s && typeof s.tracks === 'object') sidecar = s; } catch { /* none */ }
  const keep = opts.mode === 'update' && old;

  const pools = {
    artists: new IdPool(keep ? old.artists : []),
    albums: new IdPool(keep ? old.albums : [], (r) => `${r.name}\u0000${r.artistId || 0}`),
    genres: new IdPool(keep ? old.genres : []),
    labels: new IdPool(keep ? old.labels : []),
    keys: new IdPool(keep ? old.keys : []),
  };
  const artwork = keep ? [...old.artwork] : [];
  let artworkMax = artwork.reduce((m, a) => Math.max(m, a.id), 0);
  const artByHash = new Map();
  const tracksByPath = new Map((keep ? old.tracks : []).map((r) => [r.filePath, r]));
  const oldById = new Map((old?.tracks || []).map((r) => [r.id, r]));
  let trackMax = keep ? old.tracks.reduce((m, r) => Math.max(m, r.id), 0) : 0;

  // ---------------------------------------------------------------- destination paths
  const claimed = new Map((keep ? old.tracks : []).map((r) => [r.filePath.toLowerCase(), null]));
  for (const it of items) {
    const prev = sidecar.tracks[it.t.id];
    const prevRow = prev && oldById.get(prev.pdbId);
    const ext = it.plan.action === 'convert' ? `.${it.plan.to}` : path.extname(it.src).toLowerCase();
    if (prevRow && prev.filePath === prevRow.filePath && path.extname(prev.filePath).toLowerCase() === ext) { it.devPath = prev.filePath; claimed.set(it.devPath.toLowerCase(), it.t.id); continue; }
    const dir = ['Contents', safeSegment(it.t.albumArtist || it.t.artist, 64, 'Unknown Artist'), safeSegment(it.t.album, 64, 'Unknown Album')];
    const stem = safeSegment(path.basename(it.src, path.extname(it.src)), 100, 'Track');
    for (let i = 1; ; i++) {
      const dev = toDevice(path.join(...dir, `${stem}${i > 1 ? ` (${i})` : ''}${ext}`));
      const owner = claimed.get(dev.toLowerCase());
      const existing = tracksByPath.get(dev);
      // a path belongs to this track when it is free, or when the old export's row came from the same source file
      if (owner === undefined || (owner === null && existing && (sidecar.tracks[it.t.id]?.filePath === dev || (it.plan.action === 'copy' && existing.fileSize === it.sst.size)))) { it.devPath = dev; claimed.set(dev.toLowerCase(), it.t.id); break; }
    }
  }

  // ---------------------------------------------------------------- dry run
  const existingSize = async (it) => { const s = await statOk(fromDevice(root, it.devPath)); return s?.isFile() ? s.size : -1; };
  let bytesAudio = 0, bytesReused = 0, anlzBytes = 0;
  for (const it of items) {
    const dur = Number(it.t.duration) || 0;
    const est = it.plan.action === 'copy' ? it.sst.size
      : it.plan.to === 'aiff' ? Math.round(dur * (it.plan.rate || it.t.sampleRate || 44100) * 2 * (it.plan.bits === 24 ? 3 : 2))
        : Math.round(dur * (it.plan.to === 'mp3' ? 40000 : 32000)) || it.sst.size;
    const have = await existingSize(it);
    const prev = sidecar.tracks[it.t.id];
    it.reuse = have >= 0 && (it.plan.action === 'copy' ? have === it.sst.size : prev && prev.srcSize === it.sst.size && prev.srcMtime === Math.round(it.sst.mtimeMs) && prev.filePath === it.devPath);
    it.estimate = est;
    if (it.reuse) bytesReused += have; else bytesAudio += est;
    anlzBytes += 12000 + Math.round(dur * 150 * (opts.threeBand ? 7 : 4));
  }
  const pdbEstimate = 4096 * (45 + Math.ceil(((keep ? old.tracks.length : 0) + items.length) / 9) + Math.ceil(order.length / 250));
  const statfs = await fs.promises.statfs?.(root).catch(() => null);
  const freeBytes = statfs ? Number(statfs.bavail) * Number(statfs.bsize) : null;
  const summary = {
    target: root, mode: opts.mode, profile: opts.profile, playlists: playlists.length, tracks: items.length,
    copy: items.filter((i) => i.plan.action === 'copy' && !i.reuse).length, convert: items.filter((i) => i.plan.action === 'convert' && !i.reuse).length,
    reuse: items.filter((i) => i.reuse).length, skipped, warnings,
    bytesNeeded: bytesAudio + anlzBytes + pdbEstimate, bytesAudio, bytesReused, freeBytes,
    existingExport: old ? { tracks: old.tracks.length, playlists: old.playlistTree.filter((p) => !p.isFolder).length } : null,
    ffmpeg: !!ff,
  };
  if (freeBytes != null && summary.bytesNeeded > freeBytes) summary.warnings.push(`Not enough free space: about ${Math.ceil(summary.bytesNeeded / 1e6)} MB needed, ${Math.floor(freeBytes / 1e6)} MB free.`);
  if (opts.dryRun) return { dryRun: true, ...summary };
  if (freeBytes != null && bytesAudio + anlzBytes > freeBytes) throw Object.assign(new Error(summary.warnings.at(-1)), { status: 507 });

  // ---------------------------------------------------------------- copy / analyse / write per track
  const date = today();
  const rows = new Map(keep ? old.tracks.map((r) => [r.id, r]) : []);
  const tidToPdb = new Map();
  const total = items.length;
  let done = 0, copied = 0, converted = 0, bytesDone = 0, lastEmit = 0;
  emit({ phase: 'start', done: 0, total, bytesTotal: bytesAudio });
  for (const it of items) {
    check();
    const { t, src, sst, plan } = it;
    const dest = fromDevice(root, it.devPath);
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      if (!it.reuse) {
        if (plan.action === 'copy') {
          const tmp = `${dest}.part`;
          await fs.promises.copyFile(src, tmp);
          await fs.promises.utimes(tmp, sst.atime, sst.mtime).catch(() => {});
          await fs.promises.rename(tmp, dest);
          copied++;
        } else {
          emit({ phase: 'convert', done, total, track: it.label });
          await convertAudio(ff.path, src, dest, plan, { signal });
          converted++;
        }
        bytesDone += it.estimate;
      }
      const dst = await statOk(dest);
      if (!dst?.isFile()) throw new Error('file was not written');

      // tags / format details (+ artwork) from the file on the stick
      let mm = null;
      try { mm = await parseFile(dest, { duration: !(t.duration > 0), skipCovers: !opts.artwork }); } catch { /* unreadable tags */ }
      const duration = Number(t.duration) || mm?.format?.duration || 0;

      // waveform: OpenDJ's analysis cache, or decode with FFmpeg
      let wave = null; let bpm = Number(t.bpm) || 0; let gridOffset = Number(t.gridOffset) || 0;
      try { wave = decodeWaveform(await fs.promises.readFile(library.waveformPath(t.id))); } catch { /* not analysed */ }
      if (!wave && opts.analyzeMissing && ff) {
        emit({ phase: 'analyze', done, total, track: it.label });
        try {
          const { mono, sr } = await decodeMono(ff.path, src, { signal });
          const w = computeWaveform(mono, sr);
          wave = { rate: w.rate || 150, low: w.low, mid: w.mid, high: w.high, peak: w.peak };
          if (!bpm) { const b = detectBpm(mono, sr); if (b?.bpm) { bpm = b.bpm; gridOffset = b.offset || 0; } }
        } catch (e) { if (e.name === 'AbortError') throw e; warnings.push(`${it.label}: could not analyse (${e.message})`); }
      }
      if (wave && !(wave.peak instanceof Uint8Array)) wave = toBytes(wave);

      // analysis files
      const beats = beatGrid({ bpm, gridOffset, downbeat: t.downbeat, duration });
      const { hotCues, memoryCues } = cueLists({ ...t, bpm });
      const anlzBase = anlzDir(it.devPath);
      const sr = mm?.format?.sampleRate || t.sampleRate || 44100;
      const totalSamples = Math.round(duration * sr);
      const a = buildAnlz({
        path: it.devPath, totalSamples, beats, hotCues, memoryCues,
        waveforms: cdjWaveforms(wave, duration),
        phrases: opts.phrases ? phraseStructure(t.phrases, beats) : null,
      }, { twoEx: opts.threeBand });
      const anlzAbs = fromDevice(root, anlzBase);
      await fs.promises.mkdir(anlzAbs, { recursive: true });
      await writeAtomic(path.join(anlzAbs, 'ANLZ0000.DAT'), a.dat);
      await writeAtomic(path.join(anlzAbs, 'ANLZ0000.EXT'), a.ext);
      if (a.twoEx) await writeAtomic(path.join(anlzAbs, 'ANLZ0000.2EX'), a.twoEx);
      else await fs.promises.rm(path.join(anlzAbs, 'ANLZ0000.2EX'), { force: true });

      // artwork
      let artworkId = 0;
      const pic = opts.artwork ? mm?.common?.picture?.[0] : null;
      if (pic?.data?.length && ff) {
        const h = crypto.createHash('sha1').update(pic.data).digest('hex');
        if (artByHash.has(h)) artworkId = artByHash.get(h);
        else {
          try {
            const small = await scaleArt(ff.path, Buffer.from(pic.data), 80, { signal });
            const big = await scaleArt(ff.path, Buffer.from(pic.data), 240, { signal });
            const id = ++artworkMax;
            const dev = `/PIONEER/Artwork/${String(Math.ceil(id / 1000)).padStart(5, '0')}/a${id}.jpg`;
            await writeAtomic(fromDevice(root, dev), small);
            await writeAtomic(fromDevice(root, dev.replace(/\.jpg$/, '_m.jpg')), big);
            artwork.push({ id, path: dev });
            artByHash.set(h, id); artworkId = id;
          } catch (e) { if (e.name === 'AbortError') throw e; }
        }
      } else if (pic?.data?.length && !ff && !warnings.some((w) => w.startsWith('Album art'))) warnings.push('Album art needs FFmpeg (to make the 80×80 / 240×240 JPEGs players expect); exported without art.');

      // database row
      const prevRow = tracksByPath.get(it.devPath) || (sidecar.tracks[t.id] && keep && oldById.get(sidecar.tracks[t.id].pdbId));
      const id = prevRow?.id ?? ++trackMax;
      const artistId = pools.artists.get(t.artist || '');
      const fmt = mm?.format || {};
      rows.set(id, {
        ...(prevRow || {}),
        id, title: t.title || path.basename(it.devPath, path.extname(it.devPath)),
        artistId, albumId: t.album ? pools.albums.get(t.album, { artistId: t.albumArtist ? pools.artists.get(t.albumArtist) : artistId }) : 0,
        genreId: pools.genres.get(t.genre || ''), labelId: pools.labels.get(t.label || ''), keyId: pools.keys.get(keyName(t.key)),
        composerId: 0, remixerId: 0, originalArtistId: 0, artworkId: artworkId || (prevRow?.artworkId && artwork.some((x) => x.id === prevRow.artworkId) ? prevRow.artworkId : 0),
        colorId: colorId(t.color), rating: Math.max(0, Math.min(5, Math.round(Number(t.rating) || 0))),
        tempo: Math.round((bpm || 0) * 100), duration: Math.round(duration), year: Number(t.year) || 0, trackNumber: Number(t.trackNumber) || 0, discNumber: 0,
        playCount: Math.min(0xffff, Number(t.playCount) || 0),
        bitrate: Math.round((fmt.bitrate || 0) / 1000) || (plan.action === 'copy' ? Number(t.bitrate) || 0 : 0),
        sampleRate: fmt.sampleRate || (plan.action === 'copy' ? Number(t.sampleRate) || 0 : plan.rate || 0),
        sampleDepth: fmt.bitsPerSample || (plan.to === 'aiff' ? plan.bits : 16),
        fileSize: dst.size, fileType: fileTypeOf(it.devPath), u2: prevRow?.u2 || u2For(it.devPath),
        unknown3: [0x0b, 0x0c].includes(fileTypeOf(it.devPath)) ? '2' : '3',
        dateAdded: prevRow?.dateAdded || dateOf(t.addedAt), releaseDate: t.year ? `${t.year}-01-01` : '',
        analyzePath: `${anlzBase}/ANLZ0000.DAT`, analyzeDate: date, comment: String(t.comment || '').slice(0, 200),
        filename: path.posix.basename(it.devPath), filePath: it.devPath, mixName: '', message: '', autoloadHotcues: 'ON',
      });
      tidToPdb.set(t.id, id);
      sidecar.tracks[t.id] = { pdbId: id, filePath: it.devPath, srcSize: sst.size, srcMtime: Math.round(sst.mtimeMs) };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      skipped.push({ id: t.id, title: it.label, reason: e.message });
    }
    done++;
    if (Date.now() - lastEmit > 200 || done === total) { lastEmit = Date.now(); emit({ phase: 'tracks', done, total, track: it.label, bytesDone, bytesTotal: bytesAudio }); }
  }

  // ---------------------------------------------------------------- playlist tree
  check();
  emit({ phase: 'database', done, total });
  const tree = keep ? old.playlistTree.map((r) => ({ ...r })) : [];
  let entries = keep ? old.playlistEntries.map((r) => ({ ...r })) : [];
  let treeMax = tree.reduce((m, r) => Math.max(m, r.id), 0);
  const child = (parentId, name, isFolder) => tree.find((r) => r.parentId === parentId && r.name === name && !!r.isFolder === isFolder);
  const nextSort = (parentId) => tree.filter((r) => r.parentId === parentId).reduce((m, r) => Math.max(m, r.sortOrder), 0) + 1;
  const exportedPlaylists = [];
  for (const p of playlists) {
    let parent = 0;
    for (const f of playlistPath(p)) {
      let node = child(parent, f, true);
      if (!node) { node = { id: ++treeMax, parentId: parent, sortOrder: nextSort(parent), isFolder: true, name: f }; tree.push(node); }
      parent = node.id;
    }
    const name = String(p.name || 'Playlist');
    let node = child(parent, name, false);
    if (!node) { node = { id: ++treeMax, parentId: parent, sortOrder: nextSort(parent), isFolder: false, name }; tree.push(node); }
    const ids = trackIdsOf(p).map((tid) => tidToPdb.get(tid)).filter(Boolean);
    entries = entries.filter((e) => e.playlistId !== node.id);
    ids.forEach((trackId, i) => entries.push({ entryIndex: i + 1, trackId, playlistId: node.id }));
    exportedPlaylists.push({ name, folder: playlistPath(p).join(' / '), tracks: ids.length });
  }
  const liveTracks = new Set(rows.keys());
  entries = entries.filter((e) => liveTracks.has(e.trackId));

  // ---------------------------------------------------------------- write the database
  const db = {
    tracks: [...rows.values()], artists: pools.artists.rows, albums: pools.albums.rows, genres: pools.genres.rows, labels: pools.labels.rows,
    keys: pools.keys.rows.map((k) => ({ ...k, id2: k.id })), artwork, playlistTree: tree, playlistEntries: entries,
    historyPlaylists: keep ? old.historyPlaylists : [], historyEntries: keep ? old.historyEntries.filter((e) => liveTracks.has(e.trackId)) : [],
    raw: keep ? { 9: old.raw[9], 10: old.raw[10], 14: old.raw[14], 15: old.raw[15], 19: old.raw[19] } : {},
  };
  const pdb = buildPdb(db, { date });
  await writeAtomic(pdbFile, pdb);
  sidecar.updated = Date.now(); sidecar.app = 'OpenDJ';
  await writeAtomic(path.join(root, ...SIDECAR.split('/')), JSON.stringify(sidecar));
  const result = {
    ...summary, ok: true, exported: exportedPlaylists, copied, converted, written: done - skipped.filter((s) => items.some((i) => i.t.id === s.id)).length,
    totalTracksOnDevice: rows.size, pdbBytes: pdb.length, skipped, warnings,
  };
  emit({ phase: 'done', done, total, result });
  return result;
}

/** ODJW decoded with Float32 bands (fresh computeWaveform) -> 0..255 bytes, normalised to the loudest point. */
function toBytes(w) {
  let max = 0;
  for (const a of [w.low, w.mid, w.high, w.peak]) for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  const s = max > 0 ? 255 / max : 0;
  const q = (a) => Uint8Array.from(a, (v) => Math.min(255, Math.round(v * s)));
  return { rate: w.rate, low: q(w.low), mid: q(w.mid), high: q(w.high), peak: q(w.peak) };
}

/** Summary of an existing export on a stick (for the dialog). */
export async function inspectCdjExport(targetDir) {
  const root = path.resolve(String(targetDir || ''));
  const f = path.join(root, ...PDB_PATH.split('/'));
  const st = await statOk(f);
  if (!st) return { exists: false };
  try {
    const db = readExportDb(await fs.promises.readFile(f));
    let byOpenDJ = false; try { byOpenDJ = !!JSON.parse(await fs.promises.readFile(path.join(root, ...SIDECAR.split('/')), 'utf8')).app; } catch { /* rekordbox export */ }
    return {
      exists: true, byOpenDJ, modified: st.mtimeMs, tracks: db.tracks.length,
      playlists: db.playlistTree.filter((p) => !p.isFolder).map((p) => ({ id: p.id, name: p.name, tracks: db.playlistEntries.filter((e) => e.playlistId === p.id).length })),
      problems: db.problems.slice(0, 20),
    };
  } catch (e) { return { exists: true, error: e.message }; }
}
