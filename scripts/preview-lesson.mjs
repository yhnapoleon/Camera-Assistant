// Deterministic local preview. No model calls, no production records.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMouseApp } from '../src/mouse-server.js';
import { demoLesson } from '../src/lesson-demo.js';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'shiyue-lesson-preview-'));
const app = createMouseApp({ dataDir, token: 'lesson-preview', analyze: async () => JSON.stringify(demoLesson()), match: async () => '改动：不用改\n结论：1' });
app.store.submit([], 'demo');
const port = Number(process.env.PREVIEW_PORT || 8792);
app.server.listen(port, '127.0.0.1', () => console.log(`学习界面演示（无模型调用）：http://localhost:${port}/#pair=lesson-preview`));
process.on('SIGINT', async () => { await app.close(); process.exit(); });
