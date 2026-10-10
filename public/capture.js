export class CaptureController {
  constructor({ snapshot, upload, onFinish, onChange = () => {}, interval = 1000 }) {
    Object.assign(this, { snapshot, upload, onFinish, onChange, interval });
    this.batch = null; this.tail = Promise.resolve(); this.pending = 0;
  }
  start(batch) {
    if (this.batch) throw Error('上一批照片仍在上传');
    this.batch = batch; this.count = 0; this.running = true; this.error = ''; this.finishing = null; this.tail = Promise.resolve();
    this.onChange(this);
    if (batch.mode === 'single') this.shot(); else this.timer = setTimeout(() => this.shot(), this.interval);
  }
  startImport(batch, files) {
    if (this.batch) throw Error('上一批照片仍在上传');
    this.batch = batch; this.count = 0; this.running = true; this.error = ''; this.finishing = null;
    const capturedAt = new Date().toISOString();
    this.tail = (async () => {
      for (const file of files) {
        if (!this.running) break;
        this.pending = 1; this.count++; this.onChange(this);
        try { await this.upload(file, batch, capturedAt); }
        catch (e) { this.error = e.message; this.running = false; }
        finally { this.pending = 0; this.onChange(this); }
      }
    })();
    this.tail.then(() => this.stop());
  }
  shot() {
    if (!this.running) return;
    if (this.pending >= 8) { this.stop('上传跟不上拍摄，已停止采集，请检查网络'); return; }
    const batch = this.batch; const capturedAt = new Date().toISOString(); this.count++; this.pending++;
    const snapshot = Promise.resolve().then(() => this.snapshot());
    // Attach the rejection handler immediately even while earlier uploads are pending.
    const settled = snapshot.then(value => ({ value }), error => ({ error }));
    this.tail = this.tail.then(async () => {
      const result = await settled; if (result.error) throw result.error;
      await this.upload(result.value, batch, capturedAt);
    }).catch(e => { this.error ||= e.message; this.stop(this.error); }).finally(() => { this.pending--; this.onChange(this); });
    this.onChange(this);
    if (batch.mode === 'single' || (batch.mode === 'five' && this.count >= 5)) this.stop();
    else this.timer = setTimeout(() => this.shot(), this.interval);
  }
  stop(error = '') {
    if (!this.batch) return Promise.resolve();
    this.error ||= error; this.running = false; clearTimeout(this.timer);
    if (this.finishing) return this.finishing;
    const batch = this.batch;
    this.finishing = this.tail.then(async () => {
      this.batch = null; this.onChange(this); await this.onFinish(batch, this.error);
    });
    return this.finishing;
  }
  settled() { return this.tail; }
}
