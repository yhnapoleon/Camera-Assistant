import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { VoiceRecorder } from '../public/mouse/voice-recorder.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function page({ truncated = false, secure = true } = {}) {
  const handlers = new Map(), elements = new Map(); let uploads = 0, microphone = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, hidden: true, disabled: true, textContent: '', closest: () => null });
    return elements.get(id);
  };
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.mimeType = 'audio/webm'; this.state = 'inactive'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['audio']) }); this.onstop?.(); }); }
  }
  const getUserMedia = async () => { microphone++; return { getTracks: () => [{ stop() {} }] }; };
  const context = vm.createContext({
    VoiceRecorder: class extends VoiceRecorder { constructor(options) { super({ ...options, Recorder, getUserMedia }); } },
    document: { getElementById: element, body: { dataset: {} }, addEventListener: (type, callback) => handlers.set(type, callback) },
    window: { isSecureContext: secure, MediaRecorder: Recorder }, navigator: { mediaDevices: { getUserMedia } },
    location: { hash: '#pair=test-token', pathname: '/voice', replace() {} },
    history: { replaceState() {}, pushState() {} }, localStorage: { getItem() {}, setItem() {} },
    addEventListener: (type, callback) => handlers.set(type, callback),
    URLSearchParams, TextDecoder, Date, setInterval, clearInterval,
    fetch: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      if (url === '/api/voice/config') return Response.json({ enabled: true, engine: 'test-model', maxSeconds: 300, maxBytes: 20000000 });
      uploads++;
      const data = [ { type: 'transcript', text: '什么是闭包？', engine: 'test-model' }, ...truncated ? [] : [{ type: 'answer', text: '函数及其词法环境。' }] ];
      const bytes = new TextEncoder().encode(data.map(item => JSON.stringify(item)).join('\n') + '\n');
      return new Response(new ReadableStream({ start(controller) {
        // Deliberately split every UTF-8 character and JSON record across transport chunks.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close();
      } }));
    },
  });
  const code = readFileSync(new URL('../public/mouse/voice.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/, '');
  vm.runInContext(code, context); await tick();
  return { element, context, uploads: () => uploads, microphone: () => microphone,
    fire: type => handlers.get(type)?.({ button: type === 'click' ? 0 : 2, target: element('background'), preventDefault() {} }),
    dispose: () => handlers.get('pagehide')(),
  };
}

test('page left click records, right click submits once, and streamed Unicode question and answer render intact', async t => {
  const p = await page(); t.after(p.dispose);
  assert.equal(p.element('start').disabled, false);
  p.fire('click'); await tick(); assert.equal(p.microphone(), 1); assert.equal(p.element('stop').disabled, false);
  p.fire('pointerup'); p.fire('contextmenu'); await tick();
  assert.equal(p.uploads(), 1); assert.equal(p.element('question').textContent, '什么是闭包？');
  assert.equal(p.element('answer').textContent, '函数及其词法环境。');
  assert.equal(p.element('answerPanel').hidden, false); assert.match(p.element('status').textContent, /回答完成/);
});

test('truncated answer keeps the question and shows an error instead of completion', async t => {
  const p = await page({ truncated: true }); t.after(p.dispose);
  p.fire('click'); await tick(); p.fire('contextmenu'); await tick();
  assert.equal(p.element('question').textContent, '什么是闭包？');
  assert.match(p.element('status').textContent, /断开/); assert.equal(p.element('start').disabled, false);
});

test('insecure phone HTTP shows actionable guidance without requesting microphone access', async t => {
  const p = await page({ secure: false }); t.after(p.dispose);
  p.fire('click'); await tick();
  assert.equal(p.element('start').disabled, true); assert.equal(p.microphone(), 0);
  assert.match(p.element('status').textContent, /HTTPS 或 localhost/);
});
