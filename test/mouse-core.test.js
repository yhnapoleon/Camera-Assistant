import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobStore, parseMatch, sameFrame, splitAnswer } from '../src/mouse-core.js';
import { COMPANY_PROBLEMS, COMPANY_PROBLEM_LIST, PROBLEMS, PROBLEM_LIST } from '../src/problem-list.js';

const tick = () => new Promise(r => setImmediate(r));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async check => { for (let i = 0; i < 300; i++) { if (check()) return; await wait(5); } throw Error('等待超时'); };
const screen = shade => new Uint8Array(64 * 64).fill(shade);
const frame = (n, shade = n) => ({ id: `frame-${n}`, path: `shot-${n}.jpg`, pixels: screen(shade) });
// A store with a stand-in capture agent: requested screenshots are collected, the test delivers them.
function setup(options = {}) {
  const shots = [], store = new JobStore({ analyze: async j => `标题：第 ${j.seq} 次\n\n${j.frames.map(f => f.path).join(' ')}`, requestShot: shot => shots.push(shot), ...options });
  return { store, shots };
}

test('the title line feeds the directory; answers without one fall back to their first line', () => {
  assert.deepEqual(splitAnswer('标题：导数选择题 3–5\n\n3. B\n4. 29'), { title: '导数选择题 3–5', answer: '3. B\n4. 29' });
  assert.deepEqual(splitAnswer('**标题：** 英语完形\n正文'), { title: '英语完形', answer: '正文' });
  assert.deepEqual(splitAnswer('## 第 1 题\n答案 A'), { title: '第 1 题', answer: '## 第 1 题\n答案 A' });
  assert.equal(splitAnswer('标题：只有标题').answer, '标题：只有标题');
  assert.deepEqual(splitAnswer('  \n'), { title: '', answer: '' });
});

const code = '```cpp\nint main() {\n    // 思路：这一行在代码里，不是标签\n}\n```';
test('a programming answer is split into the approach level and the code', () => {
  const one = splitAnswer(`标题：LRU 缓存\n\n类型：代码题\n代码：\n${code}\n**题意：** 容量按字节计算的 LRU 缓存\n分类：链表、哈希表，设计\n思路：哈希表 + 双向链表、哨兵节点`);
  assert.equal(one.kind, 'code'); assert.equal(one.title, 'LRU 缓存'); assert.equal(one.answer, code);
  assert.deepEqual(one.insights, [{ summary: '容量按字节计算的 LRU 缓存', categories: ['链表', '哈希表', '设计'], approaches: ['哈希表 + 双向链表', '哨兵节点'] }]);
  const two = splitAnswer(`标题：两道题\n\n题号：1\n代码：\n${code}\n分类：链表\n思路：迭代\n题号：2\n${code}\n思路：拓扑排序`);
  assert.deepEqual(two.insights, [{ no: '1', categories: ['链表'], approaches: ['迭代'] }, { no: '2', categories: [], approaches: ['拓扑排序'] }]);
  assert.equal(two.answer, `1.\n${code}\n2.\n${code}`);
  assert.equal(splitAnswer(`标题：两道题\n\n${code}\n分类：链表\n${code}\n分类：图`).insights.length, 2, 'without numbers a repeated label starts the next problem');
  assert.equal(splitAnswer('标题：选择题\n\n1. B\n2. 思路：这是普通答案').kind, undefined, 'ordinary answers stay one level');
  assert.equal(splitAnswer('标题：没有代码\n\n分类：图\n思路：拓扑排序').kind, undefined, 'tags without code are left as plain text');
});

test('a programming answer records how much of their own code the user already had', () => {
  const answered = state => splitAnswer(`标题：两数之和\n\n类型：代码题\n已有代码：${state}\n代码：\n${code}\n题意：找出和为目标值的两个下标\n分类：哈希表\n思路：一次遍历`);
  assert.deepEqual(answered('较完整').insights, [{ draft: 'full', summary: '找出和为目标值的两个下标', categories: ['哈希表'], approaches: ['一次遍历'] }]);
  assert.equal(answered('较完整').answer, code, 'the line is taken out of the code like the other labels');
  assert.equal(answered('“部分”，主体还没写完').insights[0].draft, 'part'); assert.equal(answered('无').insights[0].draft, 'none'); assert.equal(answered('无（只有模板）').insights[0].draft, 'none');
  const two = splitAnswer(`标题：两道题\n\n已有代码：部分\n${code}\n思路：迭代\n已有代码：无\n${code}\n思路：拓扑排序`);
  assert.deepEqual(two.insights.map(i => [i.draft, i.approaches[0]]), [['part', '迭代'], ['none', '拓扑排序']], 'without numbers the line starts the next problem');
});

test('the problem list holds AlgoMooc 200 and the rest of Hot 100, each problem once', () => {
  assert.equal(PROBLEMS.size, 203); assert.equal([...PROBLEMS.values()].filter(p => p.hot).length, 100);
  assert.equal(PROBLEM_LIST.split('\n').reduce((n, line) => n + line.split('、').length, 0), 203);
  assert.deepEqual(PROBLEMS.get('146'), { no: '146', title: 'LRU 缓存', group: '链表', hot: true });
  assert.deepEqual(PROBLEMS.get('1851'), { no: '1851', title: '包含每个查询的最小区间', group: '区间', hot: false });
  assert.ok(PROBLEM_LIST.includes('146 LRU 缓存、') && !PROBLEM_LIST.includes('*'));
});

test('the match follows from whether the closest listed solution has to change; the title comes from the list', () => {
  assert.deepEqual(parseMatch('候选：146、460\n比较：淘汰规则相同，只是读入方式不同\n改动：不用改\n结论：146'), [{ relation: 'same', problem: '146. LRU 缓存', hot: true, note: '' }]);
  assert.deepEqual(parseMatch('**改动：** “要改：数组首尾相连”\n**结论：** 739. 写错的题名'), [{ relation: 'variant', problem: '739. 每日温度', hot: true, note: '数组首尾相连' }]);
  assert.deepEqual(parseMatch('候选：150\n改动：用不上\n结论：150'), [{ relation: 'none', problem: '150. 逆波兰表达式求值', hot: false, note: '' }]);
  assert.deepEqual(parseMatch('候选：无\n改动：用不上\n结论：无'), [{ relation: 'none', problem: '', hot: false, note: '' }]);
  assert.deepEqual(parseMatch('改动：不用改\n结论：307'), [{ relation: 'none', problem: '', hot: false, note: '' }], 'a problem outside the list is not a match');
  assert.equal(parseMatch('结论：146')[0].relation, 'none', 'nothing is claimed without the line it rests on');
  assert.deepEqual(parseMatch('题号：1\n候选：206\n改动：不用改\n结论：206\n题号：2\n候选：207、210\n改动：要改，多求一步\n结论：207').map(o => [o.relation, o.problem, o.note]), [['same', '206. 反转链表', ''], ['variant', '207. 课程表', '多求一步']]);
  assert.deepEqual(parseMatch('没有按格式回答'), []);
});

test('company problems are numbered E1 on, each with its company and what it asks, apart from the LeetCode numbers', () => {
  assert.equal(COMPANY_PROBLEMS.size, 30); assert.deepEqual([...COMPANY_PROBLEMS.keys()], Array.from({ length: 30 }, (_, i) => `E${i + 1}`));
  for (const p of COMPANY_PROBLEMS.values()) { assert.ok(p.title && p.company && p.gist.length >= 20, `${p.no} is complete`); assert.ok(!PROBLEMS.has(p.no)); }
  assert.equal(new Set([...COMPANY_PROBLEMS.values()].map(p => p.title)).size, 30, 'each problem once');
  assert.ok(![...PROBLEMS.values()].some(l => [...COMPANY_PROBLEMS.values()].some(c => c.title === l.title)), 'none repeats a listed LeetCode problem');
  assert.deepEqual([COMPANY_PROBLEMS.get('E1').title, COMPANY_PROBLEMS.get('E1').company], ['合并嵌套 JSON', '字节']);
  assert.equal(COMPANY_PROBLEM_LIST.split('\n').length, 30); assert.ok(COMPANY_PROBLEM_LIST.startsWith('E1 合并嵌套 JSON｜字节｜给两个嵌套的 JSON'));
});

test('a company problem is matched by its E number, named by its title and marked with its company', async () => {
  assert.deepEqual(parseMatch('候选：E1、E7\n比较：合并规则相同\n改动：不用改\n结论：E1'), [{ relation: 'same', problem: '合并嵌套 JSON', hot: false, note: '', company: '字节' }]);
  assert.deepEqual(parseMatch('改动：“要改：数字改为覆盖”\n**结论：** e1（合并嵌套 JSON）'), [{ relation: 'variant', problem: '合并嵌套 JSON', hot: false, note: '数字改为覆盖', company: '字节' }]);
  assert.deepEqual(parseMatch('改动：不用改\n结论：E10'), [{ relation: 'same', problem: '带过期时间的 LRU 缓存', hot: false, note: '', company: '字节' }], 'E10 is not LeetCode 10');
  assert.deepEqual(parseMatch('改动：不用改\n结论：E146'), [{ relation: 'none', problem: '', hot: false, note: '' }], 'an E number that is not listed is no match, and not LeetCode 146 either');
  assert.deepEqual(parseMatch('改动：用不上\n结论：E3'), [{ relation: 'none', problem: '圆环回原点', hot: false, note: '', company: '字节' }]);
  assert.deepEqual(parseMatch('题号：1\n改动：不用改\n结论：E2\n题号：2\n改动：不用改\n结论：146').map(o => [o.problem, o.company]), [['小于 n 的最大数', '字节'], ['146. LRU 缓存', undefined]]);
  const { store, shots } = setup({ analyze: async () => `标题：合并 JSON\n\n类型：代码题\n代码：\n${code}\n分类：递归、哈希表\n思路：深度优先`, match: async () => '候选：E1\n改动：不用改\n结论：E1' });
  const job = store.create(); store.frame(shots[0], frame(1)); await store.whenIdle();
  assert.equal(store.summary(job).snippet, '原题 合并嵌套 JSON（字节手撕） · 递归 · 哈希表 · 深度优先');
});

test('the code is delivered first; the match with the problem list is asked from the finished answer and added later', async t => {
  const analyze = async () => `标题：LRU\n\n类型：代码题\n代码：\n${code}\n分类：链表、设计\n思路：哈希表 + 双向链表`;
  let open, given; const gate = new Promise(r => { open = r; }), events = [];
  const { store, shots } = setup({ analyze, match: async j => { given = { status: j.status, answer: j.answer, tags: j.insights[0].categories }; await gate; return '候选：146\n比较：相同\n改动：不用改\n结论：146'; } });
  store.on('job', j => events.push([j.status, j.matchStatus, j.insights?.[0].origin?.relation]));
  const job = store.create(); store.frame(shots[0], frame(1)); await until(() => job.matchStatus === 'running');
  assert.equal(job.status, 'done'); assert.equal(job.answer, code); assert.equal(job.insights[0].origin, undefined);
  assert.deepEqual(given, { status: 'done', answer: code, tags: ['链表', '设计'] }); assert.equal(store.summary(job).snippet, '链表 · 设计 · 哈希表 + 双向链表');
  open(); await store.whenIdle();
  assert.deepEqual(job.insights[0].origin, { relation: 'same', problem: '146. LRU 缓存', hot: true, note: '' });
  assert.equal(store.summary(job).snippet, '原题 146. LRU 缓存 · 链表 · 设计 · 哈希表 + 双向链表');
  assert.deepEqual(events.slice(2), [['done', 'running', undefined], ['done', 'done', 'same']]);

  const failing = setup({ analyze, match: async () => { throw Error('模型超时'); } }), lost = failing.store.create();
  failing.store.frame(failing.shots[0], frame(1)); await failing.store.whenIdle();
  assert.equal(lost.status, 'done'); assert.equal(lost.answer, code); assert.equal(lost.matchStatus, 'failed'); assert.equal(lost.matchError, '模型超时');
  let asked = 0; const plain = setup({ match: async () => { asked++; return '改动：用不上\n结论：无'; } }), other = plain.store.create();
  plain.store.frame(plain.shots[0], frame(1)); await plain.store.whenIdle();
  assert.equal(other.status, 'done'); assert.equal(asked, 0, 'only programming answers are compared'); assert.equal(other.matchStatus, undefined);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'mouse-core-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  writeFileSync(stateFile, JSON.stringify({ seq: 1, jobs: [{ id: 'cut', seq: 1, status: 'done', kind: 'code', frames: [], answer: code, insights: [{ categories: [], approaches: [] }], matchStatus: 'running' }] }));
  assert.equal(new JobStore({ stateFile }).job('cut').matchStatus, 'failed', 'a comparison cut off by a restart does not stay "running"');
});

test('a blinking caret is the same screen, a changed line of text is not', () => {
  const page = screen(255), caret = screen(255), line = screen(255);
  caret[10 * 64 + 10] = 0; for (let x = 8; x < 40; x++) line[20 * 64 + x] = line[21 * 64 + x] = 0;
  assert.equal(sameFrame(page, screen(255)), true); assert.equal(sameFrame(page, caret), true);
  assert.equal(sameFrame(page, line), false); assert.equal(sameFrame(page, screen(255).subarray(1)), false); assert.equal(sameFrame(undefined, page), false);
});

test('a click asks for one screenshot, answers it, and keeps long texts out of list entries', async () => {
  const { store, shots } = setup(); const events = []; store.on('job', j => events.push(j.status));
  const job = store.create(); assert.equal(store.capturing, job); assert.equal(shots.length, 1); assert.equal(store.expects(shots[0]), true);
  assert.equal(store.frame(shots[0], frame(1)), true); assert.equal(store.capturing, undefined);
  await store.whenIdle();
  assert.deepEqual(events, ['capturing', 'analyzing', 'done']); assert.equal(shots.length, 1);
  assert.equal(store.detail(job).answer, 'shot-1.jpg'); assert.equal(store.detail(job).frames, undefined); assert.equal(store.detail(job).frameCount, 1);
  const summary = store.summary(job);
  assert.equal(summary.answer, undefined); assert.equal(summary.title, '第 1 次'); assert.equal(summary.snippet, 'shot-1.jpg'); assert.equal(summary.hasExplanation, false);
  assert.equal(store.expects(shots[0]), false); assert.throws(() => store.frame(shots[0], frame(2)), /已结束/);
});

test('pictures handed in ready-made are answered without anything being captured', async () => {
  const { store, shots } = setup(); const events = []; store.on('job', j => events.push(j.status));
  const job = store.submit([{ id: 'a', path: 'photo-1.jpg' }, { id: 'b', path: 'photo-2.jpg', capturedAt: '2026-10-10T04:00:00.000Z' }]);
  assert.equal(job.mode, 'camera'); assert.equal(job.status, 'analyzing'); assert.equal(job.seq, 1); assert.equal(store.capturing, undefined);
  await store.whenIdle();
  assert.deepEqual(events, ['analyzing', 'done']); assert.equal(shots.length, 0);
  assert.equal(job.answer, 'photo-1.jpg photo-2.jpg'); assert.equal(store.summary(job).frameCount, 2); assert.equal(job.frames[1].capturedAt, '2026-10-10T04:00:00.000Z');
  assert.equal(store.create().seq, 2, 'captures and handed-in pictures share one numbering');
});

test('a record keeps the model that was chosen when it was made', async () => {
  let chosen = 'deepseek:deepseek-flash'; const asked = [];
  const { store, shots } = setup({ engine: () => chosen, analyze: async j => { asked.push(j.engine); return '答案'; } });
  const first = store.create(); chosen = 'openai:gpt-5.6-sol'; store.frame(shots[0], frame(1));
  const second = store.submit([{ id: 'a', path: 'photo-1.jpg' }]); await store.whenIdle();
  assert.deepEqual(asked, ['deepseek:deepseek-flash', 'openai:gpt-5.6-sol'], 'a change of model does not reach a capture already under way');
  assert.equal(store.summary(first).engine, 'deepseek:deepseek-flash'); assert.equal(store.detail(second).engine, 'openai:gpt-5.6-sol');
  assert.equal(setup().store.create().engine, undefined);
});

test('analyses run in parallel up to the limit and a failure does not stop the queue', async () => {
  let running = 0, peak = 0;
  const { store, shots } = setup({ concurrency: 2, analyze: async j => { running++; peak = Math.max(peak, running); await tick(); await tick(); running--; if (j.seq === 2) throw Error('模型超时'); return '答案'; } });
  const jobs = [1, 2, 3, 4].map(n => { const j = store.create(); store.frame(shots.at(-1), frame(n)); return j; });
  await store.whenIdle();
  assert.equal(peak, 2);
  assert.deepEqual(jobs.map(j => j.status), ['done', 'failed', 'done', 'done']); assert.equal(jobs[1].error, '模型超时');
});

test('a missing screenshot times out and is withdrawn; a late one within the window is still answered', async () => {
  const { store, shots } = setup({ captureTimeout: 20 }); const expired = []; store.on('expired', shot => expired.push(shot));
  const job = store.create(); await wait(60);
  assert.equal(job.status, 'failed'); assert.equal(job.timedOut, true); assert.deepEqual(expired, shots);
  store.frame(shots[0], frame(1)); await store.whenIdle();
  assert.equal(job.status, 'done'); assert.equal(job.error, undefined); assert.equal(job.timedOut, undefined);
  const other = store.create(); await wait(60); store.lateWindow = 0; assert.equal(store.expects(shots[1]), false); assert.equal(other.status, 'failed');
});

test('the capture agent closing a batch without a frame fails the job with its reason', async () => {
  const { store, shots } = setup();
  const job = store.create(); store.shotEnded(shots[0], '请先点击采集端托盘图标选择截图区域');
  assert.equal(job.status, 'failed'); assert.match(job.error, /选择截图区域/); assert.equal(store.expects(shots[0]), false);
  const sent = store.create(); store.frame(shots[1], frame(1)); store.shotEnded(shots[1], '');
  assert.equal(sent.status, 'analyzing'); await store.whenIdle();
  const offline = new JobStore({ analyze: async () => '答案', requestShot: () => { throw Error('请先在另一台电脑启动屏幕采集器'); } }).create();
  assert.equal(offline.status, 'failed'); assert.match(offline.error, /屏幕采集器/);
});

test('a long press takes screenshots one after another until release and answers them together', async () => {
  const { store, shots } = setup({ interval: 15 });
  const job = store.create('burst'); assert.equal(job.mode, 'burst'); assert.equal(shots.length, 1);
  await wait(50); assert.equal(shots.length, 1, 'the next screenshot waits for the previous one');
  assert.equal(store.frame(shots[0], frame(1, 10)), true); await until(() => shots.length === 2);
  assert.equal(store.frame(shots[1], frame(2, 10)), false, 'an unchanged screen is not kept twice'); await until(() => shots.length === 3);
  assert.equal(store.frame(shots[2], frame(3, 200)), true); await until(() => shots.length === 4);
  store.release(job.id); assert.equal(job.status, 'capturing', 'the screenshot already requested is waited for');
  store.frame(shots[3], frame(4, 90)); assert.equal(job.status, 'analyzing');
  await wait(40); await store.whenIdle();
  assert.equal(shots.length, 4, 'nothing is requested after release');
  assert.equal(job.status, 'done'); assert.equal(job.shots, 4); assert.equal(job.answer, 'shot-1.jpg shot-3.jpg shot-4.jpg'); assert.equal(store.summary(job).frameCount, 3);
});

test('a long press ends by itself at the frame limit, when the phone goes silent, and survives a lost screenshot', async () => {
  const capped = setup({ interval: 1, maxFrames: 3 }), a = capped.store.create('burst');
  for (let n = 0; a.status === 'capturing'; n++) { await until(() => capped.shots.length > n); capped.store.frame(capped.shots[n], frame(n, n * 60)); }
  await capped.store.whenIdle(); assert.equal(a.frames.length, 3); assert.equal(a.capped, true); assert.equal(a.status, 'done');

  const silent = setup({ interval: 5, holdTimeout: 40 }), b = silent.store.create('burst');
  silent.store.frame(silent.shots[0], frame(1)); await wait(25); silent.store.hold(b.id); assert.equal(b.status, 'capturing');
  await until(() => silent.shots.length === 2); silent.store.frame(silent.shots[1], frame(2, 99));
  await until(() => silent.shots.length === 3); await wait(320);   // no more "hold" from the phone: the burst is over
  silent.store.frame(silent.shots[2], frame(3, 180)); assert.equal(b.status, 'analyzing'); await wait(30); assert.equal(silent.shots.length, 3);
  await silent.store.whenIdle(); assert.equal(b.status, 'done'); assert.equal(b.frames.length, 3);

  const lost = setup({ interval: 5, captureTimeout: 30 }), c = lost.store.create('burst');
  lost.store.frame(lost.shots[0], frame(1)); await until(() => c.status === 'done');
  assert.equal(c.answer, 'shot-1.jpg', 'what was captured before the agent went quiet is answered');
  const empty = setup(), d = empty.store.create('burst'); empty.store.release(d.id); empty.store.shotEnded(empty.shots[0], '');
  assert.equal(d.status, 'failed');
});

test('the explanation is written on request, once, and can be retried after a failure', async () => {
  let calls = 0, fail = true;
  const { store, shots } = setup({ explain: async j => { calls++; await tick(); if (fail) throw Error('模型超时'); return ` 解析：${j.answer} `; } });
  const job = store.create(); assert.throws(() => store.explain(job.id), /还没有答案/); assert.throws(() => store.explain('nope'), /还没有答案/);
  store.frame(shots[0], frame(1)); await store.whenIdle(); assert.equal(calls, 0);
  store.explain(job.id); assert.equal(job.explainStatus, 'running'); store.explain(job.id); await store.whenIdle();
  assert.equal(calls, 1); assert.equal(job.explainStatus, 'failed'); assert.equal(job.explainError, '模型超时'); assert.equal(store.summary(job).hasExplanation, false);
  fail = false; store.explain(job.id); await store.whenIdle(); store.explain(job.id); await store.whenIdle();
  assert.equal(calls, 2); assert.equal(job.explanation, '解析：shot-1.jpg'); assert.equal(job.explainError, undefined);
  assert.equal(store.summary(job).explanation, undefined); assert.equal(store.summary(job).hasExplanation, true); assert.equal(store.detail(job).explanation, '解析：shot-1.jpg');
});

test('records survive a restart, older single-image records still open, and clearing cancels what is running', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mouse-core-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json'); let aborted = false;
  writeFileSync(stateFile, JSON.stringify({ systemPrompt: '旧背景', seq: 1, jobs: [{ id: 'old', seq: 1, status: 'done', createdAt: '2026-10-09T13:00:00.000Z', frameId: 'f0', path: 'old.jpg', title: '旧记录', answer: '答案' }] }));
  const analyze = (j, { signal }) => j.seq === 2 ? Promise.resolve('标题：保留\n\n答案') : new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('已取消')); }));
  let made = setup({ stateFile, analyze, prompt: () => '背景' });
  assert.deepEqual(made.store.state.jobs[0].frames.map(f => f.path), ['old.jpg']); assert.equal(made.store.state.jobs[0].path, undefined); assert.equal(made.store.detail(made.store.state.jobs[0]).frameCount, 1);
  const first = made.store.create(); made.store.frame(made.shots[0], frame(1)); await made.store.whenIdle();
  const second = made.store.create(); made.store.frame(made.shots[1], frame(2)); made.store.create('burst');
  made = setup({ stateFile, analyze });
  assert.deepEqual(made.store.state.jobs.map(j => j.status), ['done', 'done', 'failed', 'failed']);
  assert.match(made.store.state.jobs[2].error, /上次服务中断/); assert.equal(made.store.job(first.id).systemPrompt, '背景'); assert.equal(made.store.job(second.id).frames.length, 1);
  const running = made.store.create(); made.store.frame(made.shots[0], frame(5)); assert.equal(running.seq, 5);
  let reset = 0; made.store.on('reset', () => reset++);
  const removed = made.store.clear(); await made.store.whenIdle();
  assert.equal(aborted, true); assert.equal(removed.length, 5); assert.equal(reset, 1);
  assert.equal(made.store.state.jobs.length, 0); assert.equal(made.store.create().seq, 1);
});
