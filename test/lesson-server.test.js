import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createMouseApp, answerPrompt } from '../src/mouse-server.js';
import { lessonFixture } from './fixtures/lesson.js';

async function until(done) { for (let n = 0; n < 100; n++) { if (done()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('timed out'); }
test('lesson details survive restart while summaries stay small; failed generation can be retried with the same images', async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'lesson-test-'));
  let calls = 0, received;
  const analyze = async job => { calls++; received = { image: job.frames[0].path, prompt: job.systemPrompt }; return calls === 1 ? '{"version":1' : JSON.stringify(lessonFixture()); };
  let app = createMouseApp({ dataDir, token: 'lesson-test', analyze });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const headers = { Authorization: 'Bearer lesson-test' };
  const job = app.store.submit([{ id: 'image', path: 'test-image.jpg' }]);
  await until(() => job.status === 'failed' && !app.store.running.size);
  assert.equal((await fetch(base + `/api/retry?id=${job.id}`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + `/api/retry?id=${job.id}`, { method: 'POST', headers })).status, 200);
  await until(() => job.status === 'done' && !app.store.running.size);
  assert.equal(calls, 2); assert.equal(received.image, 'test-image.jpg');
  assert.equal((await fetch(base + `/api/retry?id=${job.id}`, { method: 'POST', headers })).status, 409);
  const state = await (await fetch(base + '/api/state', { headers })).json();
  assert.equal(state.jobs[0].hasLesson, true); assert.equal(state.jobs[0].lesson, undefined);
  assert.equal(state.jobs[0].answer, undefined);
  const detail = await (await fetch(base + `/api/job?id=${job.id}`, { headers })).json();
  assert.equal(detail.lesson.problems[0].variants.leetcode.output, '[0, 1]');
  await app.close();
  app = createMouseApp({ dataDir, token: 'lesson-test', analyze });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  assert.equal(app.store.job(job.id).lesson.problems[0].variants.acm.input, '4 9\n2 7 11 15');
  assert.equal(calls, 2, 'reloading does not invoke the model again');
});

test('photo analysis keeps the lesson protocol and photo terminology', () => {
  const prompt = answerPrompt({ mode: 'camera' });
  assert.match(prompt, /"version":1/); assert.match(prompt, /ACM/);
  assert.doesNotMatch(prompt, /截图/);
});
