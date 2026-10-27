import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { COMPANY_PROBLEMS, PROBLEMS } from './problem-list.js';
import { parseLesson } from './lesson.js';

const active = j => ['capturing', 'analyzing'].includes(j.status);
const now = () => new Date().toISOString();
const plain = s => String(s || '').replace(/^[#>\s*-]+/, '').replace(/[*`]/g, '').trim();
const snippet = text => String(text || '').split(/\r?\n/).map(plain).filter(Boolean).join(' ').slice(0, 90);

// The model is asked to open with "标题：…" for the directory page; fall back to its first line when it does not.
export function splitAnswer(text) {
  const lesson = parseLesson(text); if (lesson) return lesson;
  const lines = String(text || '').trim().split(/\r?\n/);
  const first = lines.findIndex(l => l.trim());
  if (first < 0) return { title: '', answer: '' };
  const titled = lines[first].match(/^[#*\s]*标题\**\s*[:：]\s*(.+)$/);
  const rest = lines.slice(first + 1).join('\n').trim();
  const base = titled && rest ? { title: plain(titled[1]).slice(0, 60), answer: rest } : { title: plain(lines[first]).slice(0, 60), answer: lines.join('\n').trim() };
  return { ...base, ...codeAnswer(base.answer) };
}

const tags = value => plain(value).split(/[、，,；;/|｜]+/).map(s => s.trim()).filter(Boolean).slice(0, 6);
// How much of their own code the user had in the editor when the screenshot was taken: 无 / 部分 / 较完整.
// From 'part' on, the answer is the user's code completed and corrected, not a solution written from scratch.
const draft = value => /部分|不完整/.test(value) ? 'part' : /完整/.test(value) ? 'full' : 'none';
// A programming problem is answered with its code and labelled lines about it. The lines are taken out of the text
// and shown first, as their own level. How the problem relates to the problem list is not part of this answer:
// it is asked afterwards, about the finished solution (see run).
function codeAnswer(answer) {
  const found = [], body = []; let fenced = false, current;
  for (const line of answer.split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = !fenced && line.match(/^[\s>*#-]*(类型|题号|已有代码|代码|题意|分类|思路)\**\s*[:：]\s*(.*)$/);
    if (!m) { body.push(line); continue; }
    const key = { 题号: 'no', 已有代码: 'draft', 题意: 'summary', 分类: 'categories', 思路: 'approaches' }[m[1]]; if (!key) continue;
    if (!current || key === 'no' || current[key] !== undefined) { current = {}; found.push(current); }   // a repeated label starts the next problem
    if (key === 'no') { current.no = plain(m[2]); body.push(`${current.no}.`); }
    else current[key] = key === 'summary' ? plain(m[2]) : key === 'draft' ? draft(m[2]) : tags(m[2]);
  }
  const code = body.join('\n').trim();
  return found.length && code.includes('```') ? { kind: 'code', insights: found.map(i => ({ categories: [], approaches: [], ...i })), answer: code } : {};
}
// The comparison with the problem list, one group of lines per problem, in the order of the problems. The model
// is not asked for "原题" or "变式": to it a retold problem is a 变式 too. It says which listed problem is closest
// (结论) and whether that problem's standard solution would have to be changed (改动); the label follows from that.
// The title comes from the list, and a number that is not on the list is no match. A company problem (E1, E2, …)
// has no LeetCode number to show: it is named by its title, and the company that asks it goes with the result.
export function parseMatch(text) {
  const found = []; let change = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^[\s>*#-]*(改动|结论)\**\s*[:：]\s*(.+)$/); if (!m) continue;
    if (m[1] === '改动') { change = plain(m[2]).replace(/^[“"「]|[”"」。.]$/g, ''); continue; }
    const id = m[2].match(/\bE\d+\b/i)?.[0].toUpperCase(), company = COMPANY_PROBLEMS.get(id), listed = id ? company : PROBLEMS.get(m[2].match(/\d+/)?.[0]);
    const relation = !listed ? 'none' : /^不用改/.test(change) ? 'same' : /^要改/.test(change) ? 'variant' : 'none';
    found.push({ relation, problem: company ? company.title : listed ? `${listed.no}. ${listed.title}` : '', hot: !!listed?.hot, note: relation === 'variant' ? change.replace(/^要改[”"」]?\s*[:：，,]?\s*/, '') : '', ...company && { company: company.company } });
    change = '';
  }
  return found;
}
const relation = { same: '原题', variant: '变式', none: '不在题单' };
const verdict = o => o ? [`${relation[o.relation]}${o.relation !== 'none' && o.problem ? ` ${o.problem}${o.company ? `（${o.company}手撕）` : ''}` : ''}`] : [];
const brief = j => j.insights?.length ? j.insights.map(i => [...verdict(i.origin), ...i.categories, ...i.approaches].join(' · ')).join('；').slice(0, 120) : snippet(j.answer);

// a, b: square greyscale thumbnails of two screenshots. Compared in 8×8 blocks, so a blinking caret or a
// clock tick is the same screen while one new line of text is not.
export function sameFrame(a, b, limit = 8) {
  if (!a || !b || a.length !== b.length) return false;
  const size = Math.round(Math.sqrt(a.length)), cell = 8;
  for (let top = 0; top < size; top += cell) for (let left = 0; left < size; left += cell) {
    let sum = 0, count = 0;
    for (let y = top; y < Math.min(top + cell, size); y++) for (let x = left; x < Math.min(left + cell, size); x++) { sum += Math.abs(a[y * size + x] - b[y * size + x]); count++; }
    if (sum / count >= limit) return false;
  }
  return true;
}

// One job per click or long press: capturing (screenshots still coming) -> analyzing -> done | failed.
// A click takes one screenshot. A long press ("burst") takes one every `interval` ms until release and
// answers them together. Screenshots are requested one at a time, so a slow agent only slows the pace.
// Photos sent from the camera page skip capturing: submit() makes a job of them that starts at analyzing.
// engine() names the model chosen at that moment; a job keeps it, so everything asked about it later goes to the same one.
export class JobStore extends EventEmitter {
  constructor({ analyze, match, explain, requestShot = () => {}, prompt = () => '', engine = () => undefined, stateFile, concurrency = 2, captureTimeout = 12000, lateWindow = 60000, interval = 500, maxFrames = 12, holdTimeout = 3000, maxHold = 60000 } = {}) {
    super(); Object.assign(this, { analyze, matcher: match, explainer: explain, requestShot, prompt, engine, stateFile, concurrency, captureTimeout, lateWindow, interval, maxFrames, holdTimeout, maxHold });
    this.state = { seq: 0, jobs: [] }; this.running = new Map(); this.explaining = new Map();
    this.live = new Map();   // capturing job id -> { holding, heldAt, shot, shotAt, last, error, timeout, next, guard }
    this.shots = new Map();  // screenshot request id -> job id
    this.late = new Map();   // timed-out request id -> job id, in case the screenshot still arrives
    if (stateFile) {
      try { this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, 'utf8')) }; }
      catch (e) { if (e.code !== 'ENOENT') throw new Error(`无法读取已保存记录：${e.message}`); }
      for (const j of this.state.jobs) {
        // Records written before long press existed hold a single image.
        if (!j.frames) { j.frames = j.path ? [{ id: j.frameId, path: j.path, capturedAt: j.capturedAt }] : []; delete j.path; delete j.frameId; }
        if (j.explainStatus === 'running') delete j.explainStatus;
        if (j.matchStatus === 'running') Object.assign(j, { matchStatus: 'failed', matchError: '上次服务中断' });
        if (active(j)) { j.status = 'failed'; j.error = '上次服务中断，请重新截图'; }
      }
    }
  }
  save() {
    if (!this.stateFile) return;
    writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state)); renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }
  // rev lets a page ignore an update that arrives after a newer one.
  changed(job) { if (job) job.rev = (job.rev || 0) + 1; this.save(); if (job) this.emit('job', job); }
  job(id) { return this.state.jobs.find(j => j.id === id); }
  get capturing() { return this.state.jobs.find(j => j.status === 'capturing'); }
  get pending() { return this.state.jobs.filter(active).length; }
  // List entries leave out the long texts; the page loads them when a record is opened.
  summary(j) { const { answer, explanation, ...rest } = this.detail(j); return rest; }
  detail(j) { const { frames, systemPrompt, ...rest } = j; return { ...rest, frameCount: frames.length, hasExplanation: j.explanation !== undefined, snippet: brief(j) }; }

  create(mode = 'single') {
    const job = { id: randomUUID(), seq: ++this.state.seq, mode, status: 'capturing', engine: this.engine(), systemPrompt: this.prompt() || '', createdAt: now(), frames: [], shots: 0 };
    this.state.jobs.push(job);
    const live = { holding: mode === 'burst', heldAt: Date.now() }; this.live.set(job.id, live);
    if (live.holding) {
      // The phone keeps confirming that the button is down. Without that, or after maxHold, the burst ends by itself.
      live.guard = setInterval(() => { if (Date.now() - live.heldAt > this.holdTimeout || Date.now() - Date.parse(job.createdAt) > this.maxHold) this.release(job.id); }, 250);
      live.guard.unref();
    }
    this.changed(job); this.shoot(job); return job;
  }
  // Pictures that arrive ready-made (a batch from the camera page): nothing is captured, the job starts at the model.
  submit(frames, mode = 'camera') {
    const job = { id: randomUUID(), seq: ++this.state.seq, mode, status: 'analyzing', engine: this.engine(), systemPrompt: this.prompt() || '', createdAt: now(), frames: frames.map(({ id, path, capturedAt }) => ({ id, path, capturedAt: capturedAt || now() })), shots: frames.length };
    this.state.jobs.push(job); this.changed(job); this.pump(); return job;
  }
  shoot(job) {
    const live = this.live.get(job.id), shot = randomUUID();
    live.shot = shot; live.shotAt = Date.now(); this.shots.set(shot, job.id);
    live.timeout = setTimeout(() => this.shotEnded(shot, '截图端没有及时传回截图，请确认它仍在运行后再点一次', true), this.captureTimeout); live.timeout.unref();
    try { this.requestShot(shot, job); } catch (e) { this.shotEnded(shot, e.message); }
  }
  // True for the screenshot a job is waiting for, and for one that timed out shortly ago: it is still what the user asked for.
  expects(shot) {
    const job = this.job(this.shots.get(shot)); if (job && this.live.get(job.id)?.shot === shot) return true;
    const late = this.job(this.late.get(shot)); return !!late?.timedOut && Date.now() - Date.parse(late.createdAt) < this.lateWindow;
  }
  // Returns false when the screenshot repeats the previous one of the same job and was left out.
  frame(shot, { id, path, capturedAt, pixels }) {
    if (!this.expects(shot)) throw Error('截图任务已结束');
    const job = this.job(this.shots.get(shot) || this.late.get(shot)); this.shots.delete(shot);
    let live = this.live.get(job.id);
    if (live) { clearTimeout(live.timeout); live.shot = null; }
    else {
      this.late.delete(shot); live = { holding: false }; this.live.set(job.id, live);
      delete job.error; delete job.timedOut; delete job.finishedAt; job.status = 'capturing';
    }
    job.shots++;
    const kept = !sameFrame(live.last, pixels);
    if (kept) { job.frames.push({ id, path, capturedAt: capturedAt || now() }); live.last = pixels; }
    if (live.holding && job.frames.length >= this.maxFrames) { live.holding = false; job.capped = true; }
    if (!live.holding) this.settle(job);
    else {
      this.changed(job);
      live.next = setTimeout(() => { live.next = null; if (live.holding) this.shoot(job); }, Math.max(0, live.shotAt + this.interval - Date.now()));
      live.next.unref();
    }
    return kept;
  }
  // The capture agent closed the batch of this screenshot without sending it, or never answered.
  shotEnded(shot, error, timedOut = false) {
    const job = this.job(this.shots.get(shot)), live = job && this.live.get(job.id);
    if (!live || live.shot !== shot) return;   // its frame already arrived
    clearTimeout(live.timeout); this.shots.delete(shot); live.shot = null; live.holding = false; live.error = error || '截图端没有传回截图';
    if (timedOut) { this.emit('expired', shot); if (!job.frames.length) { job.timedOut = true; this.late.set(shot, job.id); } }
    this.settle(job);
  }
  hold(id) { const live = this.live.get(id); if (live?.holding) live.heldAt = Date.now(); }
  release(id) { const live = this.live.get(id); if (live?.holding) { live.holding = false; this.settle(this.job(id)); } }
  // Capturing is over (click done, button released, or the agent failed): answer what was collected.
  settle(job) {
    const live = this.live.get(job.id); if (!live || live.shot) return;   // a screenshot is still on its way
    clearTimeout(live.next); clearInterval(live.guard); this.live.delete(job.id);
    if (job.frames.length) { job.status = 'analyzing'; this.changed(job); this.pump(); }
    else { Object.assign(job, { status: 'failed', error: live.error || '没有截到图', finishedAt: now() }); this.changed(job); }
  }
  failCapturing(error) {
    for (const [id, live] of [...this.live]) {
      clearTimeout(live.timeout); if (live.shot) this.shots.delete(live.shot);
      live.shot = null; live.holding = false; live.error = error; this.settle(this.job(id));
    }
  }
  pump() {
    for (let j; this.running.size < this.concurrency && (j = this.state.jobs.find(j => j.status === 'analyzing' && !this.running.has(j.id)));) this.run(j);
  }
  run(j) {
    const controller = new AbortController(), signal = controller.signal;
    const done = (async () => {
      try {
        const parsed = splitAnswer(await this.analyze(j, { signal }));
        if (!parsed.answer) throw Error('模型未返回文字');
        if (j.status !== 'analyzing') return;
        Object.assign(j, { status: 'done', ...parsed, finishedAt: now() });
      } catch (e) { if (j.status === 'analyzing') Object.assign(j, { status: 'failed', error: e.message, finishedAt: now() }); return; }
      // A programming answer is delivered as soon as its code is written. Only then is the model asked how the
      // problem relates to the problem list, so that it judges from its own finished solution.
      if (j.kind !== 'code' || !this.matcher) return;
      Object.assign(j, { matchStatus: 'running', matchStartedAt: now() }); this.changed(j);
      try {
        const origins = parseMatch(await this.matcher(j, { signal }));
        if (!origins.length) throw Error('模型未返回对照结果');
        j.insights.forEach((insight, i) => { if (origins[i]) insight.origin = origins[i]; });
        j.matchStatus = 'done';
      } catch (e) { Object.assign(j, { matchStatus: 'failed', matchError: e.message }); }
    })().finally(() => { this.running.delete(j.id); if (this.job(j.id)) this.changed(j); this.pump(); });
    this.running.set(j.id, { controller, done });
  }
  // The explanation is written on request (double click) and kept with the record.
  explain(id) {
    const j = this.job(id); if (j?.status !== 'done') throw Error('这条记录还没有答案');
    if (j.explanation !== undefined || this.explaining.has(id)) return j;
    const controller = new AbortController();
    Object.assign(j, { explainStatus: 'running', explainStartedAt: now() }); delete j.explainError; this.changed(j);
    const done = (async () => {
      try {
        const text = String(await this.explainer(j, { signal: controller.signal }) || '').trim();
        if (!text) throw Error('模型未返回文字');
        Object.assign(j, { explanation: text, explainStatus: 'done' });
      } catch (e) { if (controller.signal.aborted) delete j.explainStatus; else Object.assign(j, { explainStatus: 'failed', explainError: e.message }); }
    })().finally(() => { this.explaining.delete(id); if (this.job(id)) this.changed(j); });
    this.explaining.set(id, { controller, done }); return j;
  }
  close() {
    for (const { controller } of [...this.running.values(), ...this.explaining.values()]) controller.abort();
    for (const live of this.live.values()) { clearTimeout(live.timeout); clearTimeout(live.next); clearInterval(live.guard); }
    this.live.clear(); this.shots.clear(); this.late.clear();
  }
  clear() {
    this.close();
    const removed = this.state.jobs; this.state.jobs = []; this.state.seq = 0;
    for (const j of removed) if (active(j)) { j.status = 'failed'; j.error = '目录已清空'; }
    this.save(); this.emit('reset'); return removed;
  }
  async whenIdle() { while (this.running.size || this.explaining.size) await Promise.all([...this.running.values(), ...this.explaining.values()].map(r => r.done)); }
}
