import test from 'node:test';
import assert from 'node:assert/strict';
import { transcribeAudio } from '../src/voice.js';

test('OpenAI transcription uploads the original audio as multipart using the configured model', async () => {
  const controller = new AbortController();
  const text = await transcribeAudio(Buffer.from('audio content'), { apiKey: 'test-key', model: 'chosen-stt', mime: 'audio/mp4', signal: controller.signal,
    request: async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.equal(options.headers.Authorization, 'Bearer test-key');
      assert.equal(options.headers['Content-Type'], undefined, 'fetch must supply the multipart boundary');
      assert.equal(options.body.get('model'), 'chosen-stt');
      const file = options.body.get('file'); assert.equal(file.name, 'question.mp4'); assert.equal(file.type, 'audio/mp4');
      assert.equal(await file.text(), 'audio content');
      controller.abort(); assert.equal(options.signal.aborted, true);
      return Response.json({ text: '  什么是闭包？  ' });
    },
  });
  assert.equal(text, '什么是闭包？');
});

test('transcription errors do not expose provider bodies or accept empty transcripts', async () => {
  const options = { apiKey: 'test-key', mime: 'audio/webm' };
  await assert.rejects(transcribeAudio(Buffer.from('a'), { ...options, request: async () => new Response('secret provider detail', { status: 401 }) }), /OpenAI 转写返回 401/);
  await assert.rejects(transcribeAudio(Buffer.from('a'), { ...options, request: async () => Response.json({ text: ' ' }) }), /未识别到/);
  await assert.rejects(transcribeAudio(Buffer.alloc(20_000_001), options), /20 MB/);
});

test('an already cancelled transcription never sends an upstream request', async () => {
  let requests = 0;
  await assert.rejects(transcribeAudio(Buffer.from('a'), { apiKey: 'test-key', mime: 'audio/webm', signal: AbortSignal.abort(),
    request: async () => { requests++; return Response.json({ text: 'late result' }); },
  }), /abort/i);
  assert.equal(requests, 0);
});
