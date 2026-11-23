// Where AI stems are separated (public/js/stems/stems.js): the server, or this window's WebGPU when the server's
// graphics card fails its check. A fake server answers the stems API.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function setup({ gpu = 'unknown', warmTo = 'failed', webgpu = true, verdict = null } = {}) {
  const calls = [], store = new Map(verdict ? [['opendj-stems-webgpu:abc', verdict]] : []);
  let native = { installed: true, available: true, backend: null, gpu, gpuFailed: gpu === 'failed' ? { backend: 'dml', message: 'x' } : null, queue: [], current: null };
  const json = (body) => ({ ok: true, json: async () => body });
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  Object.defineProperty(globalThis, 'navigator', { value: webgpu ? { gpu: {} } : {}, configurable: true });
  globalThis.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push([opts.method || 'GET', url, body]);
    if (url === '/api/stems/status') return json({ native, ort: true, model: { ready: true, sha256: 'abc', id: 'htdemucs-v4' } });
    if (url === '/api/stems/engine/warm') { native = { ...native, gpu: warmTo, backend: warmTo === 'ok' ? 'dml' : 'cpu', gpuFailed: warmTo === 'failed' ? { backend: 'dml', message: 'no match' } : null }; return json(native); }
    if (url === '/api/stems/queue') { native.queue.push(...body.ids); return json({ ...native, added: body.ids.length }); }
    if (url === '/api/stems/queue/cancel') { native.queue = native.queue.filter((id) => !(body.ids || []).includes(id)); return json(native); }
    return json({});
  };
  return { calls, store, get native() { return native; } };
}

async function manager() {
  const { StemsManager } = await import('../public/js/stems/stems.js');
  const tracks = new Map(['a', 'b', 'c'].map((id) => [id, { id, title: id.toUpperCase() }]));
  const app = { settings: {}, library: { track: (id) => tracks.get(id), updateTrack() {} }, engine: { decks: [] }, toast() {} };
  const m = new StemsManager(app);
  m.pump = async () => { m.pumped = [...m.queue]; }; // the browser engine itself is not run here
  return m;
}

test('stems routing: the GPU check runs before anything is queued; a failed server GPU sends tracks to WebGPU', async () => {
  const s = setup({ gpu: 'unknown', warmTo: 'failed' });
  const m = await manager();
  await m.enqueue(['a', 'b']);
  const order = s.calls.map((c) => c[1]);
  assert.ok(order.indexOf('/api/stems/engine/warm') >= 0, 'engine warmed up first');
  assert.ok(!order.includes('/api/stems/queue'), 'nothing queued on the server CPU');
  assert.deepEqual(m.pumped, ['a', 'b'], 'separated in this window on WebGPU');
  assert.equal(m.browserGpu, true);
});

test('stems routing: a working server GPU keeps the server; no WebGPU or a failed WebGPU check keeps the server', async () => {
  for (const opts of [{ warmTo: 'ok' }, { webgpu: false }, { gpu: 'failed', verdict: 'bad' }]) {
    const s = setup(opts);
    const m = await manager();
    await m.enqueue(['a']);
    assert.ok(s.calls.some((c) => c[1] === '/api/stems/queue'), `server: ${JSON.stringify(opts)}`);
    assert.equal(m.pumped, undefined);
  }
});

test('stems routing: tracks already waiting on the server move to WebGPU when its GPU turns out to fail', async () => {
  const s = setup({ gpu: 'unknown' });
  const m = await manager();
  await m.status();
  m.serverEvent('stems-queue', { current: { id: 'a', title: 'A', phase: 'separating' }, queue: ['a', 'b', 'c'], gpu: 'failed', gpuFailed: { backend: 'dml', message: 'no match' } });
  for (let i = 0; i < 20 && !m.pumped; i++) await new Promise((r) => setTimeout(r, 5));
  const cancel = s.calls.find((c) => c[1] === '/api/stems/queue/cancel');
  assert.deepEqual(cancel?.[2], { ids: ['b', 'c'] }, 'the running one stays, the waiting ones are taken back');
  assert.deepEqual(m.pumped, ['b', 'c']);
});
