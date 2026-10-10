import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteSource } from '../src/remote-source.js';
test('remote commands are redelivered until acknowledged, then consumed once', () => {
  const source = new RemoteSource(); const id = source.register('Test PC');
  const command = source.push({ type: 'capture', batch: { id: 'batch-1', mode: 'five' } });
  assert.equal(source.poll(id).command.id, command.id);
  assert.equal(source.poll(id).command.id, command.id);
  assert.equal(source.poll(id, command.id).command, null);
  assert.throws(() => source.poll('wrong'));
});
test('a dead source cannot receive new capture commands', () => {
  let now = 0; const source = new RemoteSource({ now: () => now }); source.register('Test PC');
  now = 20000; assert.equal(source.online, false); assert.throws(() => source.push({ type: 'capture' }));
});

test('pairing probe succeeds only after matching acknowledgement and expires with the source', () => {
  let now = 100; const source = new RemoteSource({now:()=>now}); const id=source.register('Screen PC');
  const probe=source.push({type:'ping'});
  assert.equal(source.status().lastProbe,null);
  source.poll(id,'wrong'); assert.equal(source.status().lastProbe,null);
  source.poll(id); assert.equal(source.status().lastProbe,null);
  source.poll(id,probe.id); assert.equal(source.status().lastProbe.id,probe.id);
  now+=16000; assert.equal(source.status().online,false);
  source.register('New PC'); assert.equal(source.status().lastProbe,null);
});
