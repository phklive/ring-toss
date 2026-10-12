const test = require('node:test');
const assert = require('node:assert/strict');
const Game = require('../src/game.js');
const Render = require('../src/render.js');
const Net = require('../src/net.js');
const boot = require('../src/main.js');

const { CFG } = Game;
const flush = () => new Promise(setImmediate);

// Browser, DOM, and network stand-ins. `clipboard` decides whether copying works.
function fakeEnv({ hash = '', ctx = { fillStyle: '', fillRect() {} }, clipboard = 'ok', missing = null } = {}) {
  const listeners = {};
  const on = (target) => (type, fn) => {
    listeners[`${target}.${type}`] = fn;
  };
  const els = {
    game: { width: 0, height: 0, style: {}, getContext: (kind) => (kind === '2d' ? ctx : null) },
    share: { hidden: true },
    link: { value: '', selected: false, select() {
      this.selected = true;
    } },
    copy: { textContent: 'Copy link', addEventListener: on('copy') },
  };
  const assigned = [];
  const win = {
    innerWidth: 1300,
    innerHeight: 800,
    location: { hash, origin: 'https://x.test', pathname: '/ring-toss/', assign: (url) => assigned.push(url) },
    navigator: {
      clipboard: { writeText: (text) => (clipboard === 'ok' ? Promise.resolve(text) : Promise.reject(new Error('no'))) },
    },
    addEventListener: on('win'),
    requestAnimationFrame: (fn) => {
      win.nextFrame = fn;
    },
  };
  const doc = { getElementById: (id) => (id === missing ? null : els[id]) };
  const net = { calls: [], sent: [], handlers: null };
  const FakeNet = {
    isCode: Net.isCode,
    createNet(Peer, handlers) {
      net.handlers = handlers;
      return {
        host: () => net.calls.push(['host']),
        join: (code) => net.calls.push(['join', code]),
        send: (msg) => net.sent.push(msg),
      };
    },
  };
  function Peer() {}
  const start = (overrides = {}) => boot({ win, doc, Game, Render, Net: FakeNet, Peer, ...overrides });
  let now = 0;
  const frames = (seconds) => {
    for (let i = Math.ceil(seconds / CFG.MAX_DT); i > 0; i--) win.nextFrame((now += 1000 * CFG.MAX_DT));
  };
  const key = (type, code) => {
    const e = { code, prevented: false, preventDefault: () => (e.prevented = true) };
    listeners[`win.${type}`](e);
    return e;
  };
  return { win, els, net, listeners, assigned, start, frames, key };
}

test('boot fails loudly when the page is missing a piece', () => {
  for (const id of ['game', 'share', 'link', 'copy']) {
    assert.throws(() => fakeEnv({ missing: id }).start(), new RegExp(`#${id} not found`));
  }
  assert.throws(() => fakeEnv({ ctx: null }).start(), /2D canvas context unavailable/);
  assert.throws(() => fakeEnv().start({ Peer: undefined }), /PeerJS failed to load/);
});

test('boot sizes the canvas to the largest integer scale that fits, at least 1x', () => {
  const env = fakeEnv();
  env.start();
  const canvas = env.els.game;
  assert.equal(canvas.width, CFG.W);
  assert.equal(canvas.height, CFG.H);
  assert.equal(canvas.style.width, `${CFG.W * 4}px`);
  assert.equal(canvas.style.height, `${CFG.H * 4}px`);
  env.win.innerWidth = 100;
  env.win.innerHeight = 100;
  env.listeners['win.resize']();
  assert.equal(canvas.style.width, `${CFG.W}px`);
});

test('no room code: host a room, show the link, start when the friend connects', () => {
  const env = fakeEnv();
  const game = env.start();
  assert.equal(game.me, 'left');
  assert.deepEqual(env.net.calls, [['host']]);
  assert.deepEqual(game.lobby, ['CREATING GAME...']);

  env.net.handlers.onOpen('ABCD');
  assert.equal(env.els.link.value, 'https://x.test/ring-toss/#ABCD');
  assert.equal(env.els.share.hidden, false);
  assert.deepEqual(game.lobby, ['WAITING FOR FRIEND', 'SEND THEM THE LINK BELOW']);

  env.net.handlers.onConnect();
  assert.equal(env.els.share.hidden, true);
  assert.equal(game.phase, 'countdown');
  env.win.nextFrame(0);
  assert.deepEqual(env.net.sent, [{ t: 'start' }]);
  assert.deepEqual(game.outbox, []);
});

test('room code in the link: join it, then follow the host', () => {
  const env = fakeEnv({ hash: '#wxyz' });
  const game = env.start();
  assert.equal(game.me, 'right');
  assert.deepEqual(env.net.calls, [['join', 'WXYZ']]);
  assert.deepEqual(game.lobby, ['JOINING GAME WXYZ...']);
  env.net.handlers.onConnect();
  assert.deepEqual(game.lobby, ['CONNECTED', 'STARTING...']);
  env.net.handlers.onMessage({ t: 'start' });
  assert.equal(game.phase, 'countdown');
  env.net.handlers.onClose();
  assert.equal(game.phase, 'ended');
  assert.equal(game.ending, 'FRIEND LEFT');
});

test('a malformed room code ends right away without dialling', () => {
  const env = fakeEnv({ hash: '#nope!' });
  const game = env.start();
  assert.deepEqual(env.net.calls, []);
  assert.equal(game.ending, 'BAD GAME LINK');
});

test('network errors end the game with their reason', () => {
  const env = fakeEnv();
  const game = env.start();
  env.net.handlers.onError('GAME NOT FOUND');
  assert.equal(game.phase, 'ended');
  assert.equal(game.ending, 'GAME NOT FOUND');
});

test('copy button copies the link, or leaves it selected for a manual copy', async () => {
  const ok = fakeEnv();
  ok.start();
  ok.listeners['copy.click']();
  await flush();
  assert.equal(ok.els.link.selected, true);
  assert.equal(ok.els.copy.textContent, 'Copied!');

  const refused = fakeEnv({ clipboard: 'refused' });
  refused.start();
  refused.listeners['copy.click']();
  await flush();
  assert.equal(refused.els.link.selected, true);
  assert.equal(refused.els.copy.textContent, 'Press Cmd/Ctrl+C');
});

test('space, pointer, and blur drive the throw button; throws go to the friend', () => {
  const env = fakeEnv();
  const game = env.start();
  env.net.handlers.onConnect();
  env.frames(CFG.COUNTDOWN + 0.1);
  assert.equal(game.phase, 'playing');

  const other = env.key('keydown', 'KeyA');
  assert.equal(other.prevented, false);
  env.frames(0.1);
  assert.equal(game.left.charging, false);

  assert.equal(env.key('keydown', 'Space').prevented, true);
  env.frames(0.1);
  assert.equal(game.left.charging, true);
  assert.equal(env.key('keyup', 'Space').prevented, true);
  env.frames(0.1);
  assert.equal(env.net.sent.at(-1).t, 'throw');

  env.frames(CFG.COOLDOWN);
  env.listeners['win.pointerdown']();
  env.frames(0.1);
  assert.equal(game.left.charging, true);
  env.listeners['win.pointercancel']();
  env.frames(0.1);
  assert.equal(game.left.charging, false);

  env.frames(CFG.COOLDOWN);
  env.listeners['win.pointerdown']();
  env.frames(0.1);
  env.listeners['win.blur']();
  env.frames(CFG.COOLDOWN + 0.1);
  env.listeners['win.pointerdown']();
  env.frames(0.1);
  env.listeners['win.pointerup']();
  env.frames(0.1);
  assert.equal(env.net.sent.filter((m) => m.t === 'throw').length, 4);
});

test('once the game has ended, any press opens a fresh room', () => {
  const env = fakeEnv({ hash: '#wxyz' });
  env.start();
  env.listeners['win.pointerdown']();
  assert.deepEqual(env.assigned, []);
  env.net.handlers.onClose();
  env.key('keydown', 'Space');
  env.listeners['win.pointerdown']();
  assert.deepEqual(env.assigned, ['/ring-toss/', '/ring-toss/']);
});

test('frame loop starts with dt 0 and caps long gaps at MAX_DT', () => {
  const env = fakeEnv();
  const game = env.start();
  env.win.nextFrame(5000);
  assert.equal(game.time, 0);
  env.win.nextFrame(9000);
  assert.equal(game.time, CFG.MAX_DT);
  env.win.nextFrame(9010);
  assert.ok(Math.abs(game.time - (CFG.MAX_DT + 0.01)) < 1e-9);
});
