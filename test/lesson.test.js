import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAnswer } from '../src/mouse-core.js';
import { lessonFixture } from './fixtures/lesson.js';

test('structured mixed answers preserve ordinary answers and both complete runnable modes', () => {
  const input = lessonFixture(); input.answer = '2. B. 哈希表';
  const result = splitAnswer(JSON.stringify(input));
  assert.equal(result.lesson?.version, 1);
  assert.equal(result.kind, 'code');
  assert.equal(result.lesson.answer, '2. B. 哈希表');
  assert.equal(result.insights[0].summary, input.problems[0].summary);
  assert.match(result.answer, /class Solution/);
  const v = result.lesson.problems[0].variants;
  assert.match(v.leetcode.code, /if __name__ == "__main__"/);
  assert.match(v.acm.code, /sys.stdin.read/);
  assert.doesNotMatch(v.leetcode.submission, /__main__/);
  assert.equal(v.leetcode.blocks[1].start, 5);
  assert.equal(v.leetcode.blocks[1].end, 9);
});

test('incomplete lessons fail explicitly instead of becoming successful plain text', () => {
  for (const mutate of [
    p => delete p.variants.acm,
    p => p.steps.push({ ...p.steps[0] }),
    p => p.variants.leetcode.blocks[0].step = 'S99',
    p => p.diagram.edges[0].to = 'missing',
    p => p.diagram.nodes[0].step = 'S99',
    p => p.variants.acm.blocks = p.variants.acm.blocks.slice(1),
    p => p.language = '',
  ]) {
    const input = lessonFixture(); mutate(input.problems[0]);
    assert.throws(() => splitAnswer(JSON.stringify(input)), /学习内容/);
  }
  assert.throws(() => splitAnswer('{"version":1,"problems":['), /学习内容/);
});

test('fenced JSON normalizes line endings, rejects oversized text and duplicate question numbers', () => {
  const input = lessonFixture();
  input.problems[0].variants.leetcode.blocks[0].code = 'class Solution:\r\n    # test';
  const parsed = splitAnswer('```json\n' + JSON.stringify(input) + '\n```');
  assert.doesNotMatch(parsed.lesson.problems[0].variants.leetcode.code, /\r/);
  input.problems.push(input.problems[0]);
  assert.throws(() => splitAnswer(JSON.stringify(input)), /学习内容/);
  input.problems.pop(); input.problems[0].summary = 'x'.repeat(20001);
  assert.throws(() => splitAnswer(JSON.stringify(input)), /学习内容/);
});

test('legacy answers and ordinary questions stay readable', () => {
  assert.deepEqual(splitAnswer('标题：普通题\n1. A'), { title: '普通题', answer: '1. A' });
  const old = splitAnswer('标题：旧题\n类型：代码题\n代码：\n```python\nprint(1)\n```\n题意：输出 1\n分类：模拟\n思路：输出');
  assert.equal(old.kind, 'code'); assert.equal(old.lesson, undefined);
});
