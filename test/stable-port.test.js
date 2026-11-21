// Desktop app: the local server keeps its port across launches (the page's browser storage is per origin).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { startOnStablePort, savedPort } from '../electron/stable-port.js';

const fakeStart = (opened) => async (port) => {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, '127.0.0.1', resolve); });
  opened.push(s);
  return { port: s.address().port };
};

test('first launch remembers its port, the next launch reuses it, a busy port falls back without forgetting it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odj-port-')), file = path.join(dir, 'server-port.json');
  const opened = [];
  try {
    const a = await startOnStablePort(fakeStart(opened), file);
    assert.ok(a.server.port > 0);
    assert.equal(savedPort(file), a.server.port);
    await new Promise((r) => opened.pop().close(r));
    const b = await startOnStablePort(fakeStart(opened), file);
    assert.equal(b.server.port, a.server.port, 'same origin on the second launch');
    assert.equal(b.stable, true);
    // still open (e.g. a second OpenDJ): this launch gets another port, the remembered one is kept
    const c = await startOnStablePort(fakeStart(opened), file);
    assert.notEqual(c.server.port, a.server.port);
    assert.equal(c.stable, false);
    assert.equal(savedPort(file), a.server.port);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'file readable by the user only');
  } finally { for (const s of opened) s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a damaged or out-of-range port file is ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odj-port-')), file = path.join(dir, 'p.json');
  for (const bad of ['nope', '{"port":80}', '{"port":70000}', '{"port":"8080"}']) { fs.writeFileSync(file, bad); assert.equal(savedPort(file), bad === '{"port":"8080"}' ? 8080 : null, bad); }
  assert.equal(savedPort(path.join(dir, 'missing.json')), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
