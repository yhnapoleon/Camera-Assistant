import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openaiResponse } from '../src/openai.js';

const completed = text => ({ ok: true, json: async () => ({ status: 'completed', output: [
  { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'private reasoning' }] },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
] }) });

test('OpenAI preserves multiple images, task context and cancellation, without storing responses', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'camera-openai-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const images = [path.join(dir, 'one.png'), path.join(dir, 'two.png')];
  await Promise.all(images.map((file, i) => sharp({ create: { width: 20, height: 20, channels: 3, background: i ? 'black' : 'white' } }).png().toFile(file)));
  const controller = new AbortController(); let receivedSignal;
  const answer = await openaiResponse({ apiKey: 'test-secret', prompt: 'task context', instructions: 'image rules', images, signal: controller.signal,
    request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.redirect, 'error');
      receivedSignal = options.signal;
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.reasoning.effort, 'low'); assert.equal(body.store, false);
      assert.equal(body.instructions, 'image rules'); assert.equal(body.input[0].content[0].text, 'task context');
      assert.equal(body.input[0].content.length, 3);
      for (const image of body.input[0].content.slice(1)) assert.match(image.image_url, /^data:image\/jpeg;base64,/);
      return completed('answer only');
    } });
  assert.equal(answer, 'answer only'); controller.abort(); assert.equal(receivedSignal.aborted, true);
});

test('OpenAI supports text-only comparison with the requested model and effort', async () => {
  assert.equal(await openaiResponse({ apiKey: 'test', model: 'chosen-model', effort: 'medium', prompt: 'compare', request: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'chosen-model'); assert.equal(body.reasoning.effort, 'medium');
    assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: 'compare' }]);
    return completed('comparison');
  } }), 'comparison');
});

test('OpenAI fails explicitly for missing keys, incomplete output, empty answers and HTTP errors', async () => {
  await assert.rejects(openaiResponse({}), /OPENAI_API_KEY/);
  await assert.rejects(openaiResponse({ apiKey: 'test', request: async () => ({ ok: false, status: 401 }) }), /401/);
  await assert.rejects(openaiResponse({ apiKey: 'test', request: async () => ({ ok: true, json: async () => ({ status: 'incomplete' }) }) }), /未完整/);
  await assert.rejects(openaiResponse({ apiKey: 'test', request: async () => completed('') }), /未返回/);
});

test('already cancelled OpenAI calls do not read images or send requests', async () => {
  const controller = new AbortController(); controller.abort(); let requested = false;
  await assert.rejects(openaiResponse({ apiKey: 'test', images: ['missing.png'], signal: controller.signal, request: async () => { requested = true; return completed(''); } }), { name: 'AbortError' });
  assert.equal(requested, false);
});
