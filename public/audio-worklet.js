class PCMRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.samples = []; this.phase = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0]; if (!channel) return true;
    // AudioContext normally runs at 24 kHz; this handles device-selected rates too.
    for (let i = 0; i < channel.length; i++) {
      this.phase += 24000;
      if (this.phase >= sampleRate) { this.phase -= sampleRate; this.samples.push(Math.max(-1, Math.min(1, channel[i]))); }
      if (this.samples.length === 2400) {
        const buffer = new ArrayBuffer(4800), view = new DataView(buffer);
        this.samples.forEach((s, j) => view.setInt16(j * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true));
        this.port.postMessage(buffer, [buffer]); this.samples = [];
      }
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
