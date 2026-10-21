import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createMouseApp } from '../src/mouse-server.js';

async function start(t, config = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'voice-test-'));
  const app = createMouseApp({ dataDir, token: 'test-token', analyzer: 'demo', ...config });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, call: (url, options = {}) => fetch(base + url, options), upload: (body = 'recorded audio', headers = {}) => fetch(base + '/api/voice', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'audio/webm;codecs=opus', ...headers }, body,
  }) };
}

test('voice upload emits the transcript before answering with the selected model and background, without a capture agent', async t => {
  let finish;
  const answer = new Promise(resolve => { finish = resolve; });
  const s = await start(t, { analyzer: 'openai', model: 'chosen-model',
    transcribe: async bytes => { assert.equal(bytes.toString(), 'recorded audio'); return '为什么天空是蓝色的？'; },
    createProvider: () => ({ ask: async (prompt, images, options) => {
      assert.match(prompt, /为什么天空是蓝色的/); assert.deepEqual(images, []);
      assert.equal(options.systemPrompt, '解释给初中生'); return answer;
    } }),
  });
  writeFileSync(s.app.promptFile, '解释给初中生');
  const response = await s.upload(); assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /为什么天空是蓝色的/); assert.match(first, /transcript/);
  finish('空气分子对蓝光的散射更强。');
  let rest = ''; for (;;) { const { done, value } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
  assert.match(rest, /空气分子/); assert.match(rest, /chosen-model/);
  assert.equal(s.app.store.state.jobs.length, 0);
});

test('voice routes require pairing and reject empty or unsupported audio before transcription', async t => {
  const s = await start(t, { transcribe: () => { throw Error('must not transcribe'); } });
  assert.equal((await s.upload('audio', { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await s.upload('audio', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.upload('')).status, 400);
  const page = await s.call('/voice'); assert.equal(page.status, 200);
  assert.match(await page.text(), /语音问答/);
});

test('empty transcription never produces an invented answer, and failures remain visible', async t => {
  const s = await start(t, { transcribe: async () => '   ' });
  const response = await s.upload();
  assert.match(await response.text(), /未识别到/);
});

test('missing OpenAI key is reported before uploading to the provider', async t => {
  const s = await start(t, { apiKey: '' });
  const response = await s.upload(); assert.equal(response.status, 503);
  assert.match(await response.text(), /OPENAI_API_KEY/);
});

test('oversized audio is rejected and a failed answer preserves the transcript with an error event', async t => {
  const s = await start(t, { analyzer: 'openai', transcribe: async () => '一个问题',
    createProvider: () => ({ ask: async () => { throw Error('解答模型不可用'); } }),
  });
  assert.equal((await s.upload(Buffer.alloc(20_000_001))).status, 413);
  const response = await s.upload();
  const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'transcript'); assert.equal(events[0].text, '一个问题');
  assert.equal(events[1].type, 'error'); assert.match(events[1].error, /解答模型不可用/);
});

test('closing the response cancels transcription', async t => {
  let cancelled;
  const aborted = new Promise(resolve => { cancelled = resolve; });
  const s = await start(t, { transcribe: async (_bytes, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(Error('aborted')); }, { once: true });
  }) });
  const response = await s.upload(); await response.body.cancel();
  await Promise.race([aborted, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('did not cancel')), 2000); timer.unref(); })]);
});
