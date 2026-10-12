import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { JobStore } from './mouse-core.js';
import { PROBLEM_LIST } from './problem-list.js';
import { createProvider } from './providers.js';
import { RemoteSource } from './remote-source.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const staticFiles = { '/': ['index.html', 'text/html'], '/mouse.js': ['mouse.js', 'text/javascript'], '/mouse.css': ['mouse.css', 'text/css'] };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const validId = s => typeof s === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(s);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function body(req, limit = 24_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('上传内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

const SCREENSHOTS = '这是同一次操作中截取的屏幕截图（一张，或按时间顺序排列的多张）。';
const PHONE_STYLE = '公式用普通文字和 Unicode 符号书写（如 x²、√2、≤、π、a/b），不要使用 LaTeX 和表格。';
// Shown by default: answers only. The explanation is a second request, made when the user double-clicks.
export const ANSWER_PROMPT = `${SCREENSHOTS}如果其中有题目，直接给出答案。
1. 第一行输出“标题：”加上不超过 20 个字的内容概括（例如“标题：导数选择题 3–5”），然后空一行。
2. 只输出答案：不要解析、推导、开场白和总结，不要复述或转写题干。这一条优先于任务背景中关于解析的要求，解析会在用户需要时另行生成；任务背景的其他要求照常遵守。
3. 每题一行，写成“题号. 答案”。选择题写选项字母和对应的选项内容；填空题、计算题写具体结果和单位；简答题直接写出要点完整的答案。没有题号时按出现顺序编号。
4. 编程题（算法题、OJ 题）不按第 3 条写，改为按下面的顺序输出：先写完代码，再写代码后面的三行。每行以给定的词和冒号开头：
类型：代码题
代码：
\`\`\`语言
可以直接提交的完整代码
\`\`\`
题意：一句话写出这道题去掉故事背景后的实质：给定什么，要求输出什么，有什么关键限制。
分类：2 到 4 个标签，用顿号分隔，写所属的数据结构或算法类别，例如：链表、哈希表、BFS、动态规划。
思路：2 到 4 个标签，用顿号分隔，写上面这份代码的关键想法，例如：快慢指针、单调栈、Floyd 判圈、分类讨论、建立物理模型。
语言按题目或任务背景的要求；都没有指定时用截图中代码编辑器当前选择的语言，仍无法判断时用 Python。代码在手机横屏上逐行阅读，要尽量短：不写注释，不留多余空行，每行尽量不超过 60 个字符。一次有多道编程题时，每道题先写一行“题号：N”，再重复上面这一组。
5. 多张截图的内容有重叠或重复时，每道题只回答一次，按题号顺序排列；被截断的题目结合相邻截图补全后再作答。
6. 看不清或缺少条件的题目写“题号. 无法确定”并用几个字说明原因，不要猜测。
7. 截图中没有题目时，第一行写“标题：未发现题目”，正文只写“未发现题目”。
8. ${PHONE_STYLE}`;
// Asked after a programming problem has been answered, without the screenshots: the comparison is made on what
// the model itself wrote down as the substance of the problem and on its finished code, not on the wording or the
// story of the problem. It is asked whether the listed solution would have to change, not for a label: see parseMatch.
const solved = i => [i.no && `题号：${i.no}`, i.summary && `题意：${i.summary}`, i.categories.length && `分类：${i.categories.join('、')}`, i.approaches.length && `思路：${i.approaches.join('、')}`].filter(Boolean).join('\n');
export const matchPrompt = job => `下面的编程题已经解出，这是每道题的题意、解法标签和代码：
<解答>
${job.insights.map(solved).join('\n\n')}

${job.answer}
</解答>
请判断每道题与文末题单的关系。题单里的题你都熟悉；要比较的是题目的实质和解法，不是题名、故事背景或个别关键词。
每道题依次输出四行，每行以给定的词和冒号开头：
候选：题单中最可能与这道题是同一道题或同一类题的题号，最多 3 个，用顿号分隔；一个都没有就写“无”。
比较：拿最接近的那个候选，对比要求输出的内容、限制条件和主要解法，写出相同和不同之处，不超过 50 个字。
改动：把那道候选题的标准解法拿来解这道题，算法本身要不要改？三种写法选一种：
  “不用改”：只需要适配读入和输出的格式、字符、变量名或故事背景。
  “要改：改什么”：核心模型和主要解法相同，但算法要改一处或多做一步，例如条件变了、多求一样东西、方向或维度变了、数据范围逼出另一种写法。说明不超过 20 个字。
  “用不上”：主要解法不同。只是用到同一种通用技巧（都用了哈希表、排序、DFS、二分等）也算用不上。
结论：最接近的那个候选的题号；没有候选就写“无”。
题号只能写题单里出现的题号。有多道题时，每道题先写一行“题号：N”，再写这四行。除这些行以外不要输出别的内容。

题单（分组：题号 题名）：
${PROBLEM_LIST}`;
export const explainPrompt = answer => `${SCREENSHOTS}此前已经给出下面的答案：
<答案>
${answer}
</答案>
请给出各题的解析。
1. 按题号逐题输出，每题使用下面的格式：
## 第 N 题
**答案：** 与上面一致的答案
**解析：** 写清关键依据和必要步骤，保持简明。
2. 解析时如果发现上面的答案有误，在该题的“答案”前加“更正：”并写出正确答案。
3. 不要开场白和总结，不要整段复述题干。多张截图内容重复时每题只写一次。编程题说明思路、关键步骤和复杂度，不要重复整段代码。
4. 上面的答案是“未发现题目”时，用两三句话说明截图内容。
5. 结果在手机窄屏上阅读，使用短段落和列表。${PHONE_STYLE}`;

async function demoAnswer(job) {
  await pause(1200);
  // Every third capture is a set of plain questions, the others a programming problem with its approach level.
  // The approach lines follow the code, as the real prompt asks.
  if (job.seq % 3 === 0) return `标题：演示回答 ${job.seq}（未调用模型）\n\n1. B．演示选项\n2. 42 km\n3. C．演示选项\n本次用到 ${job.frames.length} 张截图。`;
  const code = ['#include <bits/stdc++.h>', 'using namespace std;', 'int main() {', ...Array.from({ length: 34 }, (_, i) => `    cout << "演示代码第 ${i + 4} 行，检查每屏行数和滚轮翻页" << endl;`), '    return 0;', '}'];
  return `标题：演示代码题 ${job.seq}（未调用模型）\n\n类型：代码题\n代码：\n\`\`\`cpp\n${code.join('\n')}\n\`\`\`\n题意：演示用的题意，设计一个容量按字节计算的缓存\n分类：链表、哈希表、设计\n思路：哈希表 + 双向链表、哨兵节点、分类讨论`;
}
async function demoMatch() {
  await pause(2500);
  return '候选：146\n比较：演示用的比较，淘汰规则相同，容量的算法不同\n改动：要改：演示用的差异说明，容量改为按字节计算\n结论：146';
}
async function demoExplain() {
  await pause(1200);
  return Array.from({ length: 12 }, (_, i) => `## 第 ${i + 1} 题\n**答案：** ${'ABCD'[i % 4]}．演示选项\n**解析：** 这是演示模式生成的占位文字，用来检查双击展开、滚轮翻页和右键收起的流程。在 .env 中配置 ANALYZER 后，这里显示真实的解析。`).join('\n\n');
}

// Typed by hand on a phone, so it is short and avoids look-alike characters. Kept across restarts.
function pairToken(dataDir) {
  const file = path.join(dataDir, 'pair-token.txt');
  try { const saved = readFileSync(file, 'utf8').trim(); if (/^[a-z2-9]{10}$/.test(saved)) return saved; } catch {}
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const token = Array.from({ length: 10 }, () => alphabet[randomInt(alphabet.length)]).join('');
  writeFileSync(file, token); return token;
}

class MouseSource extends RemoteSource {
  // A restarted capture agent replaces the previous session at once.
  register(name) { this.session = null; return super.register(name); }
  // An agent that outlived a server restart keeps polling with its old id and never registers again; adopt it.
  poll(id, ack) {
    if (!this.online && id !== this.session?.id && validId(id)) { this.session = { id, name: 'Windows PC', seen: this.now() }; this.commands = []; }
    return super.poll(id, ack);
  }
  drop(shot) { this.commands = this.commands.filter(c => c.batch?.id !== shot); }
}

export function createMouseApp(config = {}) {
  const dataDir = path.resolve(config.dataDir || path.join(root, 'data', 'mouse'));
  const imageDir = path.join(dataDir, 'images'); mkdirSync(imageDir, { recursive: true });
  const token = config.token || pairToken(dataDir);
  const authorized = value => { const a = Buffer.from(value || ''), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  // The task background lives in a plain text file, so it can be prepared on this computer before a session.
  const promptFile = path.join(dataDir, 'system-prompt.txt');
  const readPrompt = () => { try { return readFileSync(promptFile, 'utf8').replace(/^﻿/, '').trim().slice(0, 12000); } catch { return ''; } };
  const analyzer = config.analyzer || 'codex';
  const provider = config.analyze ? null : createProvider({ dataDir, analyzer, model: config.model, effort: config.effort, deepseekKey: config.deepseekKey, openaiKey: config.apiKey, ocr: false, codexBin: config.codexBin, claudeBin: config.claudeBin });
  const images = job => job.frames.map(f => f.path);
  const analyze = config.analyze || (analyzer === 'demo' ? demoAnswer : (job, { signal }) => provider.ask(ANSWER_PROMPT, images(job), { signal, systemPrompt: job.systemPrompt }));
  const match = config.match || (provider && (analyzer === 'demo' ? demoMatch : (job, { signal }) => provider.ask(matchPrompt(job), [], { signal })));
  const explain = config.explain || (analyzer === 'demo' ? demoExplain : (job, { signal }) => provider.ask(explainPrompt(job.answer), images(job), { signal, systemPrompt: job.systemPrompt }));
  const source = new MouseSource(); const clients = new Set(); let sourceOnline = false;
  // Every screenshot is its own single-shot batch for the agent; a long press is a series of them.
  const requestShot = shot => source.push({ type: 'capture', batch: { id: shot, mode: 'single' } });
  const store = new JobStore({ analyze, match, explain, requestShot, prompt: readPrompt, stateFile: path.join(dataDir, 'state.json'), concurrency: config.concurrency || 2, captureTimeout: config.captureTimeout || 12000, interval: config.interval || 500, maxFrames: config.maxFrames || 12, holdTimeout: config.holdTimeout || 3000 });
  if (!existsSync(promptFile)) writeFileSync(promptFile, store.state.systemPrompt || '');   // earlier versions kept it in state.json
  delete store.state.systemPrompt;
  const send = (ws, e) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e)); };
  const broadcast = e => { for (const ws of clients) send(ws, e); };
  const sourceChanged = () => { sourceOnline = source.online; broadcast({ type: 'source', source: source.status() }); };
  const snapshot = () => ({ jobs: store.state.jobs.slice(-300).map(j => store.summary(j)), source: source.status(), analyzer, model: config.model || '', now: new Date().toISOString() });
  store.on('job', job => broadcast({ type: 'job', job: store.detail(job) }));
  store.on('expired', shot => source.drop(shot));
  store.on('reset', () => broadcast({ type: 'reset' }));

  // The pairing code is short, so wrong guesses from one address are throttled.
  const failures = new Map();
  const blocked = ip => { const f = failures.get(ip); return !!f && f.count >= 20 && Date.now() < f.until; };
  const failed = ip => {
    const now = Date.now(), f = failures.get(ip); if (failures.size > 1000) failures.clear();
    if (!f || now >= f.until) failures.set(ip, { count: 1, until: now + 60000 }); else f.count++;
  };

  const handler = async (req, res) => {
    const wsHost = /^[\w.:[\]-]+$/.test(req.headers.host || '') ? ` ws://${req.headers.host} wss://${req.headers.host}` : '';
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'${wsHost}; frame-ancestors 'none'`);
    try {
      const url = new URL(req.url, 'http://localhost'), ip = req.socket.remoteAddress;
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '只接受同源请求' });
      if (staticFiles[url.pathname] && req.method === 'GET') {
        const [name, mime] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); return res.end(readFileSync(path.join(root, 'public', 'mouse', name)));
      }
      // Browsers ask for /favicon.ico on their own; that must not count as a wrong pairing code.
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: '找不到页面' });
      if (blocked(ip)) return json(res, 429, { error: '配对码错误次数过多，请一分钟后再试' });
      if (!authorized(req.headers.authorization?.replace(/^Bearer /, ''))) { failed(ip); return json(res, 401, { error: '请填写电脑终端显示的配对码' }); }
      const get = req.method === 'GET', post = req.method === 'POST', clientId = req.headers['x-client-id'], id = url.searchParams.get('id');

      // Phone page
      if (get && url.pathname === '/api/state') return json(res, 200, snapshot());
      if (post && url.pathname === '/api/capture') {
        const text = (await body(req, 2000)).toString(), mode = text && JSON.parse(text).mode === 'burst' ? 'burst' : 'single';
        if (!source.online) return json(res, 409, { error: '截图端未连接：请在被截图的电脑上启动采集器' });
        const waiting = store.capturing;
        if (waiting && mode === 'single' && waiting.mode === 'single') return json(res, 200, { job: store.detail(waiting), reused: true });
        if (waiting) return json(res, 409, { error: '上一次截图还没有结束' });
        if (store.pending >= 20) return json(res, 429, { error: '等待解析的截图太多，请稍后再点' });
        return json(res, 200, { job: store.detail(store.create(mode)) });
      }
      if (post && url.pathname === '/api/hold') { store.hold(id); return json(res, 200, { ok: true }); }
      if (post && url.pathname === '/api/release') { store.release(id); return json(res, 200, { ok: true }); }
      if (post && url.pathname === '/api/explain') return json(res, 200, { job: store.detail(store.explain(id)) });
      if (get && url.pathname === '/api/job') {
        const job = store.job(id); return job ? json(res, 200, store.detail(job)) : json(res, 404, { error: '找不到这条记录' });
      }
      if (get && url.pathname === '/api/image') {
        const frame = store.job(id)?.frames[Number(url.searchParams.get('n')) || 0]; if (!frame) return json(res, 404, { error: '找不到图片' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(readFileSync(frame.path));
      }
      if (get && url.pathname === '/api/settings') return json(res, 200, { systemPrompt: readPrompt() });
      if (post && url.pathname === '/api/settings') {
        const msg = JSON.parse((await body(req, 50000)).toString());
        if (typeof msg.systemPrompt !== 'string' || msg.systemPrompt.length > 12000) throw Error('任务背景最多 12000 字');
        writeFileSync(promptFile, msg.systemPrompt); return json(res, 200, { ok: true });
      }
      if (post && url.pathname === '/api/archive') {
        if (!store.state.jobs.length) return json(res, 200, { archived: 0 });
        const dir = path.join(dataDir, 'archives', new Date().toISOString().replace(/[:.]/g, '-')); mkdirSync(path.join(dir, 'images'), { recursive: true });
        const removed = store.clear();
        for (const frame of removed.flatMap(j => j.frames)) {
          // A file still being read by a cancelled model call stays behind; the record keeps its old path.
          try { const moved = path.join(dir, 'images', path.basename(frame.path)); renameSync(frame.path, moved); frame.path = moved; } catch {}
        }
        writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: removed })); return json(res, 200, { archived: removed.length });
      }

      // Capture agent (collect/ScreenAgent.cs); same routes and payloads as the voice version.
      if (post && url.pathname === '/api/source/register') {
        const msg = JSON.parse((await body(req, 2000)).toString()); const session = source.register(msg.name);
        store.failCapturing('截图端重新连接了，请再点一次左键'); sourceChanged(); return json(res, 200, { clientId: session });
      }
      if (get && url.pathname === '/api/source/poll') {
        const result = source.poll(clientId, url.searchParams.get('ack')); if (!sourceOnline) sourceChanged(); return json(res, 200, result);
      }
      if (post && url.pathname === '/api/frame') {
        source.validate(clientId);
        const frameId = url.searchParams.get('frameId'), shot = url.searchParams.get('batchId');
        if (!validId(frameId) || !validId(shot)) return json(res, 400, { error: '图片标识无效' });
        const buffer = await body(req);
        // A retried upload, or a screenshot nobody waits for any more: acknowledge it so the agent moves on.
        if (!store.expects(shot)) return json(res, 200, { id: frameId, ignored: true });
        const picture = sharp(buffer, { limitInputPixels: 32_000_000 }).rotate();
        const [jpeg, pixels] = await Promise.all([
          picture.clone().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(),
          picture.clone().flatten({ background: '#fff' }).resize(128, 128, { fit: 'fill' }).greyscale().raw().toBuffer(),
        ]);
        if (!store.expects(shot)) return json(res, 200, { id: frameId, ignored: true });
        const imagePath = path.join(imageDir, `${frameId}.jpg`), at = new Date(url.searchParams.get('capturedAt') || ''); writeFileSync(imagePath, jpeg);
        let kept = false;
        try { kept = store.frame(shot, { id: frameId, path: imagePath, capturedAt: isNaN(at) ? undefined : at.toISOString(), pixels }); }
        finally { if (!kept) unlinkSync(imagePath); }
        return json(res, 200, { id: frameId, repeated: !kept });
      }
      if (post && url.pathname === '/api/source/finish') {
        const msg = JSON.parse((await body(req, 4000)).toString());
        // Always acknowledged: the agent repeats an unanswered finish forever and would stop polling.
        if (clientId === source.session?.id) store.shotEnded(String(msg.batchId || ''), String(msg.error || '').slice(0, 300));
        return json(res, 200, { ok: true });
      }
      if (post && url.pathname === '/api/source/question') return json(res, 200, { ok: true });
      json(res, 404, { error: '找不到接口' });
    } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); else res.end(); }
  };
  const server = config.tlsKey && config.tlsCert ? https.createServer({ key: readFileSync(config.tlsKey), cert: readFileSync(config.tlsCert) }, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4000 });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    } catch { socket.destroy(); }
  });
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress; ws.seen = Date.now(); ws.on('pong', () => { ws.seen = Date.now(); });
    const timer = setTimeout(() => { if (!clients.has(ws)) ws.close(1008, 'Pair first'); }, 5000);
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data); if (msg.type !== 'hello' || clients.has(ws)) return;
        if (blocked(ip) || !authorized(msg.token)) { failed(ip); ws.close(1008, 'Invalid pairing'); return; }
        clearTimeout(timer); clients.add(ws); send(ws, { type: 'hello', ...snapshot() });
      } catch { ws.close(1003, 'Invalid message'); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { clearTimeout(timer); clients.delete(ws); });
  });
  const heartbeat = setInterval(() => {
    if (source.online !== sourceOnline) sourceChanged();
    // Phones on Wi-Fi power saving answer late; only a long silence counts as a dead socket.
    for (const ws of clients) { if (Date.now() - ws.seen > 15000) ws.terminate(); else ws.ping(); }
  }, 3000); heartbeat.unref();
  return { server, store, source, token, promptFile, async close() { clearInterval(heartbeat); store.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); await provider?.close?.(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const app = createMouseApp({ dataDir: env.MOUSE_DATA_DIR, token: env.PAIR_TOKEN, apiKey: env.OPENAI_API_KEY, analyzer: env.ANALYZER, model: env.ANALYZER_MODEL, effort: env.ANALYZER_EFFORT, deepseekKey: env.DEEPSEEK_API_KEY, codexBin: env.CODEX_BIN, claudeBin: env.CLAUDE_BIN, tlsKey: env.TLS_KEY, tlsCert: env.TLS_CERT, concurrency: Number(env.MOUSE_CONCURRENCY) || undefined, maxFrames: Number(env.MOUSE_MAX_FRAMES) || undefined });
  const host = env.MOUSE_HOST || env.HOST || '127.0.0.1', port = Number(env.MOUSE_PORT || 8790), scheme = env.TLS_CERT ? 'https' : 'http';
  app.server.listen(port, host, () => {
    console.log(`拾页 · 鼠标版: ${scheme}://localhost:${port}/#pair=${app.token}`);
    console.log(`配对码 ${app.token} | 监听 ${host}:${port} | 分析 ${env.ANALYZER || 'codex'}${env.ANALYZER_MODEL ? ` · ${env.ANALYZER_MODEL}` : ''}`);
    console.log(`任务背景（System Prompt）：用记事本编辑 ${app.promptFile} 并保存，下一次截图起生效`);
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) { console.log('当前只监听本机。手机和截图端要连接，请在 .env 设置 HOST=0.0.0.0 后重启。'); return; }
    const addresses = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
    for (const address of addresses) console.log(`手机浏览器打开 ${scheme}://${address}:${port} 并输入配对码；截图端地址填 ${scheme}://${address}:${port}`);
  });
}
