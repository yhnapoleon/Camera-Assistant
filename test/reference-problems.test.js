import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { COMPANY_PROBLEMS } from '../src/problem-list.js';
import { parseMatch } from '../src/mouse-core.js';
import { answerPrompt, matchPrompt } from '../src/mouse-server.js';

const bank = () => JSON.parse(readFileSync(new URL('../src/reference-problems.json', import.meta.url), 'utf8'));

test('Huawei reference problems retain complete statements, explanations, source code and examples', () => {
  const entries = bank();
  assert.deepEqual(entries.map(p => p.no), ['E29', 'E30']);
  for (const entry of entries) {
    assert.equal(COMPANY_PROBLEMS.get(entry.no).title, entry.title);
    assert.equal(entry.company, '华为');
    assert.ok(entry.statement.includes('输入') && entry.statement.includes('输出'));
    assert.ok(entry.solution && entry.pitfalls && entry.code.includes('def main():'));
    assert.equal(entry.source.date, '2026-10-14');
    assert.match(entry.source.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(entries[0].examples.length, 2);
  assert.equal(entries[1].examples.length, 1);
  assert.match(entries[0].limitations, /RMS.*0/);
});

test('answer generation receives original solutions for reuse before solving, for screenshots and photos', () => {
  for (const mode of ['single', 'camera']) {
    const prompt = answerPrompt({ mode });
    assert.ok(prompt.includes('Masked Fused RMSNorm'), 'answer prompt can actually use the bank');
    for (const entry of bank()) {
      assert.ok(prompt.includes(entry.code), 'reference source survives verbatim');
      assert.ok(prompt.includes(entry.statement));
    }
    for (const requirement of ['原题', '变式', '当前题面', '不相关', '已有代码', 'RMS 为 0']) assert.ok(prompt.includes(requirement));
    assert.ok(prompt.includes('"variants"'), 'preserve structured lesson output');
  }
});

test('both Huawei problems participate in original and variant matching', () => {
  const prompt = matchPrompt({ insights: [], answer: '' });
  for (const [id, title] of [['E29', 'Masked Fused RMSNorm 算子数值实现'], ['E30', '用 CART 分类树预测客户是否购房']]) {
    assert.ok(prompt.includes(`${id} ${title}｜华为｜`));
    assert.deepEqual(parseMatch(`改动：不用改\n结论：${id}`)[0], { relation: 'same', problem: title, hot: false, note: '', company: '华为', kind: '笔试' });
    assert.equal(parseMatch(`改动：要改：按当前题面改变规则\n结论：${id}`)[0].relation, 'variant');
  }
});

test('preserved Python reference answers produce every supplied sample output', t => {
  const python = process.env.PYTHON || 'python';
  const available = spawnSync(python, ['--version'], { encoding: 'utf8', timeout: 10000 });
  if (available.error || available.status !== 0) return t.skip('Python is unavailable');
  for (const entry of bank()) for (const sample of entry.examples) {
    const run = spawnSync(python, ['-c', entry.code], { input: sample.input, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim().replaceAll('\r\n', '\n'), sample.output.trim(), `${entry.no} sample`);
  }
});
