import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the real page handlers without a browser or model calls. Only DOM rendering is stubbed.
function page() {
  const handlers = new Map(), elements = new Map();
  const element = id => {
    const classes = new Set();
    if (!elements.has(id)) elements.set(id, {
      id, style: { setProperty() {} }, classList: { toggle(name, enabled) { if (enabled ?? !classes.has(name)) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); } }, dataset: {},
      scrollTop: 100, scrollHeight: 1000, clientHeight: 200,
      addEventListener(type, callback) { handlers.set(`${id}:${type}`, callback); },
      closest(selector) { return selector === '[data-action]' && this.dataset.action ? this : null; },
      hasAttribute(name) { return name === 'data-touch-only' && this.touchOnly; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: element, documentElement: element('root'), body: element('body'), addEventListener: (type, callback) => handlers.set(type, callback) },
    localStorage: { getItem: () => null }, location: { hash: '' },
    matchMedia: () => ({ matches: false }), URLSearchParams, Date,
    setInterval: () => 1, setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    addEventListener: (type, callback) => handlers.set(type, callback), navigator: {},
  });
  vm.runInContext(readFileSync(new URL('../public/mouse/mouse.js', import.meta.url), 'utf8'), context);
  vm.runInContext(`
    render = () => {}; track = () => {}; entered = true;
    view = 'answer'; level = 'insight'; currentId = 'code-job';
    jobs.set(currentId, { status: 'done', kind: 'code', insights: [{}] });
    globalThis.captureCount = 0; trigger = () => { captureCount++; };
  `, context);
  const button = element('codeButton'); button.dataset.action = 'code'; button.touchOnly = true;
  return { button, element, context, value: expr => vm.runInContext(expr, context), fire: (type, event) => handlers.get(type)?.({ type, target: button, button: 0, pointerId: 1, detail: 1, ...event }) };
}

test('a touch followed by a compatibility mouse click opens the code without capturing', () => {
  const p = page();
  p.fire('pointerdown', { pointerType: 'touch' });
  p.fire('pointerup', { pointerType: 'touch' });
  p.fire('click', { pointerType: 'mouse' });
  assert.equal(p.value('level'), 'code'); assert.equal(p.value('captureCount'), 0);
});

test('compatibility mouse movement after touch does not hide the finger controls', () => {
  const p = page();
  p.fire('pointerdown', { pointerType: 'touch' });
  p.fire('pointerup', { pointerType: 'touch' });
  p.fire('pointermove', { pointerType: 'mouse' });
  assert.equal(p.value('pointerType'), 'touch');
});

test('touchstart identifies button taps on browsers whose click has no pointer type', () => {
  const p = page(); vm.runInContext("pointerType = 'mouse'", p.context);
  p.fire('touchstart', {});
  p.fire('click', {});
  assert.equal(p.value('level'), 'code');
});

test('ordinary touch clicks work and a genuine mouse press still advances from insights', () => {
  const touch = page(); touch.fire('pointerdown', { pointerType: 'touch' }); touch.fire('click', { pointerType: 'touch' });
  assert.equal(touch.value('level'), 'code');
  const mouse = page(); mouse.fire('pointerdown', { pointerType: 'mouse' }); mouse.fire('pointerup', { pointerType: 'mouse' });
  assert.equal(mouse.value('level'), 'code'); assert.equal(mouse.value('captureCount'), 0);
});

function swipe(p, from, to, cancelled = false) {
  const point = ([clientX, clientY]) => ({ identifier: 1, clientX, clientY });
  let prevented = false;
  p.fire('scroll:touchstart', { touches: [point(from)] });
  p.fire('scroll:touchmove', { touches: [point(to)], cancelable: true, preventDefault() { prevented = true; } });
  p.fire(cancelled ? 'scroll:touchcancel' : 'scroll:touchend', { touches: [] });
  return prevented;
}

test('a finger swipe scrolls rotated content in its displayed direction and does not activate a row', () => {
  const p = page(); p.element('root').classList.toggle('turned', true);
  assert.equal(swipe(p, [100, 100], [160, 100]), true);
  assert.equal(p.element('scroll').scrollTop, 160);
  p.fire('click', { pointerType: 'touch' });
  assert.equal(p.value('level'), 'insight', 'the compatibility click after scrolling must not activate a control');
  assert.equal(p.value('captureCount'), 0);
});

test('reverse landscape uses the opposite swipe direction and clamps at scroll boundaries', () => {
  const p = page(); p.element('root').classList.toggle('turned', true); p.element('root').classList.toggle('flipped', true);
  swipe(p, [100, 100], [40, 100]); assert.equal(p.element('scroll').scrollTop, 160);
  swipe(p, [100, 100], [1000, 100]); assert.equal(p.element('scroll').scrollTop, 0);
  swipe(p, [1000, 100], [0, 100]); assert.equal(p.element('scroll').scrollTop, 800);
});

test('normal orientation keeps native touch scrolling and short taps still activate controls', () => {
  const p = page(); assert.equal(swipe(p, [100, 100], [100, 40]), false);
  assert.equal(p.element('scroll').scrollTop, 100, 'the browser handles unrotated scrolling');
  p.element('root').classList.toggle('turned', true);
  assert.equal(swipe(p, [100, 100], [102, 100]), false);
  p.fire('click', { pointerType: 'touch' }); assert.equal(p.value('level'), 'code');
});

test('multi-touch and cancelled gestures do not keep dragging the page', () => {
  const p = page(); p.element('root').classList.toggle('turned', true);
  p.fire('scroll:touchstart', { touches: [{ identifier: 1, clientX: 100, clientY: 100 }, { identifier: 2, clientX: 120, clientY: 100 }] });
  p.fire('scroll:touchmove', { touches: [{ identifier: 1, clientX: 160, clientY: 100 }] });
  assert.equal(p.element('scroll').scrollTop, 100);
  swipe(p, [100, 100], [160, 100], true);
  p.fire('scroll:touchmove', { touches: [{ identifier: 1, clientX: 200, clientY: 100 }] });
  assert.equal(p.element('scroll').scrollTop, 160);
});

test('a fresh button tap immediately after scrolling remains usable', () => {
  const p = page(); p.element('root').classList.toggle('turned', true);
  swipe(p, [100, 100], [160, 100]);
  p.fire('pointerdown', { pointerType: 'touch' }); p.fire('pointerup', { pointerType: 'touch' }); p.fire('click', { pointerType: 'mouse' });
  assert.equal(p.value('level'), 'code');
});
