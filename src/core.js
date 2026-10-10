import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export function parseCommand(input) {
  const text = String(input || '').trim();
  const question = text.match(/^(?:我要提问|请回答|请问|开始解答|提问|题问)[\s，,：:。]*(.*)$/s);
  if (question) return { type: 'question', text: question[1].replace(/^[\s，,：:。！!？?]+|[\s]+$/g, '') || '这一页题目的答案和解析' };
  const word = text.replace(/[\s，,。.!！?？]/g, '');
  if (word === '答案' || word === '全部答案') return { type: 'question', text: word };
  const mode = { 拍: 'single', 拍摄: 'single', 启动: 'five', 长程: 'long' }[word];
  if (mode) return { type: 'capture', mode };
  const type = { 停止: 'stop', 暂停播报: 'pause', 继续播报: 'resume', 取消任务: 'cancel' }[word];
  return type ? { type } : null;
}

export function samePage(a, b) {
  if (!a || !b) return false;
  if (a.digest && a.digest === b.digest) return true;
  const clean = s => (s || '').replace(/\s/g, '');
  const x = clean(a.ocr), y = clean(b.ocr);
  // Conservative: OCR must agree exactly; diagrams must be visually close too.
  if (x.length < 20 || x !== y || !a.pixels?.length || a.pixels.length !== b.pixels?.length) return false;
  const diff = a.pixels.reduce((n, p, i) => n + Math.abs(p - b.pixels[i]), 0) / a.pixels.length;
  return diff < 2;
}

const terminal = f => ['done', 'duplicate', 'failed'].includes(f.status);
export class Engine extends EventEmitter {
  constructor({ provider, stateFile, maxPending = 200 }) {
    super(); this.provider = provider; this.stateFile = stateFile; this.maxPending = maxPending;
    this.state = { batches: [], frames: [], tasks: [] }; this.controllers = new Map();
    this.worker = null; this.answerWorker = null;
    if (stateFile) {
      try { this.state = JSON.parse(readFileSync(stateFile, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw new Error(`无法读取已保存记录：${e.message}`); }
      for (const f of this.state.frames) if (!terminal(f)) { f.status = 'failed'; f.error = '上次服务中断，请重新拍摄'; }
      for (const b of this.state.batches) if (!b.notified) { b.closed = true; b.notified = true; b.captureError = '上次服务中断'; }
      for (const t of this.state.tasks) if (['queued', 'running'].includes(t.status)) { t.status = 'cancelled'; t.error = '上次服务中断'; }
    }
  }
  changed(event) {
    if (this.stateFile) { writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state)); renameSync(`${this.stateFile}.tmp`, this.stateFile); }
    if (event) this.emit('event', event);
    this.emit('event', { type: 'state', state: this.publicState() });
  }
  publicState() {
    return {
      batches: this.state.batches,
      frames: this.state.frames.map(({ path, prepared, ...f }) => ({ ...f, ocr: prepared?.ocr || '', ocrWarning: prepared?.warning })),
      tasks: this.state.tasks,
    };
  }
  startBatch(mode) {
    if (!['single', 'five', 'long'].includes(mode)) throw Error('无效拍摄模式');
    if (this.state.batches.some(b => !b.closed)) throw Error('请先停止当前拍摄');
    const b = { id: randomUUID(), mode, systemPrompt: this.state.systemPrompt || '', createdAt: new Date().toISOString(), frames: [], closed: false, notified: false };
    this.state.batches.push(b); this.changed(); return b;
  }
  addFrame(batchId, input) {
    const old = this.state.frames.find(f => f.id === input.id);
    if (old) { if (old.batchId !== batchId) throw Error('图片 ID 已属于另一批次'); return old; }
    const b = this.state.batches.find(b => b.id === batchId);
    if (!b || b.closed) throw Error('拍摄批次已关闭');
    if (this.state.frames.filter(f => !terminal(f)).length >= this.maxPending) throw Error('待处理图片已达上限，请等待分析');
    const f = { id: input.id, path: input.path, systemPrompt: b.systemPrompt || '', capturedAt: input.capturedAt || new Date().toISOString(), batchId, status: 'queued' };
    b.frames.push(f.id); this.state.frames.push(f); this.changed(); this.pump(); return f;
  }
  finishBatch(id, error) {
    const b = this.state.batches.find(b => b.id === id); if (!b) throw Error('找不到批次');
    b.closed = true; if (error) b.captureError = error;
    this.checkComplete(b); this.changed();
  }
  checkComplete(b) {
    if (!b.closed || b.notified || b.frames.some(id => !terminal(this.frame(id)))) return;
    b.notified = true;
    const failed = b.frames.filter(id => this.frame(id).status === 'failed').length;
    const incomplete = !!b.captureError || (b.mode === 'five' && b.frames.length !== 5) || b.frames.length === 0;
    this.changed({ type: 'batch.complete', batchId: b.id, failed, incomplete });
  }
  frame(id) { return this.state.frames.find(f => f.id === id); }
  pump() {
    if (this.worker) return;
    this.worker = (async () => {
      for (let f; (f = this.state.frames.find(f => f.status === 'queued'));) {
        f.status = 'processing'; this.changed();
        try {
          f.prepared = await this.provider.prepare(f);
          const prior = this.state.frames.find(p => p.id !== f.id && p.status === 'done' && (p.systemPrompt || '') === f.systemPrompt && samePage(p.prepared, f.prepared));
          if (prior) { f.status = 'duplicate'; f.duplicateOf = prior.id; f.observation = prior.observation; }
          else { f.observation = await this.provider.analyze(f); f.status = 'done'; }
        } catch (e) { f.status = 'failed'; f.error = e.message; }
        this.changed(); this.checkComplete(this.state.batches.find(b => b.id === f.batchId));
      }
    })().finally(() => { this.worker = null; if (this.state.frames.some(f => f.status === 'queued')) this.pump(); });
  }
  ask(text, { batchId, cutoff } = {}) {
    if (!text?.trim()) throw Error('问题不能为空');
    const unanswered = text === '全部答案';
    const answerOnly = unanswered || text === '答案';
    const latest = batchId ? this.state.batches.find(b => b.id === batchId) : this.state.batches.at(-1);
    const batchScope = /这批|这一批|刚才这批|所有页面|全部页面/.test(text);
    const eligible = this.state.frames.filter(f => (answerOnly || !batchId || f.batchId === batchId) && (!cutoff || f.capturedAt <= cutoff));
    const reserved = new Set(this.state.tasks.filter(t => ['queued','running'].includes(t.status)).flatMap(t => t.frameIds));
    const ids = unanswered ? eligible.filter(f => !f.answeredAt && !this.frame(f.duplicateOf)?.answeredAt && !reserved.has(f.id)).map(f => f.id) : batchScope ? eligible.filter(f => f.batchId === latest?.id).map(f => f.id) : eligible.slice(-1).map(f => f.id);
    if (!ids.length) throw Error(unanswered ? '没有尚未回答且未在处理中的图片' : '请先拍摄一张图片');
    const task = { id: randomUUID(), text, answerOnly, systemPrompt: this.state.systemPrompt || '', frameIds: ids, scope: unanswered ? 'unanswered' : batchScope ? 'batch' : 'page', status: 'queued', results: [], createdAt: new Date().toISOString() };
    this.state.tasks.push(task); this.controllers.set(task.id, new AbortController()); this.changed(); this.pumpAnswers(); return task;
  }
  cancelTask(id) {
    const targets = this.state.tasks.filter(t => (!id || t.id === id) && ['queued', 'running'].includes(t.status));
    for (const t of targets) { t.status = 'cancelled'; this.controllers.get(t.id)?.abort(); }
    this.changed({ type: 'task.cancelled', taskIds: targets.map(t => t.id) });
  }
  pumpAnswers() {
    if (this.answerWorker) return;
    this.answerWorker = (async () => {
      for (let t; (t = this.state.tasks.find(t => t.status === 'queued'));) {
        const signal = this.controllers.get(t.id).signal; t.status = 'running'; this.changed();
        try {
          while (t.frameIds.some(id => !terminal(this.frame(id)))) {
            signal.throwIfAborted(); await new Promise(r => setTimeout(r, 30));
          }
          const seen = new Set();
          for (const id of t.frameIds) {
            signal.throwIfAborted(); const f = this.frame(id); const key = f.duplicateOf || id;
            if (seen.has(key)) continue; seen.add(key);
            if (t.scope === 'unanswered' && (f.answeredAt || this.frame(key)?.answeredAt)) continue;
            let text;
            if (f.status === 'failed') text = `本页未能分析：${f.error}。请补拍。`;
            else {
              const history = this.state.tasks.filter(x => x.status === 'done' && (x.systemPrompt || '') === t.systemPrompt).slice(-3).map(x => ({ question: x.text, results: x.results }));
              try { text = await this.provider.answer(t.text, f, { signal, history, systemPrompt: t.systemPrompt, answerOnly: t.answerOnly }); }
              catch (error) {
                if (t.scope !== 'unanswered' || signal.aborted) throw error;
                t.results.push({ frameId: id, text: `本页回答失败：${error.message}`, failed: true }); this.changed(); continue;
              }
            }
            signal.throwIfAborted(); t.results.push({ frameId: id, text });
            if (f.status !== 'failed') {
              const at = new Date().toISOString();
              for (const page of this.state.frames.filter(p => (p.duplicateOf || p.id) === key)) { page.answeredAt = at; }
            }
            this.changed();
          }
          t.status = 'done'; this.changed({ type: 'answer', taskId: t.id, results: t.results });
        } catch (e) { if (t.status !== 'cancelled') { t.status = 'failed'; t.error = e.message; } this.changed(); }
        finally { this.controllers.delete(t.id); }
      }
    })().finally(() => { this.answerWorker = null; if (this.state.tasks.some(t => t.status === 'queued')) this.pumpAnswers(); });
  }
  async whenIdle() { while (this.worker || this.answerWorker) await Promise.all([this.worker, this.answerWorker]); }
}
