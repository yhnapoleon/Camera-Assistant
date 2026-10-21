import { VoiceRecorder } from './voice-recorder.js';

const $ = id => document.getElementById(id);
let token = new URLSearchParams(location.hash.slice(1)).get('pair') || '';
try { token ||= localStorage.getItem('mousePair') || ''; } catch {}
history.replaceState({ voice: true }, '', location.pathname);
let ready = false, ticker;
const labels = { idle: '准备好了，左键开始录音', requesting: '请允许浏览器使用麦克风…', recording: '正在录音，右键结束并回答', stopping: '正在结束录音…', processing: '正在上传并转写…', done: '回答完成，左键可开始下一个问题' };
function stateChanged(state, message) {
  document.body.dataset.state = state; $('status').textContent = message || labels[state] || '';
  $('start').disabled = !ready || !['idle', 'done', 'error'].includes(state);
  $('stop').disabled = !['requesting', 'recording'].includes(state);
  $('cancel').disabled = !['requesting', 'recording', 'stopping', 'processing'].includes(state);
  clearInterval(ticker);
  if (state === 'recording') {
    $('questionPanel').hidden = $('answerPanel').hidden = true; $('question').textContent = $('answer').textContent = '';
    const update = () => { const seconds = Math.floor((Date.now() - recorder.startedAt) / 1000); $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
    update(); ticker = setInterval(update, 500);
  }
}
async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  if (response.status === 401) { ready = false; $('pairForm').hidden = false; }
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw Error(result.error || `请求失败 ${response.status}`); }
  return response;
}
async function submit(audio, { signal }) {
  const response = await api('/api/voice', { method: 'POST', headers: { 'Content-Type': audio.type }, body: audio, signal });
  const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '', answered = false;
  const event = line => {
    if (!line.trim()) return;
    signal.throwIfAborted(); const data = JSON.parse(line);
    if (data.type === 'error') throw Error(data.error);
    if (data.type === 'transcript') {
      $('question').textContent = data.text; $('questionPanel').hidden = false;
      $('status').textContent = '已转写，正在理解问题并生成答案…'; $('engine').textContent = `解答模型：${data.engine}`;
    }
    if (data.type === 'answer') { $('answer').textContent = data.text; $('answerPanel').hidden = false; answered = true; }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(event);
      if (done) break;
    }
    if (pending.trim()) event(pending);
    if (!answered) throw Error('连接在答案完成前断开，请重新录音提问');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
const recorder = new VoiceRecorder({ submit, onState: stateChanged });
async function connect() {
  ready = false; stateChanged('idle', '正在连接…');
  if (!token) { $('pairForm').hidden = false; stateChanged('idle', '请先输入配对码'); return; }
  try {
    const config = await (await api('/api/voice/config')).json();
    $('engine').textContent = `解答模型：${config.engine}`; $('pairForm').hidden = true;
    try { localStorage.setItem('mousePair', token); } catch {}
    if (!config.enabled) throw Error('请在解析端配置 OPENAI_API_KEY，然后重启服务');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('麦克风需要 HTTPS 或 localhost。手机可配置 HTTPS，或用 USB 转发后访问 localhost:8790');
    if (!window.MediaRecorder) throw Error('浏览器不支持录音，请使用新版 Chrome、Edge 或 Safari');
    recorder.maxMs = config.maxSeconds * 1000; recorder.maxBytes = config.maxBytes;
    ready = true; stateChanged('idle');
  } catch (error) { stateChanged('error', error.message); }
}
$('pairForm').onsubmit = event => { event.preventDefault(); token = $('pair').value.trim(); connect(); };
const start = () => { if (ready) recorder.start(); };
$('start').onclick = start; $('stop').onclick = () => recorder.stop(); $('cancel').onclick = () => recorder.cancel();
document.addEventListener('click', event => { if (event.button === 0 && !event.target.closest('a,button,input,form')) start(); });
// A few Android browsers omit contextmenu but still deliver the secondary button release.
document.addEventListener('pointerup', event => { if (event.button === 2) { event.preventDefault(); recorder.stop(); } });
document.addEventListener('contextmenu', event => { event.preventDefault(); recorder.stop(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') recorder.cancel(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && ['requesting', 'recording'].includes(recorder.state)) { recorder.cancel(); stateChanged('idle', '页面离开前台，已取消录音；左键重新开始'); }
});
addEventListener('pagehide', () => recorder.cancel());
// Some phones translate the right mouse button into Back. Guard the voice page while working.
history.pushState({ voiceGuard: true }, '', location.pathname);
addEventListener('popstate', () => {
  if (['requesting', 'recording', 'stopping', 'processing'].includes(recorder.state)) { recorder.stop(); history.pushState({ voiceGuard: true }, '', location.pathname); }
  else { recorder.cancel(); location.replace('/'); }
});
$('home').onclick = event => { event.preventDefault(); recorder.cancel(); location.replace('/'); };
addEventListener('pageshow', event => { if (event.persisted) connect(); });
connect();
