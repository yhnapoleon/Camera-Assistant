// Real Chromium layout regression. Run with Playwright installed locally, or set
// PLAYWRIGHT_MODULE to its absolute module directory. Does not touch saved jobs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitAnswer } from '../src/mouse-core.js';
import { lessonFixture } from '../test/fixtures/lesson.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = lessonFixture();
for (const mode of ['leetcode', 'acm']) {
  fixture.problems[0].variants[mode].blocks[0].code += '\n' + [
    '# ' + '长注释应在屏幕内显示，保留行号且不改变复制结果。'.repeat(10),
    '        long_value = "' + 'abcdefghijklmnopqrstuvwxyz'.repeat(15) + '"',
    '        total = sum(values[index] * weights[index] for index in range(len(values)))',
  ].join('\n');
}
const lesson = splitAnswer(JSON.stringify(fixture)).lesson;
const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
const out = path.join(root, 'data/code-layout'); mkdirSync(out, { recursive: true });
let checked = 0;
try {
  const page = await browser.newPage();
  const html = readFileSync(path.join(root, 'public/mouse/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  await page.setContent(html);
  for (const name of ['mouse.css', 'lesson.css']) await page.addStyleTag({ path: path.join(root, 'public/mouse', name) });
  await page.addScriptTag({ path: path.join(root, 'node_modules/@highlightjs/cdn-assets/highlight.min.js') });
  await page.addScriptTag({ path: path.join(root, 'public/mouse/lesson-view.js') });
  for (const [width, height, turned] of [[320, 640, false], [390, 844, false], [844, 390, false], [800, 1280, false], [1280, 800, false], [390, 844, true], [800, 1280, true]]) {
    await page.setViewportSize({ width, height });
    for (const mode of ['leetcode', 'acm']) {
      const measured = await page.evaluate(({ lesson, mode, width, height, turned }) => {
        const root = document.documentElement;
        root.classList.toggle('turned', turned);
        root.style.setProperty('--vw', `${width}px`); root.style.setProperty('--vh', `${height}px`);
        root.style.setProperty('--row', `${Math.floor(Math.min(width, height) / 12)}px`);
        document.getElementById('pairView').hidden = true;
        document.getElementById('app').hidden = false;
        document.getElementById('answerView').hidden = false;
        document.getElementById('listView').hidden = true;
        const callbacks = { mode() {}, step() {}, navigate() {}, problem() {}, copy: text => { window.copied = text; } };
        document.getElementById('answer').replaceChildren(window.LessonView.render(lesson, { stage: 'code', mode }, callbacks));
        document.querySelector('[data-copy="full"]').click();
        const blocks = [...document.querySelectorAll('.source-code')];
        return {
          copied: window.copied,
          overflow: blocks.map(pre => ({ width: pre.clientWidth, content: pre.scrollWidth })),
          lines: blocks.map(pre => [...pre.children].map(line => line.textContent)),
          numbers: blocks.map(pre => [...pre.children].map(line => Number(line.dataset.line))),
          pageOverflow: document.getElementById('scroll').scrollWidth - document.getElementById('scroll').clientWidth,
        };
      }, { lesson, mode, width, height, turned });
      const label = `${width}x${height}${turned ? '-turned' : ''}-${mode}`;
      await page.locator('.source-code').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `${label}.png`) });
      assert.ok(measured.overflow.every(p => p.width > 0 && p.content <= p.width + 1), `${label}: code requires horizontal scrolling: ${JSON.stringify(measured.overflow)}`);
      assert.ok(measured.pageOverflow <= 1, `${label}: page overflow`);
      const variant = lesson.problems[0].variants[mode];
      assert.equal(measured.copied, variant.code, `${label}: copying must preserve original code`);
      variant.blocks.forEach((block, i) => {
        assert.deepEqual(measured.lines[i], block.code.split('\n'), `${label}: visual wrapping must preserve source lines`);
        assert.deepEqual(measured.numbers[i], block.code.split('\n').map((_, j) => block.start + j));
      });
      checked++;
    }
  }
  console.log(`PASS: ${checked} phone/tablet/orientation/mode combinations; no horizontal code overflow, original source and numbering preserved.`);
} finally { await browser.close(); }
