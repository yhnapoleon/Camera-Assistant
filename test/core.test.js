import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, parseCommand, samePage } from '../src/core.js';

const tick = () => new Promise(r => setImmediate(r));
const provider = () => ({ prepare: async f => ({ digest: f.path, ocr: '', pixels: [] }), analyze: async f => `观察 ${f.path}`, answer: async (q, f) => `${q}: ${f.observation}` });

test('commands require exact words, questions retain their content', () => {
  assert.deepEqual(parseCommand('启动。'), { type: 'capture', mode: 'five' });
  assert.equal(parseCommand('不要启动'), null);
  assert.equal(parseCommand('停止是什么意思'), null);
  assert.deepEqual(parseCommand('提问，请告知这一页题目的答案和解析'), { type: 'question', text: '请告知这一页题目的答案和解析' });
});
test('OCR alone cannot collapse different diagrams or empty text', () => {
  const base = { digest: 'a', ocr: '这是一道完整的题目请根据图表选择正确答案', pixels: [0, 0] };
  assert.equal(samePage(base, { ...base, digest: 'b', pixels: [255, 255] }), false);
  assert.equal(samePage({ digest: 'a', ocr: '' }, { digest: 'b', ocr: '' }), false);
  assert.equal(samePage(base, { ...base, digest: 'b' }), true);
});
test('processing is serial, silent, deduplicated and completion is emitted once after close', async () => {
  let active = 0, peak = 0, calls = 0;
  const p = provider();
  p.analyze = async f => { active++; peak = Math.max(peak, active); calls++; await tick(); active--; return f.path; };
  const e = new Engine({ provider: p });
  const events = []; e.on('event', v => events.push(v));
  const b = e.startBatch('five');
  e.addFrame(b.id, { id: 'one', path: 'same' });
  e.addFrame(b.id, { id: 'one', path: 'same' });
  e.addFrame(b.id, { id: 'two', path: 'same' });
  await e.whenIdle();
  assert.equal(events.filter(x => x.type === 'batch.complete').length, 0);
  e.finishBatch(b.id); e.finishBatch(b.id);
  assert.equal(peak, 1); assert.equal(calls, 1);
  assert.equal(b.frames.length, 2);
  assert.equal(e.state.frames[1].status, 'duplicate');
  assert.equal(events.filter(x => x.type === 'batch.complete').length, 1);
  assert.equal(events.some(x => x.type === 'answer'), false);
});
test('question freezes received batch and waits for analysis, excluding future captures', async () => {
  const e = new Engine({ provider: provider() }); const b = e.startBatch('long');
  e.addFrame(b.id, { id: 'a', path: 'page1' });
  const task = e.ask('请解答这批所有题目');
  e.addFrame(b.id, { id: 'b', path: 'page2' });
  await e.whenIdle();
  assert.deepEqual(task.frameIds, ['a']);
  assert.equal(task.status, 'done');
  assert.match(task.results[0].text, /page1/);
});
test('one failed frame does not kill worker or falsely report all successful', async () => {
  const p = provider(); p.analyze = async f => { if (f.path === 'bad') throw Error('bad image'); return 'ok'; };
  const e = new Engine({ provider: p }); let completion;
  e.on('event', v => { if (v.type === 'batch.complete') completion = v; });
  const b = e.startBatch('long');
  e.addFrame(b.id, { id: 'a', path: 'bad' }); e.addFrame(b.id, { id: 'b', path: 'good' }); e.finishBatch(b.id);
  await e.whenIdle(); assert.equal(completion.failed, 1); assert.equal(e.state.frames[1].status, 'done');
});
test('cancelling queued question prevents a later answer', async () => {
  const e = new Engine({ provider: provider() }); const b = e.startBatch('single');
  e.addFrame(b.id, { id: 'a', path: 'page1' });
  const t = e.ask('解释这一页'); e.cancelTask(t.id);
  await e.whenIdle(); assert.equal(t.status, 'cancelled'); assert.equal(t.results.length, 0);
});
test('question cutoff excludes newer frames uploaded while the question waited', async () => {
  const e = new Engine({ provider: provider() }); const b = e.startBatch('long');
  e.addFrame(b.id, { id: 'old', path: 'one', capturedAt: '2026-09-24T01:00:00.000Z' });
  e.addFrame(b.id, { id: 'new', path: 'two', capturedAt: '2026-09-24T01:00:02.000Z' });
  const t = e.ask('这一批所有题目', { batchId: b.id, cutoff: '2026-09-24T01:00:01.000Z' });
  await e.whenIdle(); assert.deepEqual(t.frameIds, ['old']);
});

test('task background is frozen per batch and question, and dedup does not reuse another background', async () => {
  const seen = [], answers = [];
  const p = provider();
  p.analyze = async f => { seen.push(f.systemPrompt); return f.systemPrompt; };
  p.answer = async (q, f, options) => { answers.push(options.systemPrompt); return options.systemPrompt; };
  const e = new Engine({ provider: p });
  e.state.systemPrompt = '数学背景';
  const first = e.startBatch('single');
  e.state.systemPrompt = '物理背景';
  e.addFrame(first.id, { id: 'a', path: 'same-image' }); e.finishBatch(first.id);
  await e.whenIdle();
  const second = e.startBatch('single');
  e.addFrame(second.id, { id: 'b', path: 'same-image' }); e.finishBatch(second.id);
  const task = e.ask('这一页的答案');
  e.state.systemPrompt = '新背景';
  await e.whenIdle();
  assert.deepEqual(seen, ['数学背景', '物理背景']);
  assert.deepEqual(answers, ['物理背景']);
  assert.equal(task.systemPrompt, '物理背景');
  assert.equal(e.frame('b').status, 'done');
});

test('longer question triggers and standalone request work without matching ordinary conversation', () => {
  assert.deepEqual(parseCommand('请回答，这一批的答案'),{type:'question',text:'这一批的答案'});
  assert.deepEqual(parseCommand('我要提问，第三题怎么做'),{type:'question',text:'第三题怎么做'});
  assert.deepEqual(parseCommand('开始解答。'),{type:'question',text:'这一页题目的答案和解析'});
  assert.deepEqual(parseCommand('题问，这页答案'),{type:'question',text:'这页答案'});
  assert.equal(parseCommand('不要开始解答'),null);
  assert.equal(parseCommand('我还没想好要不要提问'),null);
});

test('please-ask trigger accepts a question or defaults to current page', () => {
  assert.deepEqual(parseCommand('请问，这一页答案是什么？'), {type:'question',text:'这一页答案是什么？'});
  assert.deepEqual(parseCommand('请问。'), {type:'question',text:'这一页题目的答案和解析'});
  assert.equal(parseCommand('不要说请问'), null);
});

test('short commands select latest and unanswered across batches, skipping successful answers',async()=>{
 assert.deepEqual(parseCommand('拍。'),{type:'capture',mode:'single'});
 assert.deepEqual(parseCommand('答案'),{type:'question',text:'答案'});
 assert.deepEqual(parseCommand('全部答案'),{type:'question',text:'全部答案'});
 const p=provider(), calls=[];p.answer=async(q,f,o)=>{calls.push(f.id);assert.equal(o.answerOnly,true);return 'A，完整选项';};
 const e=new Engine({provider:p});
 for(const id of ['a','b']){const batch=e.startBatch('single');e.addFrame(batch.id,{id,path:id});e.finishBatch(batch.id);await e.whenIdle();}
 const latest=e.ask('答案');await e.whenIdle();assert.deepEqual(latest.frameIds,['b']);
 const all=e.ask('全部答案',{batchId:e.state.batches.at(-1).id});await e.whenIdle();assert.deepEqual(all.frameIds,['a']);assert.deepEqual(calls,['b','a']);
 assert.throws(()=>e.ask('全部答案'),/没有尚未回答/);
});

test('unanswered queue continues after failure and retries only failed pages',async()=>{
 const p=provider();let fail=true;p.answer=async(q,f)=>{if(f.id==='a'&&fail)throw Error('network');return '答案';};
 const e=new Engine({provider:p});const b=e.startBatch('long');for(const id of ['a','b'])e.addFrame(b.id,{id,path:id});e.finishBatch(b.id);await e.whenIdle();
 const task=e.ask('全部答案');assert.throws(()=>e.ask('全部答案'),/没有尚未回答/);await e.whenIdle();
 assert.equal(task.results.length,2);assert.equal(e.frame('a').answeredAt,undefined);assert.ok(e.frame('b').answeredAt);
 fail=false;const retry=e.ask('全部答案');assert.deepEqual(retry.frameIds,['a']);await e.whenIdle();assert.ok(e.frame('a').answeredAt);
});
