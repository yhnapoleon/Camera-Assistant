import { CaptureController } from './capture.js';
const $ = id => document.getElementById(id);
let token = new URLSearchParams(location.hash.slice(1)).get('pair') || sessionStorage.getItem('pair') || '';
$('pair').value = token; if (location.hash) history.replaceState(null, '', location.pathname);
let ws, clientId, config, state, videoStream, micStream, micNode, micSource, audioContext, wakeLock, listening = false;
let partial = '', localUpload = false, selectedSource = 'screen', previewId, previewUrl;
const notice = text => { $('notice').textContent = text; $('notice').hidden = !text; };
const send = event => { if (ws?.readyState !== WebSocket.OPEN || !clientId) throw Error('请先连接会话'); ws.send(JSON.stringify(event)); };
const safe = fn => (...args) => Promise.resolve().then(() => fn(...args)).catch(e => notice(e.message));
async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'X-Client-Id': clientId || '', ...options.headers } });
  if (!res.ok) { const data = await res.json().catch(() => ({})); const error = Error(data.error || `请求失败 ${res.status}`); error.status = res.status; throw error; } return res;
}
async function audioReady() {
  audioContext ||= new AudioContext({ sampleRate: 24000 });
  if (audioContext.state !== 'running') await audioContext.resume();
}
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && clientId) keepAwake(); });
async function openCamera() {
  if (!navigator.mediaDevices) throw Error('摄像头需要 HTTPS，或通过 USB 转发后访问 localhost');
  videoStream?.getTracks().forEach(t => t.stop());
  videoStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
  $('camera').srcObject = videoStream; await $('camera').play(); $('cameraEmpty').hidden = true; await keepAwake();
}
function snapshot() {
  const v = $('camera'); if (!v.videoWidth || !videoStream?.active) throw Error('请先打开摄像头');
  const canvas = document.createElement('canvas'); const scale = Math.min(1, 2000 / v.videoWidth);
  canvas.width = Math.round(v.videoWidth * scale); canvas.height = Math.round(v.videoHeight * scale);
  canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error('未能拍摄图片')), 'image/jpeg', .9));
}
async function upload(blob, batch, capturedAt) {
  const frameId = crypto.randomUUID(); const params = new URLSearchParams({ batchId: batch.id, frameId, capturedAt });
  // Retry the same frame ID, so a lost response cannot create duplicate photos.
  let error;
  for (let i = 0; i < 2; i++) {
    try { await api(`/api/frame?${params}`, { method: 'POST', body: blob, headers: { 'Content-Type': blob.type }, signal: AbortSignal.timeout(15000) }); return; }
    catch (e) { error = e; }
  }
  throw error;
}
const capture = new CaptureController({ snapshot, upload,
  onFinish: (batch, error) => { if (error) notice(error); if (clientId) send({ type: 'finish', batchId: batch.id, error }); },
  onChange: c => { $('captureStatus').textContent = c.batch ? `${c.running ? '采集中' : '正在上传'} · ${c.count} 张 / ${c.pending} 张待上传` : '等待指令'; $('liveDot').hidden = !c.running; },
});

const playback = { queue: [], busy: false, paused: false, current: null, audio: new Audio(), abort: null, finish: null, cancelled: new Set() };
function setAudioStatus(text) { $('audioStatus').textContent = text; }
function pauseAudio() { playback.paused = true; playback.audio.pause(); setAudioStatus('播报已暂停'); }
function resumeAudio() { playback.paused = false; if (playback.current?.type === 'speech' && playback.audio.src) playback.audio.play().catch(e => notice(e.message)); runAudio(); }
function cancelAudio(taskIds = []) {
  for (const id of taskIds) playback.cancelled.add(id);
  playback.queue = playback.queue.filter(x => !taskIds.includes(x.taskId));
  if (taskIds.includes(playback.current?.taskId)) { playback.abort?.abort(); playback.audio.pause(); playback.finish?.(); }
}
function enqueue(item) { if (!playback.cancelled.has(item.taskId)) playback.queue.push(item); runAudio(); }
async function chime(failed) {
  await audioReady(); const start = audioContext.currentTime;
  const tones = failed ? [440, 330] : [660, 880];
  for (const [i, freq] of tones.entries()) {
    const osc = audioContext.createOscillator(), gain = audioContext.createGain(); osc.frequency.value = freq;
    gain.gain.setValueAtTime(.0001, start + i * .16); gain.gain.exponentialRampToValueAtTime(.10, start + i * .16 + .015); gain.gain.exponentialRampToValueAtTime(.0001, start + i * .16 + .2);
    osc.connect(gain).connect(audioContext.destination); osc.start(start + i * .16); osc.stop(start + i * .16 + .22);
  }
  await new Promise(r => setTimeout(r, 420));
}
async function runAudio() {
  if (playback.busy || playback.paused) return;
  playback.busy = true;
  try {
    while (playback.queue.length && !playback.paused) {
      const item = playback.queue.shift(); playback.current = item;
      if (item.type === 'chime') { setAudioStatus(item.failed ? '本批部分失败' : '本批静默处理完成'); await chime(item.failed); continue; }
      if (playback.cancelled.has(item.taskId)) continue;
      if (!config?.audioConfigured) { setAudioStatus('未配置 TTS，答案已显示'); continue; }
      playback.abort = new AbortController(); setAudioStatus('正在生成语音…');
      let res;
      for (let retry = 0; !res; retry++) {
        try { res = await api('/api/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: item.text }), signal: playback.abort.signal }); }
        catch (err) { if (err.status !== 429 || retry >= 30) throw err; await new Promise(r => setTimeout(r, 300)); }
      }
      if (playback.cancelled.has(item.taskId)) continue;
      const url = URL.createObjectURL(await res.blob());
      try {
        const audio = playback.audio; audio.src = url;
        await new Promise((resolve, reject) => {
          playback.finish = resolve; audio.onended = resolve; audio.onerror = () => reject(Error('音频播放失败，请点击重新播报'));
          if (!playback.paused) audio.play().then(() => setAudioStatus('正在播报')).catch(() => reject(Error('浏览器暂停了自动播放，请点击答案下方“重新播报”')));
        });
      } finally { URL.revokeObjectURL(url); playback.audio.removeAttribute('src'); playback.finish = null; }
    }
  } catch (e) { if (e.name !== 'AbortError') notice(e.message); }
  finally { playback.busy = false; playback.current = null; playback.abort = null; if (playback.queue.length && !playback.paused) runAudio(); }
}
function queueAnswer(taskId, texts) {
  playback.cancelled.delete(taskId);
  for (const text of texts) for (let i = 0; i < text.length; i += 700) enqueue({ type: 'speech', taskId, text: text.slice(i, i + 700) });
}
async function startMic() {
  if (!config?.audioConfigured) throw Error('请在电脑 .env 中配置 OPENAI_API_KEY 并重启服务');
  await audioReady();
  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    await audioContext.audioWorklet.addModule('/audio-worklet.js');
    micSource = audioContext.createMediaStreamSource(micStream); micNode = new AudioWorkletNode(audioContext, 'pcm-recorder');
    micNode.port.onmessage = ({ data }) => { if (listening && ws?.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 48000) { stopMic(); notice('音频网络拥堵，监听已停止，请重新开启'); } else ws.send(data); } };
    micSource.connect(micNode).connect(audioContext.destination);
  }
  send({ type: 'listen' }); $('micStatus').textContent = '正在连接转写服务…';
}
function stopMic() {
  listening = false; micNode?.disconnect(); micSource?.disconnect(); micStream?.getTracks().forEach(t => t.stop()); micStream = null; micNode = null;
  if (clientId) send({ type: 'unlisten' }); $('listen').textContent = '开启语音监听'; $('micStatus').textContent = '麦克风未开启';
}
async function ask(text) {
  const cutoff = new Date().toISOString(), batchId = capture.batch?.id || state?.batches.at(-1)?.id;
  const pendingAtQuestion = capture.settled(); await pendingAtQuestion; send({ type: 'question', text, cutoff, batchId });
}
function element(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
const statusLabels = { queued: '等待处理', processing: '正在分析', done: '已完成', duplicate: '重复，已复用', failed: '处理失败', running: '处理中', cancelled: '已取消' };
function render(s) {
  state = s; const latest = s.batches.at(-1); const frames = s.frames.filter(f => f.batchId === latest?.id);
  $('total').textContent = frames.length; $('processed').textContent = frames.filter(f => ['done', 'duplicate', 'failed'].includes(f.status)).length;
  $('pending').textContent = s.frames.filter(f => ['queued', 'processing'].includes(f.status)).length;
  if (selectedSource === 'screen') {
    const active = s.batches.some(b => !b.closed && b.sourceId);
    $('liveDot').hidden = !active; $('captureStatus').textContent = active ? '远程采集中' : '等待指令';
    const latestFrame = s.frames.at(-1);
    if (latestFrame && latestFrame.id !== previewId) {
      previewId = latestFrame.id;
      api(`/api/image?id=${previewId}`).then(r => r.blob()).then(blob => {
        if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = URL.createObjectURL(blob);
        $('screenPreview').src = previewUrl; $('screenPreview').hidden = selectedSource !== 'screen'; $('cameraEmpty').hidden = true;
      }).catch(e => notice(e.message));
    }
  }
  if (s.batches.length) {
    const list = document.createDocumentFragment();
    for (const b of s.batches.slice(-12).reverse()) {
      const box = element('div', undefined, 'batch'); const head = element('div', undefined, 'batch-head');
      head.append(element('b', `${{ single: '单张', five: '五连拍', long: '长程' }[b.mode]} · ${b.frames.length} 张`), element('span', b.notified ? (b.captureError ? '采集异常' : '处理结束') : b.closed ? '静默处理中' : '正在收集')); box.append(head);
      for (const [i, id] of b.frames.entries()) {
        const f = s.frames.find(f => f.id === id); const row = element('div', undefined, 'frame'); const preview = element('button', '查看');
        preview.onclick = safe(async () => { const res = await api(`/api/image?id=${id}`); const url = URL.createObjectURL(await res.blob()); const dialog = document.createElement('dialog'); const img = document.createElement('img'); img.src = url; img.alt = `采集图片 ${i + 1}`; img.style.maxWidth = '85vw'; img.style.maxHeight = '75vh'; const close = element('button', '关闭'); close.onclick = () => { dialog.close(); dialog.remove(); URL.revokeObjectURL(url); }; dialog.append(img, close); document.body.append(dialog); dialog.showModal(); });
        row.append(element('span', String(i + 1).padStart(2, '0')), preview, element('span', statusLabels[f.status], 'status')); box.append(row);
        if (f.error || f.observation) { const details = element('details'); details.append(element('summary', f.error ? '失败详情' : '查看整理结果'), element('pre', f.error || f.observation)); if (f.ocrWarning) details.append(element('p', f.ocrWarning)); box.append(details); }
      }
      list.append(box);
    }
    $('batches').replaceChildren(list);
  }
  if (s.tasks.length) {
    const list = document.createDocumentFragment();
    for (const t of s.tasks.slice(-12).reverse()) {
      const box = element('article', undefined, 'task'); box.append(element('h3', t.text), element('div', `${statusLabels[t.status]} · ${t.scope === 'unanswered' ? '全部未回答' : t.scope === 'batch' ? '整批' : '当前页'} · ${t.frameIds.length} 张已锁定`, 'task-meta'));
      for (const r of t.results) box.append(element('div', r.text, 'result'));
      if (t.error) box.append(element('p', t.error));
      if (t.status === 'done') { const replay = element('button', '重新播报', 'replay'); replay.onclick = safe(async () => { await audioReady(); playback.paused = false; queueAnswer(t.id, t.results.map(r => r.text)); }); box.append(replay); }
      list.append(box);
    }
    $('tasks').replaceChildren(list);
  }
}
async function onMessage(e) {
  if (e.type === 'hello') { clientId = e.clientId; $('connection').textContent = '● 已连接'; $('connection').classList.add('online'); $('connect').textContent = '结束会话'; config = await (await api('/api/config')).json(); $('systemPrompt').value = (await (await api('/api/settings')).json()).systemPrompt; $('modelInfo').textContent = config.analyzer === 'demo' ? '演示模式 · 不调用分析模型' : `${config.analyzer} · ${config.audioConfigured ? '语音 API 已配置' : '语音 API 未配置'}`; notice(''); await keepAwake(); }
  else if (e.type === 'state') render(e.state);
  else if (e.type === 'source.status') {
    selectedSource = e.selected; $('sourceSelect').value = selectedSource;
    $('sourceStatus').textContent = e.online ? `● ${e.name} 已连接` : '屏幕采集器未连接';
    $('cameraOn').hidden = selectedSource === 'screen'; $('camera').hidden = selectedSource === 'screen';
    $('screenPreview').hidden = selectedSource !== 'screen' || !previewUrl;
    $('sourceHint').textContent = selectedSource === 'screen' ? '在另一台 Windows 电脑启动采集器，框选区域' : '将镜头对准要整理的页面';
    $('viewLabel').textContent = selectedSource === 'screen' ? '固定区域截图 · 最新画面预览' : '后置摄像头 · 保持页面清晰';
    $('cameraEmpty').hidden = selectedSource === 'screen' ? !!previewUrl : !!videoStream?.active;
    if (state) render(state);
  }
  else if (e.type === 'remote.capture') $('captureStatus').textContent = '指令已发送，等待截图';
  else if (e.type === 'remote.stopping') $('captureStatus').textContent = '正在结束远程采集';
  else if (e.type === 'capture') {
    if (localUpload) { const files = localUpload; localUpload = false;
      capture.startImport(e.batch, files);
    } else { try { capture.start(e.batch); } catch (err) { send({ type: 'finish', batchId: e.batch.id, error: err.message }); throw err; } }
  }
  else if (e.type === 'stop') await capture.stop();
  else if (e.type === 'pause') pauseAudio();
  else if (e.type === 'resume') resumeAudio();
  else if (e.type === 'question.request') await ask(e.text);
  else if (e.type === 'transcript') { $('transcript').textContent = e.text; partial = ''; }
  else if (e.type === 'transcript.partial') { partial += e.text; $('transcript').textContent = partial; }
  else if (e.type === 'listening') { listening = e.active; $('listen').textContent = e.active ? '关闭语音监听' : '重新开启监听'; $('micStatus').textContent = e.active ? '● 持续监听中' : '转写连接已断开'; }
  else if (e.type === 'batch.complete') enqueue({ type: 'chime', failed: e.failed > 0 || e.incomplete });
  else if (e.type === 'answer') queueAnswer(e.taskId, e.chunks);
  else if (e.type === 'task.cancelled') cancelAudio(e.taskIds);
  else if (e.type === 'playback.clear') cancelAudio([...playback.queue.map(x => x.taskId), playback.current?.taskId].filter(Boolean));
  else if (e.type === 'error') { localUpload = false; notice(e.message); }
}
$('connect').onclick = safe(async () => {
  if (clientId) { await capture.stop(); stopMic(); ws.close(); videoStream?.getTracks().forEach(t => t.stop()); $('cameraEmpty').hidden = false; return; }
  if (ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.OPEN) return;
  token = $('pair').value.trim(); if (!token) throw Error('请输入电脑显示的配对码'); sessionStorage.setItem('pair', token); await audioReady();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token }));
  ws.onmessage = safe(event => onMessage(JSON.parse(event.data)));
  ws.onerror = () => notice('电脑连接失败，请检查地址与证书');
  ws.onclose = () => { clientId = null; capture.stop('连接已断开'); stopMic(); wakeLock?.release(); $('connection').textContent = '未连接'; $('connection').classList.remove('online'); $('connect').textContent = '连接会话 ↗'; };
});
$('cameraOn').onclick = safe(openCamera);
$('listen').onclick = safe(() => listening ? stopMic() : startMic());
$('stop').onclick = safe(async () => { if (selectedSource === 'camera') await capture.stop(); else send({ type: 'command', text: '停止' }); });
$('sourceSelect').onchange = safe(() => send({ type: 'source.select', source: $('sourceSelect').value }));
document.querySelectorAll('[data-command]').forEach(b => { b.onclick = safe(async () => { await audioReady(); send({ type: 'command', text: b.dataset.command }); }); });
$('commandForm').onsubmit = event => { event.preventDefault(); safe(() => { send({ type: 'command', text: $('commandText').value }); $('commandText').value = ''; })(); };
$('files').onchange = safe(async () => { if (!$('files').files.length) return; if (capture.batch || localUpload) throw Error('请先结束当前采集'); send({ type: 'source.select', source: 'camera' }); localUpload = [...$('files').files]; send({ type: 'command', text: localUpload.length === 1 ? '拍摄' : '长程' }); $('files').value = ''; });
if (!window.isSecureContext) notice('当前不是安全连接：请使用 HTTPS，或 USB 转发后的 localhost 地址，才能打开相机和麦克风。');
$('savePrompt').onclick = safe(async () => { await api('/api/settings', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ systemPrompt: $('systemPrompt').value }) }); $('promptStatus').textContent = '已保存；新批次与新问题生效'; });
$('applyRegion').onclick = safe(async () => { const region = Object.fromEntries(['x','y','width','height'].map(k => [k, Number($('region' + k[0].toUpperCase() + k.slice(1)).value)])); await api('/api/source/control', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'region',region}) }); notice('区域设置已发送，下一次截图使用新区域；可点“拍摄”检查。'); });
$('exitAgent').onclick = safe(async () => { await api('/api/source/control', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'exit'}) }); notice('已发送退出指令，采集器状态将在心跳过期后更新。'); });


$('checkPairing').onclick = safe(async () => {
  const button = $('checkPairing'), result = $('pairingResult'); button.disabled = true;
  try {
    if (!clientId) throw Error('请先输入配对码并点击“连接会话”');
    result.textContent = '正在检查控制端与采集器…';
    const status = await (await api('/api/pairing')).json();
    if (!status.controllerConnected) throw Error('控制会话已断开，请重新连接');
    if (!status.online) throw Error('控制端连接正常；采集器未连接或已离线，请在另一台电脑启动脚本');
    const { probeId } = await (await api('/api/pairing/check', {method:'POST'})).json();
    for (let attempt=0; attempt<20; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      const current = await (await api('/api/pairing')).json();
      if (current.online && current.lastProbe?.id === probeId) { result.textContent = `✓ 配对成功：${current.name} 已接收并确认检测指令。可点击“拍摄”验证截图。`; return; }
    }
    throw Error('控制端可访问，但采集器未在 10 秒内确认，可能正在上传或网络不畅；请稍后重试');
  } catch (error) { result.textContent = error.message; }
  finally { button.disabled = false; }
});
