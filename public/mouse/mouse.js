const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
const saved = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const active = j => j.status === 'capturing' || j.status === 'analyzing';
const working = j => j.explainStatus === 'running' || j.matchStatus === 'running';   // answered, with more on its way
const pictures = j => j.mode === 'camera' ? '照片' : '截图';   // sent from the camera page, or captured on the other computer
const clock = iso => new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
const LONG_MS = 500, DOUBLE_MS = 300;   // hold this long for a burst; second click within this time for a double click
const root = document.documentElement, scroller = $('scroll');

let token = new URLSearchParams(location.hash.slice(1)).get('pair') || saved.get('mousePair') || '';
if (location.hash) history.replaceState(history.state, '', location.pathname);
$('pair').value = token;

const jobs = new Map(), rows = new Map(), images = new Map();
let ws, retry = 0, retryTimer, entered = false, armed = false, linked = false, sourceState = null, skew = 0;
// The models the computer can ask, and the one that answers the next capture. A record names its own as "provider:model".
let engines = [], engineId = '';
const modelName = id => engines.find(e => e.id === id)?.label || String(id || '').split(':').slice(1).join(' · ') || id || '';
const drafted = job => !!job?.insights?.some(i => i.draft === 'part' || i.draft === 'full');   // written on top of the user's own code
let view = 'list', currentId = null, detail = false, wantDetail = false, shownKey = '', listScroll = 0, selfBack = false;
// A programming problem is read in two levels: 'insight' (problem list match and tags) first, then 'code'. Everything else is 'code' only.
let level = 'code', lastLevel = 0;
let pitch = 25, scrollTarget = null, targetTimer, markTimer, lastFlip = 0;   // pitch: height of one text line in px
let pointerType = matchMedia('(any-pointer: fine)').matches ? 'mouse' : 'touch', press = null, clickTimer = null, lastOpen = 0, lastTrigger = 0, lastRight = 0, sending = false, toastTimer, wakeLock;
let lastPointerInput = null;
let touchScroll = null, suppressTouchClickUntil = 0;
// Phone and computer clocks differ; running times are measured on the computer's clock.
const since = iso => Math.max(0, Math.round((Date.now() - skew - Date.parse(iso)) / 1000));
const took = j => j.finishedAt ? Math.max(0, Math.round((Date.parse(j.finishedAt) - Date.parse(j.createdAt)) / 1000)) : since(j.createdAt);

function toast(text, bad) {
  const box = $('toast'); box.textContent = text; box.className = bad ? 'bad' : ''; box.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { box.hidden = true; }, bad ? 6000 : 2500);
}
function note(text) { $('inputLog').textContent = `${text} · ${clock(Date.now())}`; }
function buzz(pattern) { if (saved.get('mouseVibrate') === '1') { try { navigator.vibrate?.(pattern); } catch {} } }
// Landscape by default. A phone that stays in portrait (rotation locked) gets its content turned by the page.
function orient() {
  const mode = saved.get('mouseTurn') || 'landscape';
  root.style.setProperty('--vw', `${innerWidth}px`); root.style.setProperty('--vh', `${innerHeight}px`);
  root.classList.toggle('turned', entered && mode !== 'follow' && innerHeight > innerWidth); root.classList.toggle('flipped', mode === 'flipped');
  render();
}
// Text size follows "lines per screen": the short side of the screen divided by that number is one line.
function fit() {
  const app = $('app'), count = Number(saved.get('mouseLines')) || 12;
  const next = Math.max(12, Math.floor(Math.min(app.clientHeight, app.clientWidth) / count));
  if (next !== pitch) { pitch = next; root.style.setProperty('--row', `${pitch}px`); }
  // The answer area is trimmed to whole lines, so the bottom edge never cuts through one.
  const free = app.clientHeight - ($('bar').hidden ? 0 : $('bar').offsetHeight);
  $('rest').style.height = `${view === 'answer' ? free % pitch : 0}px`;
}
const visible = () => Math.max(1, Math.floor(scroller.clientHeight / pitch));
function glide(top) {
  scrollTarget = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, top));
  scroller.scrollTo({ top: scrollTarget, behavior: 'smooth' });
  clearTimeout(targetTimer); targetTimer = setTimeout(() => { scrollTarget = null; }, 700);
}
// One wheel notch moves by whole lines: a page (keeping one line for continuity), half a page, or three lines.
function flip(direction) {
  const count = visible(), step = { half: Math.ceil(count / 2), three: 3 }[saved.get('mouseWheel')] || Math.max(1, count - 1);
  glide((Math.round((scrollTarget ?? scroller.scrollTop) / pitch) + direction * step) * pitch);
}
function track() {
  const paged = view === 'answer' && scroller.scrollHeight > scroller.clientHeight + 2, thumb = $('track').firstElementChild;
  $('track').hidden = !paged; if (!paged) { $('pageMark').classList.remove('on'); return false; }
  thumb.style.top = `${scroller.scrollTop / scroller.scrollHeight * 100}%`; thumb.style.height = `${scroller.clientHeight / scroller.scrollHeight * 100}%`;
  return true;
}
function mark() {
  if (!track()) return;
  // Counted in pages, not lines: line numbers on screen belong to the code.
  const count = visible(), step = Math.max(1, count - 1), box = $('pageMark');
  const pages = Math.ceil((Math.round(scroller.scrollHeight / pitch) - count) / step) + 1;
  box.textContent = `${Math.min(pages, Math.round(scroller.scrollTop / pitch / step) + 1)} / ${pages} 页`;
  box.classList.add('on'); clearTimeout(markTimer); markTimer = setTimeout(() => box.classList.remove('on'), 1600);
}
async function keepAwake() {
  try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; }
  $('awakeInfo').textContent = wakeLock ? '已请求保持亮屏。' : '浏览器未能保持亮屏（普通 HTTP 地址下不可用）。请把手机的自动锁屏时间调长，或按使用指南启用 HTTPS。';
}
async function api(url, options = {}) {
  let res;
  try { res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }); }
  catch { throw Error('连不上电脑，请检查手机和电脑是否在同一网络'); }
  if (res.status === 401) { unpair('配对码不正确，请重新输入'); throw Error('配对码不正确'); }
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw Error(data.error || `请求失败 ${res.status}`); }
  return res;
}
const post = async (url, data) => (await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) })).json();

function connect() {
  clearTimeout(retryTimer); const old = ws;
  const socket = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`); old?.close();
  socket.onopen = () => socket.send(JSON.stringify({ type: 'hello', token }));
  socket.onmessage = event => { if (socket === ws) onMessage(JSON.parse(event.data)); };
  socket.onclose = event => {
    if (socket !== ws) return;
    linked = false;
    if (event.code === 1008) { unpair('配对码不正确，请重新输入'); return; }
    if (entered) renderBar(); else $('pairStatus').textContent = '连不上电脑，正在重试…';
    retryTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
  };
}
function unpair(message) {
  saved.set('mousePair', null); clearTimeout(retryTimer); const old = ws; ws = null; old?.close();
  entered = false; linked = false; endPress(null, true); if ($('settings').open) $('settings').close();
  $('app').hidden = true; $('pairView').hidden = false; $('pairStatus').textContent = message; orient();
}
function enter() {
  saved.set('mousePair', token); $('pairStatus').textContent = ''; $('pairView').hidden = true; $('app').hidden = false; entered = true;
  // Some phones turn the right mouse button into the system Back key. A guard entry below the
  // directory keeps that Back from leaving the page; see the popstate handler.
  if (!armed) { armed = true; history.scrollRestoration = 'manual'; history.replaceState({ guard: true }, ''); history.pushState({ list: true }, ''); }
  orient(); keepAwake();
}
function onMessage(m) {
  if (m.type === 'hello') {
    retry = 0; linked = true; skew = Date.now() - Date.parse(m.now); sourceState = m.source;
    engines = m.engines || []; engineId = m.engine || '';
    enter();
    const ids = new Set(m.jobs.map(j => j.id));
    for (const id of [...jobs.keys()]) if (!ids.has(id)) jobs.delete(id);
    for (const job of m.jobs) apply(job, false);
    if (view === 'answer' && !jobs.has(currentId)) leaveAnswer();
  }
  else if (m.type === 'job') apply(m.job, true);
  else if (m.type === 'source') sourceState = m.source;
  else if (m.type === 'engine') engineId = m.engine;
  else if (m.type === 'reset') { jobs.clear(); for (const url of images.values()) URL.revokeObjectURL(url); images.clear(); if (view === 'answer') leaveAnswer(); }
  render();
}
// live: the update describes something happening now, so a finished job is shown at once.
function apply(job, live) {
  const prev = jobs.get(job.id);
  if (prev && (job.rev || 0) < (prev.rev || 0)) return;
  // List entries arrive without the long texts; keep the copies that are already loaded.
  if (prev && job.status === 'done') for (const key of ['answer', 'explanation']) if (job[key] === undefined && prev[key] !== undefined) job = { ...job, [key]: prev[key] };
  jobs.set(job.id, job);
  // The match with the problem list arrives after the code; say so when the reader has already gone on to the code.
  if (live && prev?.matchStatus === 'running' && job.matchStatus === 'done' && currentId === job.id && level === 'code') toast(`题单对照：${job.insights.map(i => matched(i.origin)).filter(Boolean).join('；')}`);
  if (!live && !prev) return;
  if (job.status === 'done' && prev?.status !== 'done') { buzz([40, 60, 40]); openJob(job.id); }
  else if (job.status === 'failed' && prev?.status !== 'failed') toast(`#${job.seq} 没有完成：${job.error}`, true);
}

function show(next, id) {
  if (next === 'list' && view === 'list') return;
  view = next; currentId = next === 'answer' ? id : null; detail = wantDetail = false; shownKey = ''; scrollTarget = null;
  level = twoLevels(jobs.get(currentId)) ? 'insight' : 'code';
  $('listView').hidden = view !== 'list'; $('answerView').hidden = view !== 'answer';
  render(); scroller.scrollTop = view === 'list' ? listScroll : 0; track();
}
const twoLevels = job => job?.status === 'done' && job.kind === 'code' && !!job.insights?.length;
function setLevel(next) { level = next; lastLevel = Date.now(); detail = wantDetail = false; scrollTarget = null; render(); scroller.scrollTop = 0; track(); }
// One step back inside a record: fold the explanation, then from the code to the approach level. False when there is none left.
function stepBack() {
  if (view !== 'answer') return false;
  if (detail) { hideDetail(); return true; }
  if (level === 'code' && twoLevels(jobs.get(currentId))) { setLevel('insight'); return true; }
  return false;
}
function openJob(id) {
  if (!jobs.has(id)) return;
  if (view === 'list') { listScroll = scroller.scrollTop; history.pushState({ job: id }, ''); } else history.replaceState({ job: id }, '');
  show('answer', id);
}
function leaveAnswer() { selfBack = true; history.back(); }
// The explanation is asked for only now, and kept with the record afterwards.
function showDetail() {
  const job = jobs.get(currentId); if (view !== 'answer' || level !== 'code' || job?.status !== 'done') return;
  detail = wantDetail = true;
  if (job.explanation === undefined) { if (job.hasExplanation) load(job.id); else if (job.explainStatus !== 'running') requestExplain(job.id); }
  render();
}
function hideDetail() { detail = wantDetail = false; scrollTarget = null; render(); scroller.scrollTop = 0; track(); }
// Bring the explanation to the top line; repeated when its text arrives, because only then is there enough below it.
function toDetail() { const section = $('detail'); if (section) glide(Math.floor(section.offsetTop / pitch) * pitch); }
async function requestExplain(id) {
  try { apply((await post(`/api/explain?id=${id}`)).job, false); watch(id); } catch (e) { toast(e.message, true); }
  render();
}
addEventListener('popstate', event => {
  if (!entered) return;
  const self = selfBack; selfBack = false; if (!self) note('系统返回键');
  const state = event.state;
  if (!state || state.guard) { selfBack = true; history.forward(); return; }
  if (state.job && jobs.has(state.job)) { if (view !== 'answer' || currentId !== state.job) show('answer', state.job); return; }
  // Where the right button arrives as the Back key, a Back first steps back inside the record and the page stays on it.
  if (!self && stepBack()) { selfBack = true; history.forward(); return; }
  show('list');
});

async function trigger() {
  const now = Date.now(); if (now - lastTrigger < 500) return; lastTrigger = now;   // double clicks and switch bounce
  sending = true; renderBar(); buzz(25);
  try { const { job } = await post('/api/capture'); if (!jobs.has(job.id)) apply(job, true); watch(job.id); }
  catch (e) { toast(e.message, true); }
  finally { sending = false; render(); }
}
// The choice is kept on the computer, so it also holds for the camera page and for any other page connected.
async function chooseModel(id) {
  if (id === engineId) return;
  try { engineId = (await post('/api/model', { engine: id })).engine; toast(`之后的截图和拍照由 ${modelName(engineId)} 解答`); }
  catch (e) { toast(e.message, true); }
  render();
}
// Long press: the computer takes a screenshot about every half second until the button is released,
// then answers all of them together. The regular "hold" tells it the button is still down.
async function startBurst(p) {
  const burst = p.burst = { id: null, over: false, ping: null };
  note('长按'); sending = true; renderBar(); buzz(25);
  try {
    const { job } = await post('/api/capture', { mode: 'burst' });
    burst.id = job.id; if (!jobs.has(job.id)) apply(job, true); watch(job.id);
    if (burst.over) release(burst); else burst.ping = setInterval(() => api(`/api/hold?id=${job.id}`, { method: 'POST' }).catch(() => {}), 1000);
  } catch (e) { toast(e.message, true); }
  finally { sending = false; render(); }
}
function release(burst) { api(`/api/release?id=${burst.id}`, { method: 'POST' }).catch(e => toast(e.message, true)); }
function endBurst(burst) { burst.over = true; clearInterval(burst.ping); if (burst.id) release(burst); }
// The socket normally delivers the result; poll as well so a dropped socket cannot strand a request.
async function watch(id) {
  for (;;) {
    await sleep(1500); const job = jobs.get(id); if (!job || !entered || !(active(job) || working(job))) return;
    if (ws?.readyState === WebSocket.OPEN) continue;
    try { apply(await (await api(`/api/job?id=${id}`)).json(), true); render(); } catch {}
  }
}
async function load(id) {
  try { apply(await (await api(`/api/job?id=${id}`)).json(), false); } catch (e) { toast(e.message, true); return; }
  if (currentId === id) render();
}
async function showImage(id, n, img, figure) {
  const key = `${id}:${n}`;
  try {
    if (!images.has(key)) images.set(key, URL.createObjectURL(await (await api(`/api/image?id=${id}&n=${n}`)).blob()));
    img.src = images.get(key); img.hidden = false;
  } catch { figure.remove(); }
}

// Right button: one step back each time. Explanation -> code -> approach (programming problems) -> directory.
function right() {
  const now = Date.now(); if (now - lastRight < 400) return; lastRight = now; note('右键');
  if ($('settings').open) { $('settings').close(); return; }
  if (view === 'answer' && !stepBack()) leaveAnswer();
}
const actions = {
  capture: () => trigger(),
  back: () => { if (view === 'answer' && !stepBack()) leaveAnswer(); },
  code: () => setLevel('code'),
  detail: () => { if (detail) hideDetail(); else showDetail(); },
  settings: () => openSettings(),
  model: control => chooseModel(control.dataset.id),
  open: control => { lastOpen = Date.now(); openJob(control.dataset.id); },
};
// Buttons marked data-touch-only are for fingers. To the mouse they are part of the page, where the
// left button always means click = capture, double click = explanation, long press = burst.
function control(target, type) { const found = target.closest?.('[data-action]'); return found && !(type === 'mouse' && found.hasAttribute('data-touch-only')) ? found : null; }
// Some phone browsers deliver a mouse-like compatibility click after a real touch.
// The initiating press identifies the input, rather than that final click's pointerType.
function clickInput(event) {
  if (event.sourceCapabilities?.firesTouchEvents) return 'touch';
  const found = event.target.closest?.('[data-action]');
  if (found && lastPointerInput?.control === found && Date.now() - lastPointerInput.at < 2000) return lastPointerInput.type;
  return event.pointerType || pointerType;
}
function rememberInput(event, type) {
  if (type === 'touch' || type === 'pen') suppressTouchClickUntil = 0;
  lastPointerInput = { type, control: event.target.closest?.('[data-action]'), at: Date.now() };
  pointerSeen(type);
}
function pointerSeen(type) {
  if (type === pointerType) return;
  pointerType = type; document.body.classList.toggle('mouse', type === 'mouse'); render();
}
function endPress(event, cancelled) {
  const p = press; if (!p || (event && event.pointerId !== p.pointer)) return;
  press = null; clearTimeout(p.timer);
  if (p.burst) { endBurst(p.burst); return; }
  if (cancelled) return;
  note('左键');
  const fresh = stamp => Date.now() - stamp < DOUBLE_MS + 100;
  // On the approach level the left button only goes on to the code; capturing starts from the code level.
  if (view === 'answer' && level === 'insight') { if (!fresh(lastOpen)) setLevel('code'); return; }
  if (fresh(lastLevel)) return;   // second half of a double click that has just entered the code
  const second = clickTimer || fresh(lastOpen);   // the first click may have opened this record from the directory
  clearTimeout(clickTimer); clickTimer = null;
  if (second && view === 'answer') { note('双击'); showDetail(); }
  else if (view === 'list') trigger();   // nothing to tell apart on the directory, so no waiting
  else clickTimer = setTimeout(() => { clickTimer = null; trigger(); }, DOUBLE_MS);
}
document.addEventListener('pointerdown', e => {
  const type = e.sourceCapabilities?.firesTouchEvents ? 'touch' : e.pointerType || 'mouse'; rememberInput(e, type);
  if (!entered || $('settings').open || type !== 'mouse' || e.button !== 0 || control(e.target, type)) return;
  endPress(null, true);
  const p = press = { pointer: e.pointerId, burst: null };
  if (!(view === 'answer' && level === 'insight')) p.timer = setTimeout(() => { if (press === p) startBurst(p); }, LONG_MS);   // no capturing from the approach level
  try { document.documentElement.setPointerCapture(e.pointerId); } catch {}   // the release must arrive even outside the page
}, true);
document.addEventListener('touchstart', e => rememberInput(e, 'touch'), { capture: true, passive: true });
document.addEventListener('pointermove', e => {
  if (e.sourceCapabilities?.firesTouchEvents || (lastPointerInput?.type === 'touch' && Date.now() - lastPointerInput.at < 2000)) return;
  if (e.pointerType === 'mouse') pointerSeen('mouse');
}, { capture: true, passive: true });
document.addEventListener('pointerup', e => {
  if (e.button === 0) endPress(e, false);
  // Not every phone browser raises contextmenu for a mouse; the button release is the fallback.
  else if (entered && e.pointerType === 'mouse' && e.button === 2) right();
}, true);
document.addEventListener('pointercancel', e => endPress(e, true), true);
addEventListener('blur', () => endPress(null, true));
document.addEventListener('contextmenu', e => {
  if (!entered) return;
  const type = e.pointerType || pointerType; if (type === 'touch' || type === 'pen') return;   // long-press keeps the text menu
  e.preventDefault(); right();
});
document.addEventListener('click', e => {
  if (!entered || $('settings').open) return;
  const type = clickInput(e);
  if (type !== 'mouse' && Date.now() < suppressTouchClickUntil) return;
  const found = control(e.target, type); if (!found) return;
  note(type === 'mouse' ? '左键' : '触摸'); actions[found.dataset.action](found);
});
// Native touch panning is unreliable inside the 90-degree rotated overflow area.
// Project screen movement onto the page's vertical axis; normal orientation stays native.
scroller.addEventListener('touchstart', e => {
  touchScroll = null; suppressTouchClickUntil = 0;
  if (!entered || $('settings').open || !root.classList.contains('turned') || e.touches.length !== 1 || e.target.closest?.('button,input,select,textarea,a')) return;
  const finger = e.touches[0];
  touchScroll = { id: finger.identifier, x: finger.clientX, top: scroller.scrollTop, flipped: root.classList.contains('flipped'), moved: false };
  scrollTarget = null; clearTimeout(targetTimer);
}, { passive: true });
scroller.addEventListener('touchmove', e => {
  if (!touchScroll) return;
  if (e.touches.length !== 1 || !root.classList.contains('turned') || document.getSelection?.()?.isCollapsed === false) { touchScroll = null; return; }
  const finger = e.touches[0]; if (finger.identifier !== touchScroll.id) return;
  const delta = (finger.clientX - touchScroll.x) * (touchScroll.flipped ? -1 : 1);
  if (!touchScroll.moved && Math.abs(delta) < 8) return;
  touchScroll.moved = true;
  if (e.cancelable) e.preventDefault();
  scroller.scrollTop = Math.max(0, Math.min(Math.max(0, scroller.scrollHeight - scroller.clientHeight), touchScroll.top + delta));
}, { passive: false });
function finishTouchScroll() {
  if (touchScroll?.moved) suppressTouchClickUntil = Date.now() + 500;
  touchScroll = null;
}
scroller.addEventListener('touchend', finishTouchScroll, { passive: true });
scroller.addEventListener('touchcancel', finishTouchScroll, { passive: true });
$('app').addEventListener('wheel', e => {
  note('滚轮');
  const turned = root.classList.contains('turned'); if (!e.deltaY || $('settings').open || !(view === 'answer' || turned)) return;   // the directory scrolls natively
  e.preventDefault();
  const now = Date.now(); if (now - lastFlip < 140) return; lastFlip = now;   // one step per notch, whatever distance the mouse reports
  if (view === 'answer') flip(Math.sign(e.deltaY)); else glide(scroller.scrollTop + Math.sign(e.deltaY) * scroller.clientHeight * 0.6);
}, { passive: false });
scroller.addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true });
addEventListener('resize', orient);
document.addEventListener('keydown', e => { if (entered && e.key === 'Escape' && !$('settings').open) right(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') { endPress(null, true); return; }
  if (!entered) return;
  keepAwake(); if (!ws || ws.readyState > 1) { retry = 0; connect(); }
});

function inline(parent, text) {
  // Only **bold** and `code`; everything else stays literal so formulas such as a*b survive.
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g; let last = 0, m;
  while ((m = pattern.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    parent.append(m[1] !== undefined ? el('strong', m[1]) : el('code', m[2])); last = pattern.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}
// marked: the code was written on top of the user's own, where a comment opening with 改： or 补： stands above each change.
function markdown(text, marked) {
  const root = document.createDocumentFragment(); let para, list, code;
  for (const raw of text.split(/\r?\n/)) {
    if (code) { if (/^\s*```/.test(raw)) code = null; else code.append(el('span', raw, marked && /(?:^\s*\*+|\/\/|#|--|\/\*+)\s*[改补][:：]/.test(raw) ? 'l changed' : 'l')); continue; }
    const line = raw.trim(); let m;
    if (line.startsWith('```')) { para = list = null; code = el('pre', undefined, 'code'); root.append(code); }
    else if (!line) para = list = null;
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { para = list = null; const h = el(m[1].length <= 2 ? 'h3' : 'h4'); inline(h, m[2]); root.append(h); }
    else if (/^([-*_])(\s*\1){2,}$/.test(line)) { para = list = null; root.append(el('hr')); }
    else if ((m = line.match(/^[-*•]\s+(.*)$/))) {
      if (!list) { para = null; list = el('ul'); root.append(list); }
      const item = el('li'); inline(item, m[1]); list.append(item);
    }
    else {
      list = null; if (para) para.append(el('br')); else { para = el('p'); root.append(para); }
      inline(para, line.replace(/^>\s?/, ''));
    }
  }
  return root;
}

// Text that counts seconds while something is running; refreshed once a second.
function ticking(label, start) { const e = el('p', `${label} ${since(start)} 秒`, 'note live'); e.dataset.label = label; e.dataset.start = start; return e; }
function progress(j) {
  if (j.status === 'capturing' && j.mode === 'burst') return `连拍 ${j.shots} 张 · 松开后解答`;
  return `${j.status === 'capturing' ? '截图中' : '解答中'} ${took(j)}s`;
}
function renderBar() {
  const chip = $('sourceChip'), online = linked && sourceState?.online;
  chip.textContent = !linked ? '与电脑断开，正在重连…' : online ? `截图端已连接${sourceState.name ? ` · ${sourceState.name}` : ''}` : '截图端未连接';
  chip.className = `chip ${online ? 'online' : 'offline'}`;
  const pending = [...jobs.values()].filter(active).sort((a, b) => a.seq - b.seq), busy = $('pendingChip');
  busy.hidden = !pending.length && !sending;
  if (pending.length) { const j = pending[pending.length - 1]; busy.textContent = `#${j.seq} ${progress(j)}${pending.length > 1 ? ` · 共 ${pending.length} 条` : ''}`; }
  else busy.textContent = '正在发出截图指令…';
  const reading = view === 'answer', finger = pointerType !== 'mouse';
  // Reading with the mouse needs no buttons, so the bar gives its lines to the answer; trouble is still announced.
  $('bar').hidden = reading && !finger;
  $('warnChip').hidden = !$('bar').hidden || online; $('warnChip').textContent = linked ? '截图端未连接' : '与电脑断开，正在重连…';
  // Which model answers the next capture: chosen here, on the directory, when there is more than one.
  // The buttons are updated in place, like the rows of the list, so that a click always lands on the one pressed.
  const models = $('models'), offered = engines.map(e => e.id).join('|'); models.hidden = reading || engines.length < 2;
  if (models.dataset.offered !== offered) { models.dataset.offered = offered; models.replaceChildren(...engines.map(e => { const button = el('button', e.label); button.dataset.action = 'model'; button.dataset.id = e.id; return button; })); }
  for (const button of models.children) { const on = button.dataset.id === engineId; button.classList.toggle('on', on); button.setAttribute('aria-pressed', on); }
  $('modelInfo').textContent = `解答模型：${modelName(engineId)}${engines.length > 1 ? '。在目录页顶栏切换，从下一次截图或拍照起生效；已有记录的解析仍由当时作答的模型生成。' : ''}`;
  const job = jobs.get(currentId), insight = reading && level === 'insight';
  $('backButton').hidden = !reading || !finger; $('backButton').textContent = reading && !insight && twoLevels(job) ? '‹ 思路' : '‹ 目录';
  $('settingsButton').hidden = reading; $('codeButton').hidden = !insight || !finger;
  $('detailButton').hidden = !reading || !finger || insight || job?.status !== 'done'; $('detailButton').textContent = detail ? '收起' : '解析';
}
function renderList() {
  const box = $('jobs'), list = [...jobs.values()].sort((a, b) => b.seq - a.seq);
  $('empty').hidden = !!list.length;
  for (const [id, row] of rows) if (!jobs.has(id)) { row.remove(); rows.delete(id); }
  let before = box.firstChild;
  for (const j of list) {
    // Rows are updated in place: replacing one between press and release would turn "open" into a capture.
    let row = rows.get(j.id);
    if (!row) {
      row = el('li'); row.dataset.action = 'open'; row.dataset.id = j.id;
      const body = el('div', undefined, 'job-body'); body.append(el('b'), el('p'));
      row.append(el('span', `#${j.seq}`, 'seq'), body, el('span', undefined, 'meta')); rows.set(j.id, row);
    }
    const title = j.status === 'done' ? j.title || '答案' : j.status === 'failed' ? '没有完成' : j.status === 'capturing' ? '截图中…' : '解答中…';
    const text = j.status === 'done' ? j.snippet : j.status === 'failed' ? j.error : progress(j);
    const meta = `${clock(j.createdAt)}${j.finishedAt ? ` · ${took(j)}s` : ''}${j.mode === 'camera' ? ` · 拍照 ${j.frameCount} 张` : j.frameCount > 1 ? ` · ${j.frameCount} 图` : ''}${j.engine && engines.length > 1 ? `\n${modelName(j.engine)}` : ''}`;   // the model on a line of its own, so a narrow screen keeps room for the title
    for (const [node, value] of [[row.querySelector('b'), title], [row.querySelector('p'), text || ''], [row.querySelector('.meta'), meta]]) if (node.textContent !== value) node.textContent = value;
    row.className = `job ${j.status}`;
    if (row !== before) box.insertBefore(row, before); else before = row.nextSibling;
  }
}
function detailSection(job) {
  const section = el('section'); section.id = 'detail'; section.append(el('p', drafted(job) ? '解析 · 你的代码还差什么' : '解析', 'detail-title'));
  if (job.explanation !== undefined) { const body = el('div', undefined, 'markdown'); body.append(markdown(job.explanation)); section.append(body); }
  else if (job.explainStatus === 'failed') section.append(el('p', `解析没有生成：${job.explainError}。双击重试。`, 'error'));
  else if (job.explainStatus === 'running') section.append(ticking('正在生成解析…', job.explainStartedAt));
  else section.append(el('p', '正在载入…', 'note'));
  for (let n = 0; n < job.frameCount; n++) {
    const figure = el('figure'), img = el('img'), kind = pictures(job); img.alt = `${kind} ${n + 1}`; img.hidden = true;
    figure.append(el('figcaption', job.frameCount > 1 ? `${kind} ${n + 1} / ${job.frameCount}` : `本次${kind}`), img); section.append(figure); showImage(job.id, n, img, figure);
  }
  return section;
}
const RELATION = { same: '原题', variant: '变式', none: '不在题单' };
const matched = origin => origin ? `${RELATION[origin.relation]}${origin.problem ? ` ${origin.relation === 'none' ? '最接近 ' : ''}${origin.problem}` : ''}` : '';
// Approach level of a programming problem: how it relates to the problem list, then category and approach tags.
// Set large, two grid lines per row, to be taken in at a glance before going on to the code. The code is
// already there when this is shown; the match is worked out from it afterwards and fills in its row when it arrives.
function insightCards(job) {
  const box = el('section', undefined, 'insights');
  for (const item of job.insights) {
    if (job.insights.length > 1 && item.no) box.append(el('p', `第 ${item.no} 题`, 'state'));
    if (item.origin) {
      const origin = el('p', undefined, `origin ${item.origin.relation}`);
      origin.append(el('span', RELATION[item.origin.relation], 'badge'));
      if (item.origin.problem) origin.append(el('b', item.origin.relation === 'none' ? `最接近：${item.origin.problem}` : item.origin.problem));
      if (item.origin.hot) origin.append(el('span', 'Hot 100', 'hot'));
      box.append(origin);
      if (item.origin.note) box.append(el('p', `差异：${item.origin.note}`, 'difference'));
    }
    else if (job.matchStatus === 'running') { const wait = ticking('正在对照题单…', job.matchStartedAt); wait.className = 'origin pending live'; box.append(wait); }
    else if (job.matchStatus === 'failed') box.append(el('p', `题单对照没有完成：${job.matchError}`, 'origin pending'));
    for (const [label, list] of [['分类', item.categories], ['思路', item.approaches]]) {
      if (!list?.length) continue;
      const row = el('p', undefined, label === '思路' ? 'tags approach' : 'tags'); row.append(el('span', label, 'label'), ...list.map(text => el('span', text, 'tag'))); box.append(row);
    }
    if (item.summary) box.append(el('p', `题意：${item.summary}`, 'difference'));
    if (item.draft === 'part' || item.draft === 'full') box.append(el('p', `已有代码：${item.draft === 'full' ? '较完整' : '写了一部分'}。答案是在你的代码上改的，改动处标有“改：”“补：”；双击看还差什么、改哪里。`, 'difference'));
  }
  return box;
}
function renderAnswer() {
  const job = jobs.get(currentId), box = $('answer'); if (!job) return;
  const key = [job.id, job.rev, job.answer === undefined, job.explanation === undefined, detail, level].join(':');
  if (key === shownKey) { for (const live of box.querySelectorAll('.live')) live.textContent = `${live.dataset.label} ${since(live.dataset.start)} 秒`; return; }
  shownKey = key;
  // One line: number and title on the left, the facts about this capture on the right.
  const head = el('div', undefined, 'head'), facts = [clock(job.createdAt)];
  if (job.finishedAt) facts.push(`${took(job)} 秒`);
  if (job.frameCount > 1 || job.mode === 'camera') facts.push(`${job.frameCount} 张${pictures(job)}`);
  if (job.engine) facts.push(modelName(job.engine));
  head.append(el('b', job.status === 'done' ? `#${job.seq} ${job.title || '答案'}` : `#${job.seq}`), el('span', facts.join(' · ')));
  box.replaceChildren(head);
  let tips = '右键：回目录　左键：截新图　长按：连拍';
  if (level === 'insight' && twoLevels(job)) { box.append(insightCards(job)); tips = '左键：看代码　右键：回目录'; }
  else if (job.status === 'done') {
    const away = twoLevels(job) ? '回思路' : '回目录';
    if (job.answer === undefined) { box.append(el('p', '正在载入…', 'note')); load(job.id); }
    else { const body = el('div', undefined, 'markdown answers'); body.append(markdown(job.answer, drafted(job))); box.append(body); }
    if (detail) box.append(detailSection(job));
    tips = detail ? `右键：收起解析，再按一次${away}` : `左键：截新图　双击：${drafted(job) ? '看还差什么' : '看解析'}　右键：${away}　长按：连拍`;
  }
  else if (job.status === 'failed') box.append(el('p', '这一次没有完成', 'state'), el('p', job.error, 'error'));
  else if (job.status === 'capturing' && job.mode === 'burst') box.append(el('p', '正在连拍…', 'state'), el('p', `已截 ${job.shots} 张，松开后一起解答`, 'note'));
  else box.append(el('p', job.status === 'capturing' ? '正在截图…' : '正在解答…', 'state'), ticking('已用', job.createdAt));
  box.append(el('p', tips, 'tips'));
  if (detail && wantDetail) { toDetail(); if (job.explanation !== undefined) wantDetail = false; }
}
function render() { if (!entered) return; renderBar(); fit(); if (view === 'list') renderList(); else renderAnswer(); track(); }

async function openSettings() {
  const dialog = $('settings'); if (dialog.open) return;
  $('promptStatus').textContent = ''; $('archive').textContent = '清空目录（归档到电脑）'; delete $('archive').dataset.armed; dialog.showModal(); dialog.scrollTop = 0;
  try { $('systemPrompt').value = (await (await api('/api/settings')).json()).systemPrompt; } catch (e) { $('promptStatus').textContent = e.message; }
}
$('settings').addEventListener('click', e => { if (e.target === $('settings')) $('settings').close(); });
$('closeSettings').onclick = () => $('settings').close();
$('savePrompt').onclick = async () => {
  try { await post('/api/settings', { systemPrompt: $('systemPrompt').value }); $('promptStatus').textContent = '已保存，下一次截图起生效'; }
  catch (e) { $('promptStatus').textContent = e.message; }
};
$('lines').onchange = () => { saved.set('mouseLines', $('lines').value); render(); };
$('wheelStep').onchange = () => saved.set('mouseWheel', $('wheelStep').value);
$('turn').onchange = () => { saved.set('mouseTurn', $('turn').value); orient(); };
$('vibrate').onchange = () => saved.set('mouseVibrate', $('vibrate').checked ? '1' : null);
$('archive').onclick = async () => {
  const button = $('archive');
  if (!button.dataset.armed) { button.dataset.armed = '1'; button.textContent = '再点一次确认清空'; return; }
  try { const { archived } = await post('/api/archive'); $('settings').close(); toast(`已归档 ${archived} 条记录`); }
  catch (e) { toast(e.message, true); }
};
$('unpair').onclick = () => unpair('');
$('pairForm').onsubmit = event => {
  event.preventDefault(); token = $('pair').value.trim();
  if (!token) { $('pairStatus').textContent = '请输入电脑终端显示的配对码'; return; }
  $('pairStatus').textContent = '正在连接…'; retry = 0; connect();
};

$('lines').value = saved.get('mouseLines') || '12'; $('wheelStep').value = saved.get('mouseWheel') || 'page'; $('turn').value = saved.get('mouseTurn') || 'landscape';
$('vibrate').checked = saved.get('mouseVibrate') === '1'; document.body.classList.toggle('mouse', pointerType === 'mouse');
setInterval(() => { if (entered && (sending || [...jobs.values()].some(j => active(j) || working(j)))) render(); }, 1000);
if (token) { $('pairStatus').textContent = '正在连接…'; connect(); }
