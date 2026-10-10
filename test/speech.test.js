import test from 'node:test';
import assert from 'node:assert/strict';
import { transcriptionConfig, VoiceGate, TranscriptRouter, speechChunks } from '../src/speech.js';
test('live transcription is silent, uses plural languages, and no unsupported server VAD', () => {
  const s = transcriptionConfig();
  assert.equal(s.session.type, 'transcription');
  assert.equal(s.session.audio.input.transcription.model, 'gpt-live-transcribe');
  assert.deepEqual(s.session.audio.input.transcription.languages, ['zh']);
  assert.equal(s.session.audio.input.turn_detection, null);
});
test('speech commits once after pause, ambient silence does not create requests', () => {
  const output = []; const g = new VoiceGate(x => output.push(x));
  const silent = Buffer.alloc(4800); const loud = Buffer.alloc(4800);
  for (let i = 0; i < loud.length; i += 2) loud.writeInt16LE(4000, i);
  for (let i = 0; i < 10; i++) g.push(silent);
  assert.equal(output.length, 0);
  g.push(loud); g.push(loud); g.push(loud);
  for (let i = 0; i < 10; i++) g.push(silent);
  assert.equal(output.filter(e => e.type === 'input_audio_buffer.commit').length, 1);
});
test('partial and repeated final transcripts cannot duplicate a command', () => {
  const results = []; const r = new TranscriptRouter(x => results.push(x));
  r.handle({ type: 'conversation.item.input_audio_transcription.delta', item_id: '1', delta: '启动' });
  assert.equal(results.length, 0);
  const final = { type: 'conversation.item.input_audio_transcription.completed', item_id: '1', transcript: '启动' };
  r.handle(final); r.handle(final); assert.deepEqual(results, ['启动']);
});
test('long answers are split without dropping characters', () => {
  const text = '第一题答案是A。'.repeat(150);
  const chunks = speechChunks(text, 160);
  assert.equal(chunks.join(''), text); assert.ok(chunks.every(c => c.length <= 160));
});
