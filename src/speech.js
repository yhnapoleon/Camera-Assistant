export function transcriptionConfig(model = 'gpt-live-transcribe') {
  return { type: 'session.update', session: { type: 'transcription', audio: { input: {
    format: { type: 'audio/pcm', rate: 24000 },
    transcription: { model, languages: ['zh'], keywords: ['拍', '答案', '全部答案', '拍摄', '启动', '长程', '停止', '提问', '我要提问', '请回答', '请问', '开始解答', '暂停播报', '继续播报', '取消任务'], delay: 'low' },
    turn_detection: null,
  } } } };
}
export class VoiceGate {
  constructor(send, { threshold = 0.018, pauseMs = 550 } = {}) {
    this.send = send; this.threshold = threshold; this.pauseMs = pauseMs;
    this.active = false; this.quiet = 0; this.duration = 0; this.pre = [];
  }
  push(pcm) {
    if (!pcm.length || pcm.length % 2) return;
    let power = 0; for (let i = 0; i < pcm.length; i += 2) power += (pcm.readInt16LE(i) / 32768) ** 2;
    const loud = Math.sqrt(power / (pcm.length / 2)) >= this.threshold;
    const ms = pcm.length / 48;
    if (!this.active) {
      this.pre.push(pcm); if (this.pre.length > 3) this.pre.shift();
      if (!loud) return;
      this.active = true; for (const b of this.pre) this.append(b); this.pre = [];
    } else this.append(pcm);
    this.duration += ms; this.quiet = loud ? 0 : this.quiet + ms;
    if (this.quiet >= this.pauseMs || this.duration >= 15000) {
      this.send({ type: 'input_audio_buffer.commit' });
      this.active = false; this.quiet = 0; this.duration = 0;
    }
  }
  append(pcm) { this.send({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') }); }
}
export class TranscriptRouter {
  constructor(onFinal) { this.onFinal = onFinal; this.seen = new Set(); }
  handle(e) {
    if (e.type !== 'conversation.item.input_audio_transcription.completed' || !e.item_id || this.seen.has(e.item_id)) return;
    this.seen.add(e.item_id); if (this.seen.size > 2000) this.seen.delete(this.seen.values().next().value);
    if (e.transcript?.trim()) this.onFinal(e.transcript.trim());
  }
}
export function speechChunks(text, max = 700) {
  const chunks = []; let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max); const split = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('\n'));
    const n = split >= max / 3 ? split + 1 : max;
    chunks.push(rest.slice(0, n)); rest = rest.slice(n);
  }
  if (rest) chunks.push(rest); return chunks;
}
