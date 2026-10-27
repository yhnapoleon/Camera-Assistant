import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import { randomInt, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { JobStore } from './mouse-core.js';
import { COMPANY_PROBLEM_LIST, PROBLEM_LIST } from './problem-list.js';
import { ANALYZERS, EFFORTS, createProvider } from './providers.js';
import { RemoteSource } from './remote-source.js';
import { createVoiceRoutes } from './voice.js';
import { LESSON_PROMPT } from './lesson.js';
import { demoLesson } from './lesson-demo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const staticFiles = { '/': ['index.html', 'text/html'], '/mouse.js': ['mouse.js', 'text/javascript'], '/mouse.css': ['mouse.css', 'text/css'], '/camera': ['camera.html', 'text/html'], '/camera.js': ['camera.js', 'text/javascript'], '/camera.css': ['camera.css', 'text/css'] };
Object.assign(staticFiles, { '/voice': ['voice.html', 'text/html'], '/voice.js': ['voice.js', 'text/javascript'], '/voice-recorder.js': ['voice-recorder.js', 'text/javascript'], '/voice.css': ['voice.css', 'text/css'] });
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const validId = s => typeof s === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(s);
const pause = ms => new Promise(r => setTimeout(r, ms));
async function body(req, limit = 24_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('上传内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

const SCREENSHOTS = '这是同一次操作中截取的屏幕截图（一张，或按时间顺序排列的多张）。';
// Pictures from the camera page are photos of paper or of a screen; the prompts are the same, told so.
const PHOTOS = '这是同一次操作中用手机或平板拍摄的照片（一张，或按拍摄顺序排列的多张），画面可能倾斜、有反光或阴影。';
const worded = (prompt, job) => job.mode === 'camera' ? prompt.replace(SCREENSHOTS, PHOTOS).replaceAll('截图', '照片') : prompt;
const PHONE_STYLE = '公式用普通文字和 Unicode 符号书写（如 x²、√2、≤、π、a/b），不要使用 LaTeX 和表格。';
// Shown by default: answers only. The explanation is a second request, made when the user double-clicks.
export const ANSWER_PROMPT = `${SCREENSHOTS}如果其中有题目，直接给出答案。
1. 第一行输出“标题：”加上不超过 20 个字的内容概括（例如“标题：导数选择题 3–5”），然后空一行。
2. 只输出答案：不要解析、推导、开场白和总结，不要复述或转写题干。这一条优先于任务背景中关于解析的要求，解析会在用户需要时另行生成；任务背景的其他要求照常遵守。
3. 每题一行，写成“题号. 答案”。选择题写选项字母和对应的选项内容；填空题、计算题写具体结果和单位；简答题直接写出要点完整的答案。没有题号时按出现顺序编号。
4. 编程题（算法题、OJ 题）不按第 3 条写，改为按下面的顺序输出：先看截图里的代码编辑器，写“已有代码”一行；然后写完代码；最后写代码后面的三行。每行以给定的词和冒号开头：
类型：代码题
已有代码：截图的代码编辑器里，用户自己已经写了多少代码（题目自带的函数签名、类定义等模板不算）。三种写法选一种：
  “无”：编辑器是空的、只有模板，或只有零星几行。
  “部分”：已经写出一部分实质逻辑，主体还没有写完。
  “较完整”：主体逻辑基本写完，只差补全、改错或调通。
代码：
\`\`\`语言
可以直接提交的完整代码
\`\`\`
题意：一句话写出这道题去掉故事背景后的实质：给定什么，要求输出什么，有什么关键限制。
分类：2 到 4 个标签，用顿号分隔，写所属的数据结构或算法类别，例如：链表、哈希表、BFS、动态规划。
思路：2 到 4 个标签，用顿号分隔，写上面这份代码的关键想法，例如：快慢指针、单调栈、Floyd 判圈、分类讨论、建立物理模型。
语言按题目或任务背景的要求；都没有指定时用截图中代码编辑器当前选择的语言，仍无法判断时用 Python。一次有多道编程题时，每道题先写一行“题号：N”，再重复上面这一组。编程题除了这几行和代码，不要再输出别的内容。
5. 编程题的代码按下面的要求写。第 2 条“不要解析”不限制代码里的注释。
- 已有代码是“部分”或“较完整”时，在用户的代码上补全和修改，交出改好之后的完整代码。沿用用户的思路、函数划分和合理的变量名，语言也与用户的一致；没有问题的行原样保留，不要推倒重写，也不要顺手改写风格。每一处改动只在它上面加一行注释：改过的行写“改：”，说明原来哪里不对、为什么这样改；新补的一段写“补：”，说明这一段做什么。这两个词是给用户找改动位置用的，只标在与用户原来的代码不一样的地方：与原来一字不差的行，以及函数说明、对原有代码的讲解，都用不带这两个词的普通注释；只是多了一行注释、代码本身没有动的地方不算改动。用户原有的行即使超过 60 个字符也不要拆行。只有用户的思路本身走不通（结果必然不对，或必然超时）时才换思路，并在代码第一行用“改：”注释说明为什么要换。
- 已有代码是“无”时从头写，注释里不要出现“改：”“补：”。
- 命名要直白：变量和函数用完整的词，只看名字就知道里面存的是什么，例如 left、right、maxLength、visited，不要写成 l、r、mx、vis；循环下标可以用 i、j。用户已有的名字合理就沿用，含义不清的才改。
- 写法要直白：一行只做一件事，不要为了短把几步挤进一行，不用逗号表达式、嵌套的三目运算、连续赋值、位运算小技巧这类要停下来想的写法。
- 带讲解注释：每个函数上面一行说明它做什么；每个关键步骤上面一行说明这一步在做什么、为什么这样做，例如状态的含义、初始值为什么这样取、循环里维护的是什么、边界和特殊情况怎么处理。注释用中文，单独占一行，要写具体，不要写“处理边界”“更新答案”这种看了等于没看的话。
- 代码在手机横屏上逐行阅读：新写的每一行（包括注释）尽量不超过 60 个字符；不留空行，注释行已经把各段分开了。
6. 多张截图的内容有重叠或重复时，每道题只回答一次，按题号顺序排列；被截断的题目结合相邻截图补全后再作答。
7. 看不清或缺少条件的题目写“题号. 无法确定”并用几个字说明原因，不要猜测。
8. 截图中没有题目时，第一行写“标题：未发现题目”，正文只写“未发现题目”。
9. ${PHONE_STYLE}${LESSON_PROMPT}`;
export const answerPrompt = job => worded(ANSWER_PROMPT, job);
// Asked after a programming problem has been answered, without the screenshots: the comparison is made on what
// the model itself wrote down as the substance of the problem and on its finished code, not on the wording or the
// story of the problem. It is asked whether the listed solution would have to change, not for a label: see parseMatch.
// The problems companies ask that are not on LeetCode come first and with what they ask, since a title alone tells
// the model nothing about them. The closest candidate is the one whose solution needs the least change; a company
// problem is preferred to a LeetCode problem only when both fit unchanged. Preferring it whenever the two seemed
// equally close made a plain LRU variant come out as a variant of the company's LRU with expiry.
const solved = i => [i.no && `题号：${i.no}`, i.summary && `题意：${i.summary}`, i.categories.length && `分类：${i.categories.join('、')}`, i.approaches.length && `思路：${i.approaches.join('、')}`].filter(Boolean).join('\n');
export const matchPrompt = job => `下面的编程题已经解出，这是每道题的题意、解法标签和代码：
<解答>
${job.insights.map(solved).join('\n\n')}

${job.answer}
</解答>
请判断每道题与文末题单的关系。题单分两部分：力扣题只列了题号和题名，这些题你都熟悉；企业手撕题是公司面试里要求手写的题，不在力扣题那一部分里，你不一定见过，每道题后面写了它的题意，以写出的题意为准，不要只凭题名判断。要比较的是题目的实质和解法，不是题名、故事背景或个别关键词。
每道题依次输出四行，每行以给定的词和冒号开头：
候选：题单中最可能与这道题是同一道题或同一类题的题号，最多 3 个，用顿号分隔；一个都没有就写“无”。企业手撕题的题号是字母 E 加数字，照原样写。
比较：拿最接近的那个候选，对比要求输出的内容、限制条件和主要解法，写出相同和不同之处，不超过 50 个字。
改动：把那道候选题的标准解法拿来解这道题，算法本身要不要改？三种写法选一种：
  “不用改”：只需要适配读入和输出的格式、字符、变量名或故事背景。
  “要改：改什么”：核心模型和主要解法相同，但算法要改一处或多做一步，例如条件变了、多求一样东西、方向或维度变了、数据范围逼出另一种写法。说明不超过 20 个字。
  “用不上”：主要解法不同。只是用到同一种通用技巧（都用了哈希表、排序、DFS、二分等）也算用不上。
结论：最接近的那个候选的题号，也就是拿它的标准解法来解这道题、要改的地方最少的那个；没有候选就写“无”。只有一道企业手撕题和一道力扣题都“不用改”、分不出远近时，才优先写企业手撕题的题号。
题号只能写题单里出现的题号。有多道题时，每道题先写一行“题号：N”，再写这四行。除这些行以外不要输出别的内容。

企业手撕题（题号 题名｜出题公司｜题意）：
${COMPANY_PROBLEM_LIST}

力扣题（分组：题号 题名）：
${PROBLEM_LIST}`;
// What the answer step saw in the editor (see "已有代码" above), told to the explanation so that both agree.
const DRAFT = { part: '部分', full: '较完整' };
const drafts = job => (job.insights || []).filter(i => DRAFT[i.draft]).map(i => `${i.no ? `第 ${i.no} 题` : ''}${DRAFT[i.draft]}`).join('，');
// For a programming problem the user had already written, the explanation is not a walk through the solution:
// it says what their code still lacks and names each place to change, with the reason.
export const explainPrompt = job => `${SCREENSHOTS}此前已经给出下面的答案：
<答案>
${job.answer}
</答案>
${drafts(job) ? `答题时看到用户已经在代码编辑器里写了自己的代码（${drafts(job)}），上面的代码是在用户的代码上补全和修改出来的。\n` : ''}请给出各题的解析。
1. 按题号逐题输出，每题使用下面的格式：
## 第 N 题
**答案：** 与上面一致的答案
**解析：** 写清关键依据和必要步骤，保持简明。
2. 解析时如果发现上面的答案有误，在该题的“答案”前加“更正：”并写出正确答案。
3. 不要开场白和总结，不要整段复述题干。多张截图内容重复时每题只写一次。
4. 编程题不按第 1 条的格式写，也不要重复整段代码。分两种情况：
（1）截图的代码编辑器里，用户已经写了不少自己的代码（题目自带的模板不算）：解析只回答一件事，用户现在的代码离达成目标还差什么、具体要改哪里。把截图里用户的代码和上面的答案逐处对比，按下面三段写：
## 还差什么
先用一句话下结论：思路对不对，照现在的代码提交会怎样（编译不过、哪一类输入结果不对、超时等）。然后每个差距一条，以“- ”开头，说清缺的是什么。
## 要改的地方
每一处改动一条，按它在代码里出现的先后编号，每条写这四行：
**N. 位置：** 截图里编辑器显示的行号和所在的函数，并把这一行的原文放在反引号里。
- 现在：这一行实际做了什么，会造成什么问题；能举出一个会出错的具体输入就举出来。
- 改成：改后的写法放在反引号里，超过一行时用代码块。
- 原因：为什么这样改就对了。
要新增的代码也算一处：位置写“第几行之后”或“哪个函数的哪一句之后”，“现在”写缺了什么。行号只写截图里看得见的；看不见行号时用函数名加原文定位，不要自己数。不需要改的地方不要列出来。
## 改完之后
时间复杂度和空间复杂度各一句，再列出值得自己测一下的边界输入。
（2）用户还没有写，或只有模板：说明思路、关键步骤、这样做为什么是对的，以及时间和空间复杂度。不用交代编辑器里有没有代码。
5. 上面的答案是“未发现题目”时，用两三句话说明截图内容。
6. 结果在手机窄屏上阅读，使用短段落和列表。${PHONE_STYLE}`;

async function demoAnswer(job) {
  await pause(1200);
  // Every third capture is a set of plain questions, the others a programming problem with its approach level.
  // The approach lines follow the code, as the real prompt asks.
  if (job.seq % 3 === 0) return `标题：演示回答 ${job.seq}（未调用模型）\n\n1. B．演示选项\n2. 42 km\n3. C．演示选项\n本次用到 ${job.frames.length} 张截图。`;
  return JSON.stringify(demoLesson());
}
// Of the programming problems, one in two is matched with a company problem, the other with a LeetCode problem.
async function demoMatch(job) {
  await pause(2500);
  if (job.lesson) return '候选：1\n比较：两数之和的哈希查找解法相同\n改动：不用改\n结论：1';
  if (job.seq % 3 === 1) return '候选：E1、E7\n比较：演示用的比较，合并规则相同\n改动：不用改\n结论：E1';
  return '候选：146\n比较：演示用的比较，淘汰规则相同，容量的算法不同\n改动：要改：演示用的差异说明，容量改为按字节计算\n结论：146';
}
async function demoExplain(job) {
  await pause(1200);
  if (drafts(job)) return '## 还差什么\n思路是对的，照现在的代码提交会在最后一个元素上算错（演示文字，未调用模型）。\n- 循环少走了最后一步\n- 没有处理输入为空的情况\n## 要改的地方\n**1. 位置：** 第 4 行，main 函数，`for (int i = 0; i < itemCount; i++) total += i;`\n- 现在：循环在 itemCount 之前停下，最后一个数没有加进去。\n- 改成：`for (int i = 0; i <= itemCount; i++) total += i;`\n- 原因：题目要求把 itemCount 本身也算进去。\n**2. 位置：** 第 4 行之后\n- 现在：输入为空时仍然进入后面的计算。\n- 改成：`if (itemCount == 0) return 0;`\n- 原因：空输入的结果是 0，不需要再算。\n## 改完之后\n时间 O(n)，空间 O(1)。值得自测：空输入、只有一个元素。';
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
  if (!!config.httpsKey !== !!config.httpsCert) throw Error('附加 HTTPS 入口需要同时配置 MOUSE_TLS_KEY 和 MOUSE_TLS_CERT');
  const extraTls = config.httpsKey ? { key: readFileSync(config.httpsKey), cert: readFileSync(config.httpsCert) } : null;
  // Export only parsed public certificate bytes, never arbitrary PEM file contents or private keys.
  const phoneCa = config.phoneCa ? new X509Certificate(readFileSync(config.phoneCa)) : null;
  if (phoneCa && !phoneCa.ca) throw Error('手机安装证书必须是 CA 证书');
  const dataDir = path.resolve(config.dataDir || path.join(root, 'data', 'mouse'));
  const imageDir = path.join(dataDir, 'images'); mkdirSync(imageDir, { recursive: true });
  const token = config.token || pairToken(dataDir);
  const authorized = value => { const a = Buffer.from(value || ''), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  // The task background lives in a plain text file, so it can be prepared on this computer before a session.
  const promptFile = path.join(dataDir, 'system-prompt.txt');
  const readPrompt = () => { try { return readFileSync(promptFile, 'utf8').replace(/^﻿/, '').trim().slice(0, 12000); } catch { return ''; } };
  const images = job => job.frames.map(f => f.path);
  const asking = provider => ({
    analyze: (job, { signal }) => provider.ask(answerPrompt(job), images(job), { signal, systemPrompt: job.systemPrompt }),
    match: (job, { signal }) => provider.ask(matchPrompt(job), [], { signal }),
    explain: (job, { signal }) => provider.ask(worded(explainPrompt(job), job), images(job), { signal, systemPrompt: job.systemPrompt }),
  });
  // The models that can answer: the one set by ANALYZER first, then those listed in MOUSE_MODELS. Which of them
  // answers new captures is picked on the directory page of the phone and kept in model.txt across restarts.
  const engines = [];
  for (const choice of [{ analyzer: config.analyzer || 'codex', model: config.model || '', effort: config.effort || '' }, ...config.models || []]) {
    const listed = engines.length > 0;   // an entry of MOUSE_MODELS: an effort written there is part of the choice
    const id = [choice.analyzer, choice.model, listed && choice.effort].filter(Boolean).join(':');
    if (engines.some(e => e.id === id)) continue;
    const demo = choice.analyzer === 'demo', label = demo ? '演示（不调用模型）' : [choice.model || choice.analyzer, listed && choice.effort].filter(Boolean).join(' · ');
    const provider = config.analyze || demo ? null : (config.createProvider || createProvider)({ dataDir, ...choice, deepseekKey: config.deepseekKey, openaiKey: config.apiKey, ocr: false, codexBin: config.codexBin, claudeBin: config.claudeBin });
    engines.push({ id, label, provider, ...demo ? { analyze: demoAnswer, match: demoMatch, explain: demoExplain } : asking(provider) });
  }
  const modelFile = path.join(dataDir, 'model.txt');
  let engine = engines[0];
  try { const saved = readFileSync(modelFile, 'utf8').trim(); engine = engines.find(e => e.id === saved) || engine; } catch {}
  // A record keeps the model that answered it; its problem list match and its explanation are asked of the same one.
  // Records from before there was a choice, or from a model that is no longer listed, go to the current one.
  const engineOf = job => engines.find(e => e.id === job.engine) || engine;
  const analyze = config.analyze || ((job, options) => engineOf(job).analyze(job, options));
  const match = config.match || (config.analyze ? null : (job, options) => engineOf(job).match(job, options));
  const explain = config.explain || ((job, options) => engineOf(job).explain(job, options));
  const source = new MouseSource(); const clients = new Set(); let sourceOnline = false;
  // Every screenshot is its own single-shot batch for the agent; a long press is a series of them.
  const requestShot = shot => source.push({ type: 'capture', batch: { id: shot, mode: 'single' } });
  const maxFrames = config.maxFrames || 12;
  const store = new JobStore({ analyze, match, explain, requestShot, prompt: readPrompt, engine: () => engine.id, stateFile: path.join(dataDir, 'state.json'), concurrency: config.concurrency || 2, captureTimeout: config.captureTimeout || 12000, interval: config.interval || 500, maxFrames, holdTimeout: config.holdTimeout || 3000 });
  // Photos from the camera page wait here, batch by batch, until a batch is submitted and becomes one job.
  // What is left behind (a closed page, a restart) is removed after a while, or at the next start.
  const incomingDir = path.join(dataDir, 'incoming'); rmSync(incomingDir, { recursive: true, force: true }); mkdirSync(incomingDir, { recursive: true });
  const batches = new Map();   // batch id -> { photos: Map(number given by the page -> frame id), touched }
  const incoming = frameId => path.join(incomingDir, `${frameId}.jpg`);
  const dropPhoto = (batch, n) => { try { unlinkSync(incoming(batch.photos.get(n))); } catch {} batch.photos.delete(n); };
  const dropBatch = id => { const batch = batches.get(id); for (const n of [...batch?.photos.keys() || []]) dropPhoto(batch, n); batches.delete(id); };
  if (!existsSync(promptFile)) writeFileSync(promptFile, store.state.systemPrompt || '');   // earlier versions kept it in state.json
  delete store.state.systemPrompt;
  const send = (ws, e) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e)); };
  const broadcast = e => { for (const ws of clients) send(ws, e); };
  const sourceChanged = () => { sourceOnline = source.online; broadcast({ type: 'source', source: source.status() }); };
  const snapshot = () => ({ jobs: store.state.jobs.slice(-300).map(j => store.summary(j)), source: source.status(), engines: engines.map(({ id, label }) => ({ id, label })), engine: engine.id, maxFrames, now: new Date().toISOString() });
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
      if (req.method === 'GET' && url.pathname === '/phone-ca.crt' && phoneCa) {
        res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="shiyue-phone-ca.crt"' });
        return res.end(phoneCa.raw);
      }
      if (staticFiles[url.pathname] && req.method === 'GET') {
        const [name, mime] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); return res.end(readFileSync(path.join(root, 'public', 'mouse', name)));
      }
      // Browsers ask for /favicon.ico on their own; that must not count as a wrong pairing code.
      if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: '找不到页面' });
      if (blocked(ip)) return json(res, 429, { error: '配对码错误次数过多，请一分钟后再试' });
      if (!authorized(req.headers.authorization?.replace(/^Bearer /, ''))) { failed(ip); return json(res, 401, { error: '请填写电脑终端显示的配对码' }); }
      const get = req.method === 'GET', post = req.method === 'POST', clientId = req.headers['x-client-id'], id = url.searchParams.get('id');
      if (await voice.handle(req, res, url.pathname)) return;

      // Phone page
      if (get && url.pathname === '/api/state') return json(res, 200, snapshot());
      if (post && url.pathname === '/api/retry') {
        try { return json(res, 200, { job: store.detail(store.retry(id)) }); }
        catch (error) { return json(res, 409, { error: error.message }); }
      }
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
      // Picked on the directory page. It holds from the next capture or photo batch on, for every page connected.
      if (post && url.pathname === '/api/model') {
        const wanted = JSON.parse((await body(req, 2000)).toString()).engine, chosen = engines.find(e => e.id === wanted);
        if (!chosen) return json(res, 400, { error: '没有这个模型，请刷新页面后再选' });
        engine = chosen; writeFileSync(modelFile, engine.id); broadcast({ type: 'engine', engine: engine.id });
        return json(res, 200, { engine: engine.id });
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

      // Camera page (a second phone or tablet): each photo is uploaded as it is taken, and "submit" makes one job
      // of a batch. From there on it is answered and shown like a capture.
      if (post && url.pathname === '/api/camera/photo') {
        const batchId = url.searchParams.get('batch'), n = Number(url.searchParams.get('n'));
        if (!validId(batchId) || !Number.isInteger(n) || n < 0 || n > 9999) return json(res, 400, { error: '照片标识无效' });
        let jpeg;
        try { jpeg = await sharp(await body(req), { limitInputPixels: 64_000_000 }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer(); }
        catch { return json(res, 400, { error: '无法识别这张图片' }); }
        let batch = batches.get(batchId);
        if (!batch) { if (batches.size >= 20) return json(res, 429, { error: '还没有提交的拍摄批次太多，请先完成或取消' }); batches.set(batchId, batch = { photos: new Map() }); }
        if (batch.photos.has(n)) dropPhoto(batch, n);   // sent again after a failed upload
        if (batch.photos.size >= maxFrames) return json(res, 400, { error: `一次最多 ${maxFrames} 张` });
        const frameId = randomUUID(); writeFileSync(incoming(frameId), jpeg); batch.photos.set(n, frameId); batch.touched = Date.now();
        return json(res, 200, { n, count: batch.photos.size });
      }
      if (post && url.pathname === '/api/camera/submit') {
        const msg = JSON.parse((await body(req, 20000)).toString()), batch = batches.get(msg.batch), order = Array.isArray(msg.photos) ? msg.photos : [];
        if (!batch || !order.length || new Set(order).size !== order.length || !order.every(n => batch.photos.has(n))) return json(res, 400, { error: '照片没有全部传到电脑，请再提交一次' });
        if (store.pending >= 20) return json(res, 429, { error: '等待解析的图片太多，请稍后再提交' });
        const frames = order.map(n => { const id = batch.photos.get(n), file = path.join(imageDir, `${id}.jpg`); renameSync(incoming(id), file); batch.photos.delete(n); return { id, path: file }; });
        dropBatch(msg.batch);   // with the photos that were taken but left out
        return json(res, 200, { job: store.detail(store.submit(frames)) });
      }
      if (post && url.pathname === '/api/camera/discard') {
        const batch = batches.get(url.searchParams.get('batch')), n = url.searchParams.get('n');
        if (batch && n !== null) dropPhoto(batch, Number(n)); else dropBatch(url.searchParams.get('batch'));
        return json(res, 200, { ok: true });
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
  const voice = createVoiceRoutes({ config, body, json, engine: () => engine, prompt: readPrompt });
  const server = config.tlsKey && config.tlsCert ? https.createServer({ key: readFileSync(config.tlsKey), cert: readFileSync(config.tlsCert) }, handler) : http.createServer(handler);
  const httpsServer = extraTls ? https.createServer(extraTls, handler) : null;
  const servers = [server, httpsServer].filter(Boolean);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4000 });
  for (const listener of servers) listener.on('upgrade', (req, socket, head) => {
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
    for (const [id, batch] of batches) if (Date.now() - batch.touched > 15 * 60000) dropBatch(id);
    // Phones on Wi-Fi power saving answer late; only a long silence counts as a dead socket.
    for (const ws of clients) { if (Date.now() - ws.seen > 15000) ws.terminate(); else ws.ping(); }
  }, 3000); heartbeat.unref();
  return { server, httpsServer, store, source, token, promptFile, engines, get engine() { return engine; }, async close() { voice.close(); clearInterval(heartbeat); store.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await Promise.all(servers.map(listener => new Promise(r => listener.close(r)))); for (const e of engines) await e.provider?.close?.(); } };
}

// MOUSE_MODELS: the models offered besides the one in ANALYZER, as "openai:gpt-5.6-sol", or with a reasoning
// effort "openai:gpt-5.6-sol:high"; several are separated by commas.
export function parseModels(text) {
  return String(text || '').split(/[,，\s]+/).filter(Boolean).map(entry => {
    const [analyzer, model = '', effort = ''] = entry.split(':');
    if (!ANALYZERS.includes(analyzer) || (effort && !EFFORTS.includes(effort))) throw Error(`MOUSE_MODELS 里的“${entry}”无法识别。写法是 openai:模型名，或带推理强度的 openai:模型名:high，多个用逗号分隔`);
    return { analyzer, model, effort };
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const host = env.MOUSE_HOST || env.HOST || '127.0.0.1', port = Number(env.MOUSE_PORT || 8790), scheme = env.TLS_CERT ? 'https' : 'http';
  const httpsPort = env.MOUSE_HTTPS_PORT ? Number(env.MOUSE_HTTPS_PORT) : null;
  if (httpsPort !== null && (!Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535 || httpsPort === port)) throw Error('MOUSE_HTTPS_PORT 必须是与 MOUSE_PORT 不同的有效端口');
  if (httpsPort && (!env.MOUSE_TLS_KEY || !env.MOUSE_TLS_CERT)) throw Error('启用 MOUSE_HTTPS_PORT 时必须配置 MOUSE_TLS_KEY 和 MOUSE_TLS_CERT');
  const app = createMouseApp({ dataDir: env.MOUSE_DATA_DIR, token: env.PAIR_TOKEN, apiKey: env.OPENAI_API_KEY, voiceSttModel: env.VOICE_STT_MODEL, analyzer: env.ANALYZER, model: env.ANALYZER_MODEL, effort: env.ANALYZER_EFFORT, models: parseModels(env.MOUSE_MODELS), deepseekKey: env.DEEPSEEK_API_KEY, codexBin: env.CODEX_BIN, claudeBin: env.CLAUDE_BIN, tlsKey: env.TLS_KEY, tlsCert: env.TLS_CERT, httpsKey: httpsPort ? env.MOUSE_TLS_KEY : undefined, httpsCert: httpsPort ? env.MOUSE_TLS_CERT : undefined, phoneCa: env.MOUSE_PHONE_CA, concurrency: Number(env.MOUSE_CONCURRENCY) || undefined, maxFrames: Number(env.MOUSE_MAX_FRAMES) || undefined });
  if (app.httpsServer) app.httpsServer.listen(httpsPort, host, () => {
    console.log(`手机 HTTPS 入口已启动，监听 ${host}:${httpsPort}，与原入口共用配对码、模型与记录`);
    const addresses = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
    for (const address of addresses) console.log(`手机录音：https://${address}:${httpsPort}/voice；先安装 CA：${scheme}://${address}:${port}/phone-ca.crt`);
  });
  app.server.listen(port, host, () => {
    console.log(`拾页 · 鼠标版: ${scheme}://localhost:${port}/#pair=${app.token}`);
    console.log(`配对码 ${app.token} | 监听 ${host}:${port} | 解答模型 ${app.engine.label}`);
    if (app.engines.length > 1) console.log(`可选模型：${app.engines.map(e => e.label).join('、')}。在手机目录页的顶栏切换，选择保存在 data/mouse/model.txt`);
    console.log(`任务背景（System Prompt）：用记事本编辑 ${app.promptFile} 并保存，下一次截图起生效`);
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) { console.log('当前只监听本机。手机和截图端要连接，请在 .env 设置 HOST=0.0.0.0 后重启。'); return; }
    const addresses = Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address);
    for (const address of addresses) console.log(`手机浏览器打开 ${scheme}://${address}:${port} 并输入配对码；截图端地址填 ${scheme}://${address}:${port}；拍照用的手机或平板打开 ${scheme}://${address}:${port}/camera`);
  });
}

