// HTTP API for "Export to CDJ USB".
//   POST /api/cdj/estimate  { targetDir, playlistIds, mode, profile, … }  -> dry-run plan + size estimate
//   POST /api/cdj/export    same body                                      -> { jobId } (progress: SSE 'cdj-export')
//   GET  /api/cdj/status                                                   -> current / last job
//   POST /api/cdj/cancel                                                   -> stop the running job
//   GET  /api/cdj/inspect?targetDir=…                                      -> existing export on the stick
import crypto from 'node:crypto';
import path from 'node:path';
import { evaluateSmart } from '../smart.js';
import { exportToCdj, inspectCdjExport } from './export.js';
import { PROFILES } from './formats.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

/**
 * @param {object} o
 * @param {Function} o.route      server route(method, pattern, handler)
 * @param {object}   o.library    Library
 * @param {Function} [o.emit]     SSE emit(type, payload)
 * @param {Function} [o.allowPath] (path, what) -> resolved path; throws when hosted mode forbids it
 * @param {Function} [o.readable]  (file) -> may this source file be read
 */
export function registerCdjRoutes({ route, library, emit = () => {}, allowPath = (p) => path.resolve(String(p)), readable }) {
  let job = null;   // { id, ctrl, progress, startedAt }
  let last = null;  // { id, result? , error? , finishedAt }

  const trackIds = (p) => (p.smart ? evaluateSmart(p.smart, library.allTracks()) : p.trackIds || []);
  const ffmpeg = async () => { await library.media?.ready; return library.media?.ffmpeg?.() || null; };
  const request = (body) => {
    if (typeof body.targetDir !== 'string' || !body.targetDir.trim()) throw httpError(400, 'Choose the USB stick (target folder)');
    return {
      targetDir: allowPath(body.targetDir.trim(), 'The export folder'),
      playlistIds: Array.isArray(body.playlistIds) ? body.playlistIds.filter((x) => typeof x === 'string') : [],
      mode: body.mode === 'replace' ? 'replace' : 'update',
      profile: body.profile === 'legacy' ? 'legacy' : 'nxs2',
      artwork: body.artwork !== false, threeBand: !!body.threeBand, phrases: body.phrases !== false, analyzeMissing: body.analyzeMissing !== false,
    };
  };
  const ctx = async (signal) => ({ library, emit, readable, signal, playlistTrackIds: trackIds, ffmpeg: await ffmpeg() });

  route('GET', '/api/cdj/profiles', () => Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label })));

  route('POST', '/api/cdj/estimate', async ({ body }) => exportToCdj(await ctx(), { ...request(body), dryRun: true }));

  route('POST', '/api/cdj/export', async ({ body }) => {
    if (job) throw httpError(409, 'A CDJ export is already running');
    const req = request(body);
    const id = crypto.randomBytes(6).toString('hex');
    const ctrl = new AbortController();
    job = { id, ctrl, startedAt: Date.now(), progress: { phase: 'start' }, targetDir: req.targetDir };
    const c = await ctx(ctrl.signal);
    const tap = c.emit;
    c.emit = (type, p) => { if (job?.id === id) job.progress = p; tap(type, p); };
    exportToCdj(c, { ...req, jobId: id })
      .then((result) => { last = { id, result, finishedAt: Date.now() }; })
      .catch((e) => {
        last = { id, error: e.message, cancelled: e.name === 'AbortError', finishedAt: Date.now() };
        emit('cdj-export', { jobId: id, phase: e.name === 'AbortError' ? 'cancelled' : 'error', message: e.message });
      })
      .finally(() => { if (job?.id === id) job = null; });
    return { started: true, jobId: id };
  });

  route('GET', '/api/cdj/status', () => ({
    running: job ? { jobId: job.id, startedAt: job.startedAt, progress: job.progress, targetDir: job.targetDir } : null,
    last,
  }));

  route('POST', '/api/cdj/cancel', async () => { if (job) job.ctrl.abort(); return { ok: true, cancelled: !!job }; });

  route('GET', '/api/cdj/inspect', async ({ query }) => {
    const dir = query.get('targetDir');
    if (!dir) throw httpError(400, 'targetDir required');
    return inspectCdjExport(allowPath(dir, 'The export folder'));
  });

  return { get running() { return job; }, get last() { return last; } };
}
