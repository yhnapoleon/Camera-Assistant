import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { splitAnswer } from '../src/mouse-core.js';
import { lessonFixture } from './fixtures/lesson.js';

function setup() {
  const { document, window } = parseHTML('<html><body></body></html>');
  const context = vm.createContext({ document, window, console, setTimeout, navigator: {} });
  vm.runInContext(readFileSync(new URL('../node_modules/@highlightjs/cdn-assets/highlight.min.js', import.meta.url), 'utf8'), context);
  window.hljs = context.hljs;
  const file = new URL('../public/mouse/lesson-view.js', import.meta.url);
  if (existsSync(file)) vm.runInContext(readFileSync(file, 'utf8'), context);
  assert.equal(typeof window.LessonView?.render, 'function', 'the actual lesson renderer must exist');
  const lesson = splitAnswer(JSON.stringify(lessonFixture())).lesson;
  const events = [];
  const render = (state = {}) => {
    const root = window.LessonView.render(lesson, { stage: 'analysis', problemIndex: 0, mode: 'leetcode', ...state }, { navigate: stage => events.push(['stage', stage]), problem: i => events.push(['problem', i]), mode: mode => events.push(['mode', mode]), copy: text => events.push(['copy', text]), step: id => events.push(['step', id]), explain: () => events.push(['explain']) });
    document.body.replaceChildren(root); return root;
  };
  return { document, window, lesson, events, render };
}

test('analysis, implementation and diagram show the same numbered steps and navigate to code', () => {
  const p = setup();
  assert.match(p.render().textContent, /为什么/);
  assert.match(p.document.body.textContent, /O\(n\)/);
  const impl = p.render({ stage: 'implementation' });
  assert.equal(impl.querySelectorAll('[data-step-card]').length, 3);
  impl.querySelector('[data-step-link="S2"]').click();
  assert.deepEqual(p.events.pop(), ['step', 'S2']);
  const diagram = p.render({ stage: 'diagram' });
  assert.equal(diagram.querySelectorAll('svg [data-step-link]').length, 3);
  assert.equal(diagram.querySelectorAll('svg path.diagram-edge').length, 3);
  assert.match(diagram.textContent, /演示示例/);
  diagram.querySelector('[data-stage="code"]').click();
  assert.deepEqual(p.events.pop(), ['stage', 'code']);
});

test('code blocks highlight syntax, escape source HTML and copy contiguous runnable code', () => {
  const p = setup();
  p.lesson.problems[0].variants.leetcode.blocks[0].code += '\n# <img src=x onerror=alert(1)>';
  const root = p.render({ stage: 'code' });
  assert.ok(root.querySelector('.hljs-keyword'));
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelectorAll('[data-code-step="S2"]').length, 1);
  root.querySelector('[data-copy="full"]').click();
  assert.equal(p.events.at(-1)[1], p.lesson.problems[0].variants.leetcode.code);
  root.querySelector('[data-copy="core"]').click();
  assert.doesNotMatch(p.events.at(-1)[1], /__main__/);
  root.querySelector('[data-mode="acm"]').click();
  assert.deepEqual(p.events.pop(), ['mode', 'acm']);
  const acm = p.render({ stage: 'code', mode: 'acm' });
  assert.match(acm.textContent, /本地约定/);
  assert.match(acm.textContent, /4 9\n2 7 11 15/);
  assert.equal(acm.querySelector('[data-copy="core"]'), null);
});

test('question selection and mixed ordinary answers remain available without combining algorithms', () => {
  const p = setup(); p.lesson.answer = '2. B. 普通题';
  p.lesson.problems.push({ ...p.lesson.problems[0], no: '3', title: '第二道编程题' });
  const root = p.render({ stage: 'insight', problemIndex: 1 });
  assert.match(root.textContent, /第二道编程题/); assert.match(root.textContent, /2. B. 普通题/);
  root.querySelector('[data-problem="0"]').click(); assert.deepEqual(p.events.pop(), ['problem', 0]);
  assert.equal(root.querySelector('[data-stage="insight"]').getAttribute('aria-current'), 'step');
  assert.ok(root.querySelector('[data-ordinary-explain]'));
  root.querySelector('[data-ordinary-explain]').click(); assert.deepEqual(p.events.pop(), ['explain']);
});
