const test = require('node:test');
const assert = require('node:assert/strict');
const Net = require('../src/net.js');

// Minimal event emitter standing in for PeerJS objects.
class Emitter {
  constructor() {
    this.handlers = {};
  }
  on(type, fn) {
    this.handlers[type] = fn;
  }
  emit(type, arg) {
    this.handlers[type](arg);
  }
}

class FakeConn extends Emitter {
  constructor() {
    super();
    this.open = false;
    this.sent = [];
    this.closed = false;
  }
  send(msg) {
    this.sent.push(msg);
  }
  close() {
    this.closed = true;
  }
  up() {
    this.open = true;
    this.emit('open');
  }
}

function fakePeerClass() {
  const peers = [];
  class FakePeer extends Emitter {
    constructor(id) {
      super();
      this.id = id;
      this.destroyed = false;
      this.dialed = null;
      peers.push(this);
    }
    destroy() {
      this.destroyed = true;
    }
    connect(id, options) {
      this.dialed = { id, options, conn: new FakeConn() };
      return this.dialed.conn;
    }
  }
  return { FakePeer, peers };
}

function recorder() {
  const log = [];
  const handlers = {};
  for (const name of ['onOpen', 'onConnect', 'onMessage', 'onClose', 'onError']) {
    handlers[name] = (arg) => log.push([name, arg]);
  }
  return { log, handlers };
}

const mockTime = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });

const seq = (...vals) => {
  let i = 0;
  return () => vals[i++ % vals.length];
};

test('isCode accepts four capital letters without I or O', () => {
  assert.ok(Net.isCode('ABCD'));
  assert.ok(Net.isCode('WXYZ'));
  for (const bad of ['ABC', 'ABCDE', 'abcd', 'ABIO', 'AB1D', '']) assert.ok(!Net.isCode(bad), bad);
});

test('host registers its room code, reports it, and links the first caller', (t) => {
  mockTime(t);
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  const net = Net.createNet(FakePeer, handlers, seq(0, 0.99, 0.5, 0.1));
  net.host();
  assert.equal(peers[0].id, 'ringtoss-v1-aznc');
  peers[0].emit('open');
  assert.deepEqual(log, [['onOpen', 'AZNC']]);

  net.send({ t: 'early' }); // no link yet: nothing to send on
  const conn = new FakeConn();
  peers[0].emit('connection', conn);
  conn.up();
  conn.emit('data', { t: 'charge' });
  net.send({ t: 'start' });
  assert.deepEqual(conn.sent, [{ t: 'start' }]);
  assert.deepEqual(log.slice(1), [['onConnect', undefined], ['onMessage', { t: 'charge' }]]);

  conn.emit('close');
  conn.emit('error', new Error('boom'));
  assert.deepEqual(log.slice(3), [['onClose', undefined], ['onError', 'NETWORK ERROR']]);
});

test('host turns away anyone dialling in after the friend', (t) => {
  mockTime(t);
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  Net.createNet(FakePeer, handlers, seq(0)).host();
  peers[0].emit('connection', new FakeConn());
  const late = new FakeConn();
  peers[0].emit('connection', late);
  late.up();
  assert.deepEqual(late.sent, [{ t: 'full' }]);
  assert.equal(late.closed, false);
  t.mock.timers.tick(Net.FULL_CLOSE_MS);
  assert.equal(late.closed, true);
  assert.deepEqual(log, []);
});

test('host rolls a new code when its id is taken', () => {
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  Net.createNet(FakePeer, handlers, seq(0, 0, 0, 0, 0.99, 0.99, 0.99, 0.99)).host();
  peers[0].emit('error', { type: 'unavailable-id' });
  assert.equal(peers[0].destroyed, true);
  assert.equal(peers[1].id, 'ringtoss-v1-zzzz');
  assert.deepEqual(log, []);
});

test('peer errors before the link map to readable reasons', () => {
  for (const [type, text] of [
    ['peer-unavailable', 'GAME NOT FOUND'],
    ['browser-incompatible', 'BROWSER NOT SUPPORTED'],
    ['server-error', 'NETWORK ERROR'],
  ]) {
    const { FakePeer, peers } = fakePeerClass();
    const { log, handlers } = recorder();
    Net.createNet(FakePeer, handlers).host();
    peers[0].emit('error', { type });
    assert.deepEqual(log, [['onError', text]]);
  }
});

test('signalling errors after the link is up do not end the match', (t) => {
  mockTime(t);
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  Net.createNet(FakePeer, handlers).host();
  const conn = new FakeConn();
  peers[0].emit('connection', conn);
  conn.up();
  peers[0].emit('error', { type: 'network' });
  assert.deepEqual(log, [['onConnect', undefined]]);
});

test('guest dials the room with a reliable JSON channel', (t) => {
  mockTime(t);
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  const net = Net.createNet(FakePeer, handlers);
  net.join('WXYZ');
  assert.equal(peers[0].id, undefined);
  peers[0].emit('open');
  const { id, options, conn } = peers[0].dialed;
  assert.equal(id, 'ringtoss-v1-wxyz');
  assert.deepEqual(options, { reliable: true, serialization: 'json' });
  conn.up();
  net.send({ t: 'throw', power: 0.5 });
  assert.deepEqual(conn.sent, [{ t: 'throw', power: 0.5 }]);
  t.mock.timers.tick(Net.CONNECT_TIMEOUT_MS);
  assert.deepEqual(log[0], ['onConnect', undefined]);
  assert.ok(!log.some(([name]) => name === 'onError')); // connect timeout was cancelled
});

test('guest gives up if the link is not up in time, and reports only once', (t) => {
  mockTime(t);
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  Net.createNet(FakePeer, handlers).join('WXYZ');
  t.mock.timers.tick(Net.CONNECT_TIMEOUT_MS);
  assert.deepEqual(log, [['onError', 'COULD NOT CONNECT']]);

  const second = recorder();
  const { FakePeer: P2, peers: peers2 } = fakePeerClass();
  Net.createNet(P2, second.handlers).join('WXYZ');
  peers2[0].emit('error', { type: 'peer-unavailable' });
  t.mock.timers.tick(Net.CONNECT_TIMEOUT_MS);
  assert.deepEqual(second.log, [['onError', 'GAME NOT FOUND']]);
  assert.equal(peers.length, 1);
});

test('peers ping each other, hide pings from the game, and call a long silence a leave', (t) => {
  mockTime(t);
  const { FakePeer, peers } = fakePeerClass();
  const { log, handlers } = recorder();
  Net.createNet(FakePeer, handlers).host();
  const conn = new FakeConn();
  peers[0].emit('connection', conn);
  conn.up();
  t.mock.timers.tick(Net.PING_MS);
  assert.deepEqual(conn.sent, [{ t: 'ping' }]);
  conn.emit('data', { t: 'ping' });
  conn.emit('data', null);
  assert.deepEqual(log, [['onConnect', undefined], ['onMessage', null]]);

  t.mock.timers.tick(Net.SILENCE_MS);
  assert.equal(log.length, 2); // exactly SILENCE_MS of quiet is still fine
  t.mock.timers.tick(Net.PING_MS);
  assert.deepEqual(log.at(-1), ['onClose', undefined]);
  const pings = conn.sent.length;
  t.mock.timers.tick(Net.SILENCE_MS);
  assert.equal(conn.sent.length, pings); // heartbeat stopped
  assert.equal(log.length, 3);
});

test('join refuses a malformed room code', () => {
  const { FakePeer } = fakePeerClass();
  const net = Net.createNet(FakePeer, recorder().handlers);
  assert.throws(() => net.join('abcd'), /bad room code "abcd"/);
});
