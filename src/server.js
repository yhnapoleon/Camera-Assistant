import http from 'node:http';
import https from 'node:https';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import sharp from 'sharp';
import { Engine, parseCommand } from './core.js';
import { createProvider } from './providers.js';
import { transcriptionConfig, VoiceGate, TranscriptRouter, speechChunks } from './speech.js';
import { RemoteSource } from './remote-source.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/audio-worklet.js': ['audio-worklet.js', 'text/javascript'], '/capture.js': ['capture.js', 'text/javascript'] };
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const validId = s => typeof s === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(s);
async function body(req, limit = 8_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Error('上传内容过大'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function createApp(config = {}) {
  const dataDir = path.resolve(config.dataDir || path.join(root, 'data'));
  mkdirSync(path.join(dataDir, 'images'), { recursive: true });
  const token = config.token || randomBytes(24).toString('hex');
  const authorized = value => { const a = Buffer.from(value || ''), b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); };
  const provider = config.provider || createProvider({ dataDir, analyzer: config.analyzer || 'codex', model: config.model, effort: config.effort, deepseekKey: config.deepseekKey, openaiKey: config.apiKey, ocr: config.ocr !== false, codexBin: config.codexBin, claudeBin: config.claudeBin });
  const engine = new Engine({ provider, stateFile: path.join(dataDir, 'state.json') });
  let controller, ttsBusy = false;
  const source = new RemoteSource(); let selectedSource = config.source || 'screen';
  const send = (ws, e) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e)); };
  const broadcast = e => send(controller, e.type === 'answer' ? { ...e, chunks: e.results.flatMap((r, i) => speechChunks(`第 ${i + 1} 页。${r.text}`)) } : e);
  engine.on('event', broadcast);
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, { error: '只接受同源请求' });
      if (staticFiles[url.pathname] && req.method === 'GET') {
        const [name, mime] = staticFiles[url.pathname]; res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); return res.end(readFileSync(path.join(root, 'public', name)));
      }
      if (!authorized(req.headers.authorization?.replace(/^Bearer /, ''))) return json(res, 401, { error: '请填写电脑终端显示的配对码' });
      if (req.method === 'GET' && url.pathname === '/api/pairing') return json(res, 200, { controllerConnected: controller?.readyState === WebSocket.OPEN, ...source.status() });
      if (req.method === 'POST' && url.pathname === '/api/pairing/check') {
        const probe = source.push({ type: 'ping' }); return json(res, 200, { probeId: probe.id });
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') return json(res, 200, { systemPrompt: engine.state.systemPrompt || '' });
      if (req.method === 'POST' && url.pathname === '/api/settings') {
        const msg = JSON.parse((await body(req, 50000)).toString());
        if (typeof msg.systemPrompt !== 'string' || msg.systemPrompt.length > 12000) throw Error('任务背景最多 12000 字');
        engine.state.systemPrompt = msg.systemPrompt; engine.changed(); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/source/control') {
        const msg = JSON.parse((await body(req, 2000)).toString());
        if (engine.state.batches.some(b => !b.closed)) throw Error('请先停止当前采集，再更改区域或退出');
        if (msg.type === 'region') {
          const r = msg.region;
          if (!r || !['x','y','width','height'].every(k => Number.isSafeInteger(r[k])) || r.width < 1 || r.height < 1 || r.width * r.height > 32000000 || Math.abs(r.x) > 32000 || Math.abs(r.y) > 32000) throw Error('区域坐标无效');
          source.push({ type: 'region', region: r });
        } else if (msg.type === 'exit') source.push({ type: 'exit' });
        else throw Error('无效采集器指令');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/source/register') {
        const msg = JSON.parse((await body(req, 2000)).toString()); const clientId = source.register(msg.name);
        broadcast({ type: 'source.status', ...source.status(), selected: selectedSource }); return json(res, 200, { clientId });
      }
      if (req.method === 'GET' && url.pathname === '/api/source/poll') return json(res, 200, source.poll(req.headers['x-client-id'], url.searchParams.get('ack')));
      if (req.method === 'POST' && url.pathname === '/api/source/finish') {
        source.validate(req.headers['x-client-id']); const msg = JSON.parse((await body(req, 4000)).toString());
        const b = engine.state.batches.find(b => b.id === msg.batchId && b.sourceId === source.session.id);
        if (!b) throw Error('屏幕采集批次不匹配'); engine.finishBatch(b.id, msg.error); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/source/question') {
        source.validate(req.headers['x-client-id']); const msg = JSON.parse((await body(req, 16000)).toString());
        const task = engine.ask(String(msg.text || '').slice(0, 4000), { batchId: msg.batchId }); return json(res, 200, { taskId: task.id });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { analyzer: config.analyzer || 'codex', stt: config.sttModel || 'gpt-live-transcribe', tts: config.ttsModel || 'gpt-4o-mini-tts', voice: config.ttsVoice || 'marin', audioConfigured: !!config.apiKey });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, engine.publicState());
      if (req.method === 'GET' && url.pathname === '/api/image') {
        const frame = engine.frame(url.searchParams.get('id')); if (!frame) return json(res, 404, { error: '找不到图片' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end(readFileSync(frame.path));
      }
      if (req.method === 'POST' && url.pathname === '/api/frame') {
        const id = url.searchParams.get('frameId'), batchId = url.searchParams.get('batchId');
        if (!validId(id) || !validId(batchId)) return json(res, 400, { error: '图片标识无效' });
        const batch = engine.state.batches.find(b => b.id === batchId);
        const expectedClient = batch?.sourceId || controller?.clientId;
        if (!expectedClient || req.headers['x-client-id'] !== expectedClient) return json(res, 403, { error: '请先连接正确的采集会话' });
        const buffer = await body(req);
        const existing = engine.frame(id);
        if (existing) {
          if (existing.batchId !== batchId) return json(res, 409, { error: '图片标识冲突' });
          return json(res, 200, { id });
        }
        const jpeg = await sharp(buffer, { limitInputPixels: 32_000_000 }).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
        // Recheck after async decode: concurrent duplicate uploads must not overwrite accepted files.
        if (engine.frame(id)) return json(res, 200, { id });
        const imagePath = path.join(dataDir, 'images', `${id}.jpg`); writeFileSync(imagePath, jpeg);
        try { engine.addFrame(batchId, { id, path: imagePath, capturedAt: url.searchParams.get('capturedAt') || undefined }); }
        catch (e) { unlinkSync(imagePath); throw e; }
        return json(res, 200, { id });
      }
      if (req.method === 'POST' && url.pathname === '/api/speech') {
        if (!config.apiKey) return json(res, 503, { error: '尚未配置 OPENAI_API_KEY，文字结果仍可使用' });
        if (ttsBusy) return json(res, 429, { error: '上一段语音仍在生成，请稍后重试' });
        const { text } = JSON.parse((await body(req, 16000)).toString());
        if (typeof text !== 'string' || !text.trim() || text.length > 1000) return json(res, 400, { error: '每段语音应为 1–1000 字' });
        ttsBusy = true;
        const abort = new AbortController(); const disconnected = () => { if (!res.writableEnded) abort.abort(); };
        res.on('close', disconnected);
        try {
          const response = await (config.speechFetch || fetch)('https://api.openai.com/v1/audio/speech', { method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60000)]), body: JSON.stringify({ model: config.ttsModel || 'gpt-4o-mini-tts', voice: config.ttsVoice || 'marin', input: text, instructions: '用清晰自然的普通话朗读，语速适中，题号和答案之间稍作停顿。', response_format: 'mp3' }) });
          if (!response.ok) throw Error(`语音合成 API 返回 ${response.status}，请检查模型权限和额度`);
          res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(Buffer.from(await response.arrayBuffer()));
        } finally { ttsBusy = false; res.removeListener('close', disconnected); }
      }
      json(res, 404, { error: '找不到接口' });
    } catch (e) { if (!res.headersSent) json(res, 400, { error: e.message }); else res.end(); }
  };
  const server = config.tlsKey && config.tlsCert ? https.createServer({ key: readFileSync(config.tlsKey), cert: readFileSync(config.tlsCert) }, handler) : http.createServer(handler);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64_000 });
  server.on('upgrade', (req, socket, head) => {
    try {
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    } catch { socket.destroy(); }
  });
  wss.on('connection', ws => {
    let paired = false, upstream, gate, ready = false;
    const timer = setTimeout(() => { if (!paired) ws.close(1008, 'Pair first'); }, 5000);
    const error = message => send(ws, { type: 'error', message });
    const route = text => {
      send(ws, { type: 'transcript', text }); const command = parseCommand(text); if (!command) return;
      if (command.type === 'capture') {
        if (selectedSource === 'screen' && !source.online) throw Error('请先在另一台电脑启动屏幕采集器');
        const batch = engine.startBatch(command.mode);
        if (selectedSource === 'screen') { batch.sourceId = source.session.id; engine.changed(); source.push({ type: 'capture', batch }); send(ws, { type: 'remote.capture', batch }); }
        else send(ws, { type: 'capture', batch });
      }
      else if (command.type === 'question') send(ws, { type: 'question.request', text: command.text });
      else if (command.type === 'cancel') { engine.cancelTask(); send(ws, { type: 'playback.clear' }); }
      else if (command.type === 'stop' && selectedSource === 'screen') { source.push({ type: 'stop' }); send(ws, { type: 'remote.stopping' }); }
      else send(ws, { type: command.type });
    };
    const listen = () => {
      if (upstream) { const old = upstream; upstream = null; old.close(); } ready = false;
      if (!config.apiKey) { error('尚未配置 OPENAI_API_KEY，可先使用按钮和文字指令'); return; }
      const remote = config.openSTT ? config.openSTT() : new WebSocket('wss://api.openai.com/v1/realtime?intent=transcription', { headers: { Authorization: `Bearer ${config.apiKey}` }, handshakeTimeout: 15000 });
      upstream = remote;
      gate = new VoiceGate(e => { if (remote.readyState === WebSocket.OPEN && ready) remote.send(JSON.stringify(e)); });
      const router = new TranscriptRouter(text => { try { route(text); } catch (e) { error(e.message); } });
      remote.on('open', () => { if (upstream === remote) remote.send(JSON.stringify(transcriptionConfig(config.sttModel))); });
      remote.on('message', data => {
        if (upstream !== remote) return;
        try {
          const e = JSON.parse(data);
          if (e.type === 'session.updated' || e.type === 'transcription_session.updated') { ready = true; send(ws, { type: 'listening', active: true }); }
          if (e.type.endsWith('input_audio_transcription.delta')) send(ws, { type: 'transcript.partial', text: e.delta || '' });
          router.handle(e);
          if (e.type === 'error' || e.type.endsWith('input_audio_transcription.failed')) error(e.error?.message || '语音识别失败');
        } catch (e) { error(e.message); }
      });
      remote.on('error', () => { if (upstream === remote) error('无法连接语音服务，请检查网络、API key 和模型权限'); });
      remote.on('close', () => { if (upstream === remote) { ready = false; upstream = null; send(ws, { type: 'listening', active: false }); } });
    };
    ws.on('message', (data, binary) => {
      try {
        if (binary) { if (paired && ready && data.length <= 12000) gate.push(data); return; }
        const msg = JSON.parse(data);
        if (!paired) {
          if (msg.type !== 'hello' || !authorized(msg.token)) { ws.close(1008, 'Invalid pairing'); return; }
          if (controller?.readyState === WebSocket.OPEN) { error('已有手机连接，请先结束另一个会话'); ws.close(1008, 'Busy'); return; }
          paired = true; controller = ws; ws.clientId = randomUUID(); clearTimeout(timer);
          send(ws, { type: 'hello', clientId: ws.clientId }); send(ws, { type: 'state', state: engine.publicState() }); send(ws, { type: 'source.status', ...source.status(), selected: selectedSource }); return;
        }
        if (msg.type === 'command') route(String(msg.text).slice(0, 4000));
        else if (msg.type === 'source.select') {
          if (engine.state.batches.some(b => !b.closed)) throw Error('先停止当前采集再切换来源');
          if (!['camera', 'screen'].includes(msg.source)) throw Error('无效图片来源');
          selectedSource = msg.source; send(ws, { type: 'source.status', ...source.status(), selected: selectedSource });
        }
        else if (msg.type === 'finish') engine.finishBatch(msg.batchId, msg.error?.slice(0, 300));
        else if (msg.type === 'question') {
          const text = String(msg.text || '').slice(0, 4000);
          if (selectedSource === 'screen' && source.online) source.push({ type: 'question', text, batchId: msg.batchId || engine.state.batches.at(-1)?.id });
          else engine.ask(text, { batchId: msg.batchId, cutoff: msg.cutoff });
        }
        else if (msg.type === 'listen') listen();
        else if (msg.type === 'unlisten') { const old = upstream; upstream = null; old?.close(); ready = false; send(ws, { type: 'listening', active: false }); }
      } catch (e) { error(e.message); }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(timer); const old = upstream; upstream = null; old?.close();
      if (controller === ws) { controller = null; for (const b of engine.state.batches.filter(b => !b.closed)) engine.finishBatch(b.id, '手机连接中断，采集停止'); }
    });
  });
  const heartbeat = setInterval(() => {
    broadcast({ type: 'source.status', ...source.status(), selected: selectedSource });
    if (!source.online) for (const b of engine.state.batches.filter(b => b.sourceId && !b.closed)) engine.finishBatch(b.id, '屏幕采集器连接中断');
  }, 3000); heartbeat.unref();
  return { server, engine, token, async close() { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); await provider.close?.(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const app = createApp({ apiKey: env.OPENAI_API_KEY, token: env.PAIR_TOKEN, analyzer: env.ANALYZER, model: env.ANALYZER_MODEL, effort: env.ANALYZER_EFFORT, deepseekKey: env.DEEPSEEK_API_KEY, ocr: env.OCR_ENABLED !== 'false', codexBin: env.CODEX_BIN, claudeBin: env.CLAUDE_BIN, sttModel: env.STT_MODEL, ttsModel: env.TTS_MODEL, ttsVoice: env.TTS_VOICE, tlsKey: env.TLS_KEY, tlsCert: env.TLS_CERT });
  const host = env.HOST || '127.0.0.1', port = Number(env.PORT || 8787);
  app.server.listen(port, host, () => {
    console.log(`Camera Study Assistant: ${env.TLS_CERT ? 'https' : 'http'}://localhost:${port}/#pair=${app.token}`);
    console.log(`监听 ${host}:${port} | 分析 ${env.ANALYZER || 'codex'} | 语音 API ${env.OPENAI_API_KEY ? '已配置，待会话连接' : '未配置'}`);
  });
}
