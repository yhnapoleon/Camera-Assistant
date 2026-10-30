import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { REFERENCE_PROMPT } from '../src/reference-problems.js';
import sharp from 'sharp';
import { ANSWER_PROMPT, answerPrompt, createMouseApp, explainPrompt, matchPrompt, parseModels } from '../src/mouse-server.js';

const wait = ms => new Promise(r => setTimeout(r, ms));
const png = (background = 'white') => sharp({ create: { width: 64, height: 64, channels: 3, background } }).png().toBuffer();
async function start(t, config = {}) {
  const dataDir = config.dataDir || mkdtempSync(path.join(os.tmpdir(), 'mouse-server-test-'));
  const app = createMouseApp({ dataDir, token: 'test-token', analyze: async job => `标题：第 ${job.seq} 次，${job.frames.length} 张\n\n1. A`, explain: async job => `## 第 1 题\n**解析：** 依据 ${job.answer}`, ...config });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`, headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
  const call = (url, options = {}) => fetch(base + url, { ...options, headers: { ...headers, ...options.headers } });
  const post = (url, data, extra) => call(url, { method: 'POST', body: JSON.stringify(data || {}), headers: extra });
  return { app, base, dataDir, call, post, capture: async mode => (await (await post('/api/capture', mode ? { mode } : undefined)).json()).job };
}
async function phone(base, token = 'test-token') {
  const ws = new WebSocket(base.replace('http', 'ws')), events = []; ws.on('message', d => events.push(JSON.parse(d)));
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', token }));
  const until = async match => { for (let i = 0; i < 300; i++) { const e = events.find(match); if (e) return e; await wait(10); } throw Error('等待事件超时'); };
  return { ws, events, until };
}
// Mirrors collect/ScreenAgent.cs: register once, then poll; a capture command is one PNG upload followed by finish.
async function agent(s, name = 'Test PC') {
  const { clientId } = await (await s.post('/api/source/register', { name })).json(), id = { 'X-Client-Id': clientId }; let ack = '';
  const poll = async () => (await (await s.call(`/api/source/poll?ack=${ack}`, { headers: id })).json()).command;
  const frame = async (batchId, frameId, color) => s.call(`/api/frame?batchId=${batchId}&frameId=${frameId}&capturedAt=2026-10-09T12:00:00.000Z`, { method: 'POST', headers: { ...id, 'Content-Type': 'image/png' }, body: await png(color) });
  const finish = (batchId, error = '') => s.post('/api/source/finish', { batchId, error }, id);
  const next = async () => { for (let i = 0; i < 300; i++) { const command = await poll(); if (command) { ack = command.id; return command; } await wait(5); } throw Error('没有等到截图指令'); };
  const shoot = async color => { const command = await next(); const upload = await frame(command.batch.id, randomUUID(), color); await finish(command.batch.id); return { command, upload }; };
  return { clientId, poll, frame, finish, next, shoot };
}

test('a left click captures on the agent, answers, and delivers the answer to the phone', async t => {
  const s = await start(t), p = await phone(s.base);
  const hello = await p.until(e => e.type === 'hello'); assert.deepEqual(hello.jobs, []); assert.equal(hello.source.online, false);
  assert.equal((await s.post('/api/capture')).status, 409);
  const a = await agent(s); assert.equal((await p.until(e => e.type === 'source' && e.source.online)).source.name, 'Test PC');
  const job = await s.capture(); assert.equal(job.status, 'capturing'); assert.equal(job.mode, 'single');
  assert.equal((await s.capture()).id, job.id, 'a second click while the screenshot is on its way reuses the job');
  assert.equal((await s.post('/api/capture', { mode: 'burst' })).status, 409);
  const command = await a.next(), frameId = randomUUID();
  assert.equal(command.type, 'capture'); assert.equal(command.batch.mode, 'single'); assert.notEqual(command.batch.id, job.id);
  assert.equal((await a.frame(command.batch.id, frameId)).status, 200);
  const retry = await a.frame(command.batch.id, frameId); assert.equal(retry.status, 200, 'a retried upload is acknowledged'); assert.equal((await retry.json()).ignored, true);
  assert.equal((await a.finish(command.batch.id)).status, 200); assert.equal(await a.poll(), null);
  const done = (await p.until(e => e.type === 'job' && e.job.status === 'done')).job;
  assert.equal(done.title, '第 1 次，1 张'); assert.equal(done.answer, '1. A'); assert.equal(done.frameCount, 1); assert.equal(done.frames, undefined); assert.equal(done.explanation, undefined);
  const state = await (await s.call('/api/state')).json();
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].answer, undefined); assert.equal(state.jobs[0].snippet, '1. A');
  assert.equal((await (await s.call(`/api/job?id=${job.id}`)).json()).answer, '1. A');
  assert.equal((await s.call(`/api/image?id=${job.id}`)).headers.get('content-type'), 'image/jpeg'); assert.equal((await s.call(`/api/image?id=${job.id}&n=1`)).status, 404);
  assert.deepEqual(readdirSync(path.join(s.dataDir, 'images')), [`${frameId}.jpg`]); p.ws.close();
});

test('holding the button takes a series of screenshots and answers them together after release', async t => {
  const s = await start(t, { interval: 20 }), a = await agent(s), p = await phone(s.base);
  const job = await s.capture('burst'); assert.equal(job.mode, 'burst'); assert.equal(job.status, 'capturing');
  assert.equal((await (await a.shoot('white')).upload.json()).repeated, false);
  assert.equal((await (await a.shoot('white')).upload.json()).repeated, true, 'an unchanged screen is dropped');
  await a.shoot('black'); assert.equal((await s.post(`/api/hold?id=${job.id}`)).status, 200);
  const last = await a.next();   // already requested when the button is released
  assert.equal((await s.post(`/api/release?id=${job.id}`)).status, 200); assert.equal(s.app.store.job(job.id).status, 'capturing');
  await a.frame(last.batch.id, randomUUID(), 'gray'); await a.finish(last.batch.id);
  const done = (await p.until(e => e.type === 'job' && e.job.status === 'done')).job;
  assert.equal(done.title, '第 1 次，3 张'); assert.equal(done.frameCount, 3); assert.equal(done.shots, 4);
  await wait(60); assert.equal(await a.poll(), null, 'no screenshot is requested after release');
  assert.equal(readdirSync(path.join(s.dataDir, 'images')).length, 3); assert.equal((await s.call(`/api/image?id=${job.id}&n=2`)).status, 200);
  assert.ok(p.events.some(e => e.type === 'job' && e.job.status === 'capturing' && e.job.shots === 2), 'the phone sees the count grow while holding'); p.ws.close();
});

test('the explanation is produced only when asked for, from the screenshots and the answer already given', async t => {
  let asked = 0;
  const s = await start(t, { explain: async job => { asked++; return `## 第 1 题\n**解析：** 依据 ${job.answer}，共 ${job.frames.length} 张`; } }), a = await agent(s), p = await phone(s.base);
  const job = await s.capture(); assert.equal((await s.post(`/api/explain?id=${job.id}`)).status, 400);
  await a.shoot(); await p.until(e => e.type === 'job' && e.job.status === 'done'); assert.equal(asked, 0);
  const running = (await (await s.post(`/api/explain?id=${job.id}`)).json()).job; assert.equal(running.explainStatus, 'running');
  const explained = (await p.until(e => e.type === 'job' && e.job.explanation)).job;
  assert.equal(explained.explanation, '## 第 1 题\n**解析：** 依据 1. A，共 1 张'); assert.equal(explained.explainStatus, 'done'); assert.equal(explained.status, 'done');
  assert.equal((await (await s.post(`/api/explain?id=${job.id}`)).json()).job.explanation, explained.explanation); assert.equal(asked, 1);
  const listed = (await (await s.call('/api/state')).json()).jobs[0]; assert.equal(listed.explanation, undefined); assert.equal(listed.hasExplanation, true);
  p.ws.close();
});

test('a programming answer reaches the phone with its code first; the problem list match follows from that answer', async t => {
  const code = '```py\nprint(1)\n```'; let open; const gate = new Promise(r => { open = r; });
  const analyze = async () => `标题：每日温度\n\n类型：代码题\n代码：\n${code}\n题意：求每天之后第一个更高温度的距离\n分类：栈\n思路：单调栈`;
  const s = await start(t, { analyze, requireLesson: false, match: async job => { await gate; return `候选：739\n比较：${job.insights[0].summary}，相同\n改动：不用改\n结论：739`; } }), a = await agent(s), p = await phone(s.base);
  await s.capture(); await a.shoot();
  const answered = (await p.until(e => e.type === 'job' && e.job.status === 'done')).job;
  assert.equal(answered.answer, code); assert.equal(answered.kind, 'code'); assert.equal(answered.matchStatus, 'running');
  assert.deepEqual(answered.insights, [{ summary: '求每天之后第一个更高温度的距离', categories: ['栈'], approaches: ['单调栈'] }]);
  open();
  const matched = (await p.until(e => e.type === 'job' && e.job.matchStatus === 'done')).job;
  assert.deepEqual(matched.insights[0].origin, { relation: 'same', problem: '739. 每日温度', hot: true, note: '' });
  assert.equal((await (await s.call('/api/state')).json()).jobs[0].snippet, '原题 739. 每日温度 · 栈 · 单调栈');
  assert.ok(!ANSWER_PROMPT.includes('1851'), 'the answer is written without the problem list in sight');
  const prompt = matchPrompt({ insights: answered.insights, answer: code });
  assert.ok(prompt.includes(code) && prompt.includes('题意：求每天之后第一个更高温度的距离') && prompt.includes('1851 包含每个查询的最小区间'));
  assert.ok(prompt.includes('E1 合并嵌套 JSON｜字节｜给两个嵌套的 JSON') && prompt.indexOf('E28 手写 Agent Loop') < prompt.indexOf('217 存在重复元素'), 'company problems come with what they ask, ahead of the LeetCode list');
  for (const wanted of ['以写出的题意为准', '题号是字母 E 加数字', '分不出远近时，才优先写企业手撕题的题号']) assert.ok(prompt.includes(wanted), `the match prompt says: ${wanted}`);
  p.ws.close();
});

test('code the user has already written is completed in place, and its explanation names what to change and where', () => {
  for (const wanted of ['已有代码：', '在用户的代码上补全和修改', '“改：”', '“补：”', '命名要直白', '带讲解注释']) assert.ok(ANSWER_PROMPT.includes(wanted), `the answer prompt asks for: ${wanted}`);
  assert.ok(!ANSWER_PROMPT.includes('不写注释'));
  const code = '```py\n# 改：原来少了等号\nwhile left <= right:\n    pass\n```';
  const drafted = explainPrompt({ answer: code, insights: [{ draft: 'full', categories: [], approaches: [] }] });
  assert.ok(drafted.includes(code) && drafted.includes('用户已经在代码编辑器里写了自己的代码（较完整）'), 'the explanation is told what the answer step saw in the editor');
  for (const wanted of ['## 还差什么', '## 要改的地方', '位置：', '- 现在：', '- 改成：', '- 原因：', '## 改完之后']) assert.ok(drafted.includes(wanted), `the explanation prompt asks for: ${wanted}`);
  assert.ok(explainPrompt({ answer: code, insights: [{ no: '1', draft: 'part' }, { no: '2', draft: 'none' }] }).includes('（第 1 题部分）'));
  for (const job of [{ answer: code, insights: [{ draft: 'none', categories: [], approaches: [] }] }, { answer: '1. A' }]) assert.ok(!explainPrompt(job).includes('答题时看到'), 'nothing is claimed about an empty editor or a plain question');
});

test('the model is chosen on the directory page: new captures go to it, a record keeps its own', async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mouse-model-test-')), made = [];
  // Stands in for the real providers: answers with the name of the model it was made for.
  const createProvider = options => { made.push(options); return { ask: async prompt => prompt.includes('请给出各题的解析') ? `解析来自 ${options.model}` : `标题：${options.model} 作答\n\n1. A`, close: async () => {} }; };
  const config = { dataDir, analyze: undefined, explain: undefined, createProvider, analyzer: 'deepseek', model: 'deepseek-flash', effort: 'low', deepseekKey: 'ds-key', apiKey: 'oa-key', models: parseModels('openai:gpt-5.6-sol, openai:gpt-5.6-sol:high,deepseek:deepseek-flash') };
  const s = await start(t, config), a = await agent(s), p = await phone(s.base), sol = 'openai:gpt-5.6-sol';
  const hello = await p.until(e => e.type === 'hello');
  assert.deepEqual(hello.engines, [{ id: 'deepseek:deepseek-flash', label: 'deepseek-flash' }, { id: sol, label: 'gpt-5.6-sol' }, { id: `${sol}:high`, label: 'gpt-5.6-sol · high' }], 'the model from ANALYZER comes first; one listed twice is offered once');
  assert.equal(hello.engine, 'deepseek:deepseek-flash');
  assert.deepEqual(made.map(o => [o.analyzer, o.model, o.effort, o.openaiKey]), [['deepseek', 'deepseek-flash', 'low', 'oa-key'], ['openai', 'gpt-5.6-sol', '', 'oa-key'], ['openai', 'gpt-5.6-sol', 'high', 'oa-key']]);

  const first = await s.capture(); await a.shoot('white'); await s.app.store.whenIdle();
  assert.equal(s.app.store.job(first.id).title, 'deepseek-flash 作答'); assert.equal(s.app.store.job(first.id).engine, 'deepseek:deepseek-flash');
  assert.equal((await s.post('/api/model', { engine: 'openai:no-such-model' })).status, 400);
  assert.deepEqual(await (await s.post('/api/model', { engine: sol })).json(), { engine: sol });
  assert.equal((await p.until(e => e.type === 'engine')).engine, sol, 'every connected page hears of the change');
  assert.equal(readFileSync(path.join(dataDir, 'model.txt'), 'utf8'), sol); assert.equal((await (await s.call('/api/state')).json()).engine, sol);
  const second = await s.capture(); await a.shoot('black'); await s.app.store.whenIdle();
  assert.equal(s.app.store.job(second.id).title, 'gpt-5.6-sol 作答'); assert.equal(s.app.store.detail(s.app.store.job(second.id)).engine, sol);
  await s.post(`/api/explain?id=${first.id}`); await s.app.store.whenIdle();
  assert.equal(s.app.store.job(first.id).explanation, '解析来自 deepseek-flash', 'the explanation comes from the model that gave the answer');

  await s.app.close();
  const again = await start(t, config); assert.equal(again.app.engine.id, sol, 'the choice survives a restart');
  const fewer = await start(t, { ...config, models: [] }); assert.equal(fewer.app.engine.id, 'deepseek:deepseek-flash', 'a model that is no longer offered falls back to the first');
  await fewer.post(`/api/explain?id=${second.id}`); await fewer.app.store.whenIdle();
  assert.equal(fewer.app.store.job(second.id).explanation, '解析来自 deepseek-flash', 'and its records are explained by the current one');
  p.ws.close();

  assert.deepEqual(parseModels('openai:gpt-5.6-sol:high，codex'), [{ analyzer: 'openai', model: 'gpt-5.6-sol', effort: 'high' }, { analyzer: 'codex', model: '', effort: '' }]);
  assert.deepEqual(parseModels(undefined), []); assert.throws(() => parseModels('gpt-5.6-sol'), /MOUSE_MODELS/); assert.throws(() => parseModels('openai:gpt-5.6-sol:fast'), /MOUSE_MODELS/);
});

test('a second device sends photos, one or a batch, and they are answered and shown like a capture', async t => {
  const s = await start(t, { maxFrames: 3 }), p = await phone(s.base), incoming = path.join(s.dataDir, 'incoming');   // no capture agent is connected
  const photo = async (batch, n, color) => s.call(`/api/camera/photo?batch=${batch}&n=${n}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: await png(color) });
  const submit = (batch, photos) => s.post('/api/camera/submit', { batch, photos });
  assert.equal((await fetch(s.base + '/camera')).status, 200); assert.equal((await fetch(s.base + '/camera.js')).status, 200);
  assert.equal((await (await s.call('/api/state')).json()).maxFrames, 3);
  assert.equal((await fetch(s.base + '/api/camera/photo?batch=b1&n=0', { method: 'POST', body: await png() })).status, 401);

  assert.deepEqual(await (await photo('b1', 0)).json(), { n: 0, count: 1 });
  const one = (await (await submit('b1', [0])).json()).job;
  assert.equal(one.mode, 'camera'); assert.equal(one.status, 'analyzing'); assert.equal(one.frameCount, 1);
  const done = (await p.until(e => e.type === 'job' && e.job.status === 'done')).job;
  assert.equal(done.id, one.id); assert.equal(done.title, '第 1 次，1 张'); assert.equal(done.answer, '1. A');

  await photo('b2', 0, 'white'); await photo('b2', 1, 'black'); await photo('b2', 2, 'gray');
  assert.match((await (await photo('b2', 3)).json()).error, /最多 3 张/);
  assert.deepEqual(await (await photo('b2', 1, 'red')).json(), { n: 1, count: 3 }, 'a photo sent again replaces the earlier upload');
  assert.equal((await s.post('/api/camera/discard?batch=b2&n=0')).status, 200); assert.equal(readdirSync(incoming).length, 2);
  assert.equal((await submit('b2', [2, 0])).status, 400, 'a removed photo cannot be submitted');
  assert.equal((await submit('b2', [2, 2])).status, 400); assert.equal((await submit('b2', [])).status, 400);
  const two = (await (await submit('b2', [2, 1])).json()).job; assert.equal(two.frameCount, 2); assert.equal(two.seq, 2);
  await s.app.store.whenIdle();
  assert.equal(s.app.store.job(two.id).status, 'done'); assert.equal(readdirSync(incoming).length, 0); assert.equal(readdirSync(path.join(s.dataDir, 'images')).length, 3);
  const [gray, red] = await Promise.all([0, 1].map(async n => (await sharp(Buffer.from(await (await s.call(`/api/image?id=${two.id}&n=${n}`)).arrayBuffer())).resize(1, 1).raw().toBuffer())[0]));
  assert.ok(gray > 100 && gray < 160 && red > 200, 'the photos are kept in the order they were submitted in');
  assert.equal((await submit('b2', [2, 1])).status, 400, 'a batch is submitted once');

  assert.equal((await s.call('/api/camera/photo?batch=b3&n=0', { method: 'POST', body: 'not a picture' })).status, 400);
  await photo('b4', 0); await photo('b4', 1); assert.equal(readdirSync(incoming).length, 2);
  assert.equal((await s.post('/api/camera/discard?batch=b4')).status, 200); assert.equal(readdirSync(incoming).length, 0);
  assert.equal(answerPrompt({ mode: 'single' }), ANSWER_PROMPT + REFERENCE_PROMPT);
  assert.ok(answerPrompt({ mode: 'camera' }).startsWith('这是同一次操作中用手机或平板拍摄的照片') && !answerPrompt({ mode: 'camera' }).includes('截图'), 'the model is told these are photos');
  p.ws.close();
});

test('pairing is required everywhere and repeated wrong codes are throttled', async t => {
  const s = await start(t);
  assert.equal((await fetch(s.base + '/')).status, 200);
  assert.equal((await fetch(s.base + '/api/state')).status, 401);
  assert.equal((await fetch(s.base + '/api/source/register', { method: 'POST', body: '{}' })).status, 401);
  const stranger = await phone(s.base, 'wrong'); const [code] = await once(stranger.ws, 'close'); assert.equal(code, 1008);
  assert.equal((await s.call('/api/state')).status, 200);
  for (let i = 0; i < 30; i++) assert.equal((await fetch(s.base + '/favicon.ico')).status, 404);
  assert.equal((await s.call('/api/state')).status, 200, 'requests the browser makes on its own are not counted as wrong codes');
  for (let i = 0; i < 20; i++) await fetch(s.base + '/api/state', { headers: { Authorization: 'Bearer nope' } });
  assert.equal((await s.call('/api/state')).status, 429);
});

test('the agent reports a missing region, and its retries never get stuck on stale batches', async t => {
  const s = await start(t), a = await agent(s), p = await phone(s.base);
  await s.capture(); const command = await a.next(); await a.finish(command.batch.id, '请先点击采集端托盘图标选择截图区域');
  assert.match((await p.until(e => e.type === 'job' && e.job.status === 'failed')).job.error, /选择截图区域/);
  assert.equal((await a.finish('no-such-batch', '采集器已退出')).status, 200);
  const late = await a.frame(command.batch.id, randomUUID()); assert.equal(late.status, 200); assert.equal((await late.json()).ignored, true);
  assert.equal(readdirSync(path.join(s.dataDir, 'images')).length, 0);
  assert.equal((await s.call(`/api/frame?batchId=${command.batch.id}&frameId=x`, { method: 'POST', headers: { 'X-Client-Id': 'someone-else' }, body: await png() })).status, 400);
  p.ws.close();
});

test('an agent that outlived a server restart is adopted, and a restarted agent takes over at once', async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mouse-restart-test-'));
  const first = await start(t, { dataDir }), a = await agent(first);
  const job = await first.capture(); const { command } = await a.shoot();
  await first.app.store.whenIdle(); await first.app.close();
  const second = await start(t, { dataDir });
  assert.equal(second.app.store.job(job.id).status, 'done', 'the directory survives the restart');
  const survivor = { 'X-Client-Id': a.clientId };
  assert.equal((await second.post('/api/source/finish', { batchId: command.batch.id, error: '' }, survivor)).status, 200);
  assert.equal((await second.call('/api/source/poll?ack=old-command', { headers: survivor })).status, 200);
  assert.equal(second.app.source.online, true);
  const next = await second.capture();
  assert.equal((await (await second.call('/api/source/poll', { headers: survivor })).json()).command.type, 'capture');
  const replacement = await agent(second, 'Restarted PC');
  assert.equal(second.app.source.status().name, 'Restarted PC');
  assert.match(second.app.store.job(next.id).error, /重新连接/);
  assert.equal((await second.call('/api/source/poll', { headers: survivor })).status, 400);
  assert.equal(await replacement.poll(), null);
});

test('the task background is a text file on the computer, shared with the settings page', async t => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'mouse-prompt-test-')); mkdirSync(dataDir, { recursive: true });
  writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ systemPrompt: '旧版保存的背景', seq: 0, jobs: [] }));
  const s = await start(t, { dataDir }), a = await agent(s), file = path.join(dataDir, 'system-prompt.txt');
  assert.equal(s.app.promptFile, file); assert.equal(readFileSync(file, 'utf8'), '旧版保存的背景', 'a background saved by the earlier version is carried over');
  assert.equal((await s.post('/api/settings', { systemPrompt: 42 })).status, 400);
  assert.equal((await s.post('/api/settings', { systemPrompt: '高中数学' })).status, 200); assert.equal(readFileSync(file, 'utf8'), '高中数学');
  const one = await s.capture(); await a.shoot(); await s.app.store.whenIdle(); assert.equal(s.app.store.job(one.id).systemPrompt, '高中数学');
  writeFileSync(file, '﻿只回答选择题\r\n');   // edited in Notepad on the computer
  assert.equal((await (await s.call('/api/settings')).json()).systemPrompt, '只回答选择题');
  const two = await s.capture(); await a.shoot('black'); await s.app.store.whenIdle(); assert.equal(s.app.store.job(two.id).systemPrompt, '只回答选择题');
});

test('archiving empties the directory without deleting anything', async t => {
  const s = await start(t, { interval: 20 }), a = await agent(s);
  const job = await s.capture('burst'); await a.shoot('white'); await a.shoot('black'); const last = await a.next();
  await s.post(`/api/release?id=${job.id}`); await a.frame(last.batch.id, randomUUID(), 'gray'); await s.app.store.whenIdle();
  const p = await phone(s.base); await p.until(e => e.type === 'hello');
  assert.deepEqual(await (await s.post('/api/archive')).json(), { archived: 1 });
  await p.until(e => e.type === 'reset');
  assert.deepEqual((await (await s.call('/api/state')).json()).jobs, []); assert.deepEqual(readdirSync(path.join(s.dataDir, 'images')), []);
  const [archive] = readdirSync(path.join(s.dataDir, 'archives'));
  assert.ok(existsSync(path.join(s.dataDir, 'archives', archive, 'state.json')));
  assert.equal(readdirSync(path.join(s.dataDir, 'archives', archive, 'images')).length, 3);
  p.ws.close();
});
