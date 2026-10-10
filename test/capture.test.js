import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureController } from '../public/capture.js';

test('five-shot mode waits before capture and finishes after exactly five successful uploads', async () => {
  const taken = [], uploaded = []; let done;
  const finished = new Promise(r => { done = r; });
  const c = new CaptureController({ interval: 2, snapshot: async () => { taken.push(1); return taken.length; }, upload: async x => uploaded.push(x), onFinish: done });
  c.start({ id: 'b', mode: 'five' }); assert.equal(taken.length, 0);
  await finished; assert.equal(taken.length, 5); assert.deepEqual(uploaded, [1, 2, 3, 4, 5]);
});
test('stop waits for in-flight upload before closing the batch', async () => {
  let release; const gate = new Promise(r => { release = r; }); let closed = false;
  const c = new CaptureController({ snapshot: async () => 'image', upload: async () => gate, onFinish: () => { closed = true; } });
  c.start({ id: 'b', mode: 'single' });
  await new Promise(r => setImmediate(r)); assert.equal(closed, false);
  release(); await c.stop(); assert.equal(closed, true);
});
test('file import participates in the question barrier and stop prevents later uploads', async () => {
  let release; const wait = new Promise(r => { release = r; }); const uploaded = []; let closed = false;
  const c = new CaptureController({ upload: async x => { uploaded.push(x); await wait; }, onFinish: () => { closed = true; } });
  c.startImport({ id: 'import', mode: 'long' }, ['one', 'two']);
  let settled = false; c.settled().then(() => { settled = true; });
  await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  const stopped = c.stop(); release(); await stopped;
  assert.deepEqual(uploaded, ['one']); assert.equal(closed, true);
});
