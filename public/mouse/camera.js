// Camera page: a second phone or tablet takes photos, one or a batch, and sends them to the computer. They are
// answered like a capture and the answer appears on the phone that shows answers; this page only reports progress.
const $ = id => document.getElementById(id);
const el = (tag, text, className) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; };
const saved = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {} },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// crypto.randomUUID exists only on https:// and localhost; this page must also work on a plain LAN address.
const uid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
const LONG_SIDE = 2400;   // photos are scaled down to this before upload: a page of text stays readable, Wi-Fi stays quick

let token = new URLSearchParams(location.hash.slice(1)).get('pair') || saved.get('mousePair') || '';
if (location.hash) history.replaceState(null, '', location.pathname);
$('pair').value = token;

let entered = false, limit = 12, stream = null, starting = false, live = false, refused = false, busy = false, toastTimer, wakeLock;
// The photos being collected: { id, single, next, photos: [{ n, url, data, state: 'uploading' | 'sent' | 'failed', sent }] }.
// "single" is one photo that is submitted as soon as it is taken; otherwise the batch grows until "finish".
let batch = null;

function toast(text, bad) {
  const box = $('toast'); box.textContent = text; box.className = bad ? 'bad' : ''; box.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { box.hidden = true; }, bad ? 6000 : 2500);
}
async function api(url, options = {}) {
  let res;
  try { res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }); }
  catch { throw Error('连不上电脑，请检查这台设备和电脑是否在同一网络'); }
  if (res.status === 401) { unpair('配对码不正确，请重新输入'); throw Error('配对码不正确'); }
  if (!res.ok) { const data = await res.json().catch(() => ({})); throw Object.assign(Error(data.error || `请求失败 ${res.status}`), { status: res.status }); }
  return res;
}
const post = async (url, data) => (await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) })).json();

// The pairing code is checked by asking for the state, which also tells how many photos one batch may hold.
async function enter() {
  try { limit = (await (await api('/api/state')).json()).maxFrames || limit; } catch (e) { $('pairStatus').textContent = e.message; return; }
  saved.set('mousePair', token); $('pairStatus').textContent = ''; $('pairView').hidden = true; $('cam').hidden = false; entered = true;
  render(); startCamera(); keepAwake();
}
function unpair(message) {
  saved.set('mousePair', null); entered = false; stopCamera(); if (batch) release(batch); batch = null;
  $('cam').hidden = true; $('pairView').hidden = false; $('pairStatus').textContent = message;
}
async function keepAwake() { try { if (!wakeLock || wakeLock.released) wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; } }

// A web page may use the camera only on https:// or localhost. Anywhere else, and when permission is refused,
// the buttons open the system camera through the file input instead: one photo each time.
async function startCamera() {
  if (stream || starting || !navigator.mediaDevices?.getUserMedia) return;
  starting = true;
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    stream = opened; $('video').srcObject = stream; await $('video').play(); live = true; refused = false;
    if (!entered || document.visibilityState !== 'visible') stopCamera();
  } catch { stopCamera(); refused = true; }
  starting = false; render();
}
function stopCamera() { for (const track of stream?.getTracks() || []) track.stop(); stream = null; live = false; $('video').srcObject = null; }
function grab() {
  const video = $('video'), canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  if (!canvas.width) return Promise.reject(Error('画面还没有准备好，请再点一次'));
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(Error('没有拍到画面')), 'image/jpeg', 0.92));
}
// A picture the browser cannot decode is sent as it is and left to the computer.
async function shrink(blob) {
  try {
    const image = await createImageBitmap(blob), scale = Math.min(1, LONG_SIDE / Math.max(image.width, image.height));
    if (scale === 1 && blob.type === 'image/jpeg') return blob;
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(Error()), 'image/jpeg', 0.9));
  } catch { return blob; }
}

const fresh = single => ({ id: uid(), single, next: 0, photos: [] });
function release(owner) { for (const photo of owner.photos) URL.revokeObjectURL(photo.url); }
// With the live picture the photo is taken at once. Without it the system camera opens, and the photo comes
// back through the file input, or never, when the user backs out of the camera.
async function shoot() {
  if (!batch || busy || batch.photos.length >= limit) return;
  if (!live) { $('file').value = ''; $('file').click(); return; }
  try { const blob = await grab(); $('flash').classList.remove('on'); void $('flash').offsetWidth; $('flash').classList.add('on'); add(blob); }
  catch (e) { toast(e.message, true); }
}
// Every photo goes to the computer as soon as it is taken, so that finishing a batch does not have to wait.
function add(blob) {
  const owner = batch, photo = { n: owner.next++, url: URL.createObjectURL(blob), state: 'uploading' };
  owner.photos.push(photo); photo.sent = upload(owner, photo, shrink(blob));
  if (owner.single) submit(); else render();
}
async function upload(owner, photo, data) {
  try {
    photo.data = await data;
    await api(`/api/camera/photo?batch=${owner.id}&n=${photo.n}`, { method: 'POST', headers: { 'Content-Type': photo.data.type || 'image/jpeg' }, body: photo.data });
    photo.state = 'sent';
  } catch (e) { photo.state = 'failed'; photo.error = e.message; }
  if (owner === batch) render();
}
function remove(photo) {
  if (!batch || busy) return;
  batch.photos = batch.photos.filter(p => p !== photo); URL.revokeObjectURL(photo.url);
  const owner = batch; photo.sent.then(() => api(`/api/camera/discard?batch=${owner.id}&n=${photo.n}`, { method: 'POST' })).catch(() => {});
  render();
}
async function submit() {
  const owner = batch; if (!owner?.photos.length || busy) return;
  busy = true; render();
  try {
    await Promise.all(owner.photos.map(p => p.sent));
    for (const p of owner.photos.filter(p => p.state === 'failed')) { p.state = 'uploading'; render(); await (p.sent = upload(owner, p, p.data)); }   // one more try
    const failed = owner.photos.filter(p => p.state !== 'sent');
    if (failed.length) throw Error(`有 ${failed.length} 张没有传到电脑：${failed[0].error}`);
    const { job } = await post('/api/camera/submit', { batch: owner.id, photos: owner.photos.map(p => p.n) });
    release(owner); if (batch === owner) batch = null;
    follow(job, owner.photos.length);
  } catch (e) {
    owner.single = false;   // the photo stays on screen, to be sent again or dropped
    if (entered) toast(e.message, true);
  }
  busy = false; render();
}
function cancel() {
  if (!batch || busy) return;
  const owner = batch; batch = null; release(owner);
  Promise.all(owner.photos.map(p => p.sent)).then(() => api(`/api/camera/discard?batch=${owner.id}`, { method: 'POST' })).catch(() => {});
  render();
}
// One line per submission, kept up to date until the computer has answered it.
async function follow(job, count) {
  const row = el('li'); $('sent').prepend(row);
  for (;;) {
    row.className = job.status;
    row.textContent = `#${job.seq} · ${count} 张 · ${job.status === 'done' ? `已解答：${job.title || '答案'}` : job.status === 'failed' ? `没有完成：${job.error}` : '正在解答…'}`;
    if (job.status === 'done' || job.status === 'failed') return;
    await sleep(1500); if (!entered) return;
    try { job = await (await api(`/api/job?id=${job.id}`)).json(); } catch (e) { if (e.status === 404) { row.remove(); return; } }
  }
}

function render() {
  if (!entered) return;
  const multi = !!batch && !batch.single, photos = multi ? batch.photos : [], full = photos.length >= limit;
  $('modeChip').textContent = live ? '实时取景' : '系统相机'; $('modeChip').className = `chip ${live ? 'online' : ''}`;
  $('video').hidden = !live; $('finderNote').hidden = live;
  $('finderNote').textContent = !navigator.mediaDevices?.getUserMedia ? '这个地址不是 https，浏览器不允许网页直接取景。\n点下面的按钮会打开系统相机，拍完确认后照片回到这里。'
    : refused ? '没有拿到摄像头：权限被拒绝，或正被别的应用占用。\n点下面的按钮会改用系统相机；允许权限后刷新本页可以恢复实时取景。' : '正在打开摄像头…';
  $('single').hidden = $('begin').hidden = multi; $('cancel').hidden = $('shoot').hidden = $('finish').hidden = !multi;
  $('single').disabled = $('begin').disabled = $('cancel').disabled = busy; $('shoot').disabled = busy || full; $('finish').disabled = busy || !photos.length;
  $('shoot').textContent = full ? `已满 ${limit} 张` : `拍一张（${photos.length}/${limit}）`; $('finish').textContent = busy ? '正在提交…' : '完成并解答';
  const waiting = photos.filter(p => p.state === 'uploading').length, failed = photos.filter(p => p.state === 'failed').length;
  $('status').textContent = busy && !multi ? '正在上传并提交…'
    : multi ? `这一批已拍 ${photos.length} 张${waiting ? `，${waiting} 张正在上传` : ''}${failed ? `，${failed} 张没有传上去（提交时会再传一次）` : ''}。拍完点“完成并解答”。`
    : '拍一张并解答：一张照片一次解答。批量拍摄：连拍几张，一起解答。';
  $('shots').replaceChildren(...photos.map((photo, i) => {
    const item = el('li', undefined, photo.state), image = el('img'), drop = el('button', '×'); image.src = photo.url; image.alt = `第 ${i + 1} 张`;
    drop.setAttribute('aria-label', `删除第 ${i + 1} 张`); drop.onclick = () => remove(photo);
    item.append(image, el('b', String(i + 1)), drop); return item;
  }));
}

$('single').onclick = () => { if (busy) return; if (batch) release(batch); batch = fresh(true); shoot(); };
$('begin').onclick = () => { if (busy) return; if (batch) release(batch); batch = fresh(false); render(); };
$('shoot').onclick = shoot; $('finish').onclick = submit; $('cancel').onclick = cancel;
$('file').onchange = () => { const file = $('file').files[0]; if (file && batch && !busy && batch.photos.length < limit) add(file); };
$('unpair').onclick = () => unpair('');
$('pairForm').onsubmit = event => {
  event.preventDefault(); token = $('pair').value.trim();
  if (!token) { $('pairStatus').textContent = '请输入电脑终端显示的配对码'; return; }
  $('pairStatus').textContent = '正在连接…'; enter();
};
// The camera is given back while the page is in the background, also while the system camera is open.
document.addEventListener('visibilitychange', () => {
  if (!entered) return;
  if (document.visibilityState === 'visible') { startCamera(); keepAwake(); } else stopCamera();
});
if (token) { $('pairStatus').textContent = '正在连接…'; enter(); }
