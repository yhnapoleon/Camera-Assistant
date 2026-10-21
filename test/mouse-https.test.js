import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createMouseApp } from '../src/mouse-server.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/https-${name}.pem`, import.meta.url));
const ca = readFileSync(fixture('ca'));
const secureGet = (port, pathname, token = 'test-pair') => new Promise((resolve, reject) => {
  https.get({ hostname: '127.0.0.1', port, path: pathname, ca, headers: { Authorization: `Bearer ${token}` } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
  }).on('error', reject);
});
async function start(t) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mouse-https-'));
  const app = createMouseApp({ dataDir, analyzer: 'demo', token: 'test-pair',
    httpsKey: fixture('key'), httpsCert: fixture('cert'), phoneCa: fixture('ca'),
  });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  assert.ok(app.httpsServer, 'an additional TLS listener must be available');
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  app.httpsServer.listen(0, '127.0.0.1'); await once(app.httpsServer, 'listening');
  return { app, http: `http://127.0.0.1:${app.server.address().port}`, port: app.httpsServer.address().port };
}

test('HTTPS shares HTTP pairing, settings and capture source while validating its certificate', async t => {
  const s = await start(t);
  const result = await fetch(s.http + '/api/settings', { method: 'POST', headers: { Authorization: 'Bearer test-pair', 'Content-Type': 'application/json' }, body: JSON.stringify({ systemPrompt: '共同的任务背景' }) });
  assert.equal(result.status, 200);
  assert.equal(JSON.parse((await secureGet(s.port, '/api/settings')).text).systemPrompt, '共同的任务背景');
  assert.equal((await secureGet(s.port, '/api/state', 'wrong')).status, 401);
  await fetch(s.http + '/api/source/register', { method: 'POST', headers: { Authorization: 'Bearer test-pair', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'existing HTTP capture agent' }) });
  assert.equal(JSON.parse((await secureGet(s.port, '/api/state')).text).source.online, true);
  assert.match((await secureGet(s.port, '/voice')).text, /语音问答/);
});

test('secure WebSockets use the same session, and only the public CA can be downloaded', async t => {
  const s = await start(t);
  const ws = new WebSocket(`wss://127.0.0.1:${s.port}/`, { ca, origin: `https://127.0.0.1:${s.port}` });
  t.after(() => ws.terminate()); await once(ws, 'open');
  const greeting = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', token: 'test-pair' }));
  const message = JSON.parse((await greeting)[0]); assert.equal(message.type, 'hello'); assert.equal(message.engine, s.app.engine.id);
  ws.close(); await once(ws, 'close');
  const download = await fetch(s.http + '/phone-ca.crt'); assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment/);
  const cert = new X509Certificate(Buffer.from(await download.arrayBuffer()));
  assert.equal(cert.fingerprint256, new X509Certificate(ca).fingerprint256); assert.equal(cert.ca, true);
  assert.equal((await fetch(s.http + '/certs/phone-server-key.pem')).status, 404);
  assert.equal((await fetch(s.http + '/certs/phone-ca/rootCA-key.pem')).status, 404);
});

test('a partial additional HTTPS configuration fails before starting any server', t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'mouse-https-invalid-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.throws(() => createMouseApp({ dataDir, analyzer: 'demo', httpsKey: fixture('key') }), /HTTPS/);
});
