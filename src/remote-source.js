import { randomUUID } from 'node:crypto';
export class RemoteSource {
  constructor({ now = Date.now } = {}) { this.now = now; this.session = null; this.commands = []; }
  get online() { return !!this.session && this.now() - this.session.seen < 15000; }
  register(name) {
    if (this.online) throw Error('已有屏幕采集器在线，请先关闭它');
    this.session = { id: randomUUID(), name: String(name || 'Windows PC').slice(0, 80), seen: this.now() }; this.commands = []; return this.session.id;
  }
  validate(id) { if (!this.session || id !== this.session.id) throw Error('屏幕采集会话已失效，请重启采集器'); }
  poll(id, ack) {
    this.validate(id); this.session.seen = this.now();
    if (ack && this.commands[0]?.id === ack) {
      const command = this.commands.shift();
      if (command.type === 'ping') this.session.lastProbe = { id: command.id, at: this.now() };
    }
    return { command: this.commands[0] || null };
  }
  push(command) {
    if (!this.online) throw Error('请先在另一台电脑启动屏幕采集器');
    const item = { ...command, id: randomUUID() }; this.commands.push(item); return item;
  }
  status() { return { online: this.online, name: this.session?.name || '', lastSeen: this.session?.seen || null, lastProbe: this.session?.lastProbe || null }; }
}
