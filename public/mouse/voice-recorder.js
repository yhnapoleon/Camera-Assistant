export class VoiceRecorder {
  constructor({ getUserMedia = options => navigator.mediaDevices.getUserMedia(options), Recorder = globalThis.MediaRecorder, submit, onState, maxMs = 300000, maxBytes = 20_000_000 }) {
    Object.assign(this, { getUserMedia, Recorder, submit, onState, maxMs, maxBytes });
    this.state = 'idle'; this.generation = 0;
  }
  setState(state, message = '') { this.state = state; this.onState?.(state, message); }
  release() {
    clearTimeout(this.timer);
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
  }
  async start() {
    if (!['idle', 'done', 'error'].includes(this.state)) return;
    const generation = ++this.generation;
    this.setState('requesting');
    try {
      if (!this.Recorder) throw Error('浏览器不支持录音，请使用新版 Chrome、Edge 或 Safari');
      const stream = await this.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => this.Recorder.isTypeSupported(type));
      const recorder = this.recorder = new this.Recorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = []; let size = 0;
      recorder.ondataavailable = event => {
        if (generation !== this.generation || !event.data.size) return;
        size += event.data.size;
        if (size > this.maxBytes) { this.cancel(); this.setState('error', '录音超过 20 MB，请缩短录音后重试'); return; }
        chunks.push(event.data);
      };
      recorder.onerror = () => { if (generation === this.generation) { this.cancel(); this.setState('error', '录音中断，请检查麦克风后重试'); } };
      recorder.onstop = async () => {
        if (generation !== this.generation) return;
        this.release(); this.recorder = null;
        const controller = this.controller = new AbortController();
        try {
          const audio = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || mimeType });
          if (!audio.size) throw Error('录音为空，请重新录音');
          this.setState('processing');
          await this.submit(audio, { signal: controller.signal });
          if (generation === this.generation) this.setState('done');
        } catch (error) { if (generation === this.generation) this.setState('error', error.message); }
        finally { if (this.controller === controller) this.controller = null; }
      };
      recorder.start(1000); this.startedAt = Date.now(); this.setState('recording');
      this.timer = setTimeout(() => this.stop(), this.maxMs);
    } catch (error) {
      if (generation !== this.generation) return;
      this.release();
      const message = error.name === 'NotAllowedError' ? '麦克风权限被拒绝，请在浏览器站点设置中允许麦克风后重试'
        : error.name === 'NotFoundError' ? '没有找到麦克风，请连接麦克风后重试' : error.message;
      this.setState('error', message);
    }
  }
  stop() {
    if (this.state === 'requesting') { this.cancel(); return; }
    if (this.state !== 'recording') return;
    this.setState('stopping'); clearTimeout(this.timer);
    this.recorder.stop(); this.release();
  }
  cancel() {
    ++this.generation; this.controller?.abort(); this.controller = null;
    const recorder = this.recorder; this.recorder = null;
    if (recorder) { recorder.ondataavailable = recorder.onstop = recorder.onerror = null; if (recorder.state !== 'inactive') recorder.stop(); }
    this.release(); this.setState('idle');
  }
}
