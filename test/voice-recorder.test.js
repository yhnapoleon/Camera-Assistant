import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceRecorder } from '../public/mouse/voice-recorder.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(options = {}) {
  let stopped = 0, asked = 0; const sent = [], states = [];
  const stream = { getTracks: () => [{ stop: () => stopped++ }] };
  class Recorder {
    static isTypeSupported(type) { return type.startsWith('audio/webm'); }
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm;codecs=opus'; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob(['last audio chunk']) }); this.onstop?.(); }); }
  }
  const recorder = new VoiceRecorder({
    getUserMedia: async () => { asked++; return stream; }, Recorder,
    submit: async audio => sent.push(await audio.text()), onState: (state, message) => states.push({ state, message }), ...options,
  });
  return { recorder, sent, states, stream, stopped: () => stopped, asked: () => asked };
}

test('left start is idempotent, right stop includes the final chunk and releases the microphone before answering', async () => {
  const p = setup(); await Promise.all([p.recorder.start(), p.recorder.start()]);
  assert.equal(p.asked(), 1); assert.equal(p.recorder.state, 'recording');
  p.recorder.stop(); p.recorder.stop(); await tick();
  assert.deepEqual(p.sent, ['last audio chunk']); assert.equal(p.stopped(), 1); assert.equal(p.recorder.state, 'done');
  p.recorder.cancel();
});

test('ending while permission is pending discards late microphone access and never uploads', async () => {
  let grant; const permission = new Promise(resolve => { grant = resolve; });
  const p = setup({ getUserMedia: () => permission });
  const starting = p.recorder.start(); p.recorder.stop(); grant(p.stream); await starting;
  assert.equal(p.stopped(), 1); assert.equal(p.recorder.state, 'idle'); assert.deepEqual(p.sent, []);
});

test('leaving during recording releases the microphone and does not submit the recording', async () => {
  const p = setup(); await p.recorder.start(); p.recorder.cancel(); await tick();
  assert.equal(p.stopped(), 1); assert.deepEqual(p.sent, []);
});

test('permission denial is recoverable and submission errors do not leave recording running', async () => {
  const p = setup({ getUserMedia: async () => { throw Object.assign(Error('denied'), { name: 'NotAllowedError' }); } });
  await p.recorder.start(); assert.equal(p.recorder.state, 'error'); assert.match(p.states.at(-1).message, /权限/);
  const q = setup({ submit: async () => { throw Error('服务断开'); } });
  await q.recorder.start(); q.recorder.stop(); await tick();
  assert.equal(q.recorder.state, 'error'); assert.equal(q.stopped(), 1); assert.match(q.states.at(-1).message, /服务断开/);
});

test('cancelling a pending answer aborts the request and ignores its late completion', async () => {
  let finish, signal;
  const p = setup({ submit: (_audio, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  await p.recorder.start(); p.recorder.stop(); await tick();
  p.recorder.cancel(); assert.equal(signal.aborted, true); finish(); await tick();
  assert.equal(p.recorder.state, 'idle');
});

test('the recording time limit automatically submits and the byte limit cancels without uploading', async t => {
  let submitted;
  const done = new Promise(resolve => { submitted = resolve; });
  const p = setup({ maxMs: 5, submit: async () => submitted() }); t.after(() => p.recorder.cancel());
  await p.recorder.start(); await done; await tick();
  assert.equal(p.recorder.state, 'done'); assert.equal(p.stopped(), 1);
  const q = setup({ maxBytes: 1 }); t.after(() => q.recorder.cancel());
  await q.recorder.start(); q.recorder.stop(); await tick();
  assert.equal(q.recorder.state, 'error'); assert.deepEqual(q.sent, []); assert.equal(q.stopped(), 1);
});
