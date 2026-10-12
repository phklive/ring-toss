const test = require('node:test');
const assert = require('node:assert/strict');
const Game = require('../src/game.js');

const { CFG } = Game;
const DT = 1 / 60;

const run = (g, seconds, down = false, dt = DT) => {
  for (let f = Math.round(seconds / dt); f > 0; f--) Game.update(g, dt, down);
};

// Step until pred() holds; fail instead of looping forever.
const runUntil = (g, pred, down = false, maxSeconds = 10) => {
  for (let f = Math.round(maxSeconds / DT); f > 0; f--) {
    if (pred()) return;
    Game.update(g, DT, down);
  }
  assert.fail('condition never reached');
};

// A host mid-match with an empty outbox.
function playing(side = 'left') {
  const g = Game.createGame(side);
  g.phase = 'countdown';
  run(g, CFG.COUNTDOWN + 2 * DT);
  assert.equal(g.phase, 'playing');
  g.outbox.length = 0;
  return g;
}

function throwAt(g, power) {
  const me = g[g.me];
  me.charging = true;
  me.power = power;
  Game.update(g, DT, false);
  return g.discs[g.discs.length - 1];
}

function addDisc(g, props) {
  const d = { owner: 'left', state: 'flying', vx: 0, vy: 0, restY: 0, ttl: 0, ...props };
  g.discs.push(d);
  return d;
}

// Host and guest wired back to back: each frame delivers both outboxes.
function pair() {
  return { host: Game.createGame('left'), guest: Game.createGame('right') };
}
function step(p, hostDown = false, guestDown = false) {
  Game.update(p.host, DT, hostDown);
  Game.update(p.guest, DT, guestDown);
  for (const m of p.host.outbox.splice(0)) Game.applyMessage(p.guest, m);
  for (const m of p.guest.outbox.splice(0)) Game.applyMessage(p.host, m);
}
const stepFor = (p, seconds, hostDown, guestDown) => {
  for (let f = Math.round(seconds / DT); f > 0; f--) step(p, hostDown, guestDown);
};

test('pointsFor: nearest pole is 1, farthest is 3, mirrored for the right side', () => {
  assert.deepEqual([0, 1, 2].map((i) => Game.pointsFor('left', i)), [1, 2, 3]);
  assert.deepEqual([0, 1, 2].map((i) => Game.pointsFor('right', i)), [3, 2, 1]);
});

test('speedForPower maps 0..1 onto MIN_SPEED..MAX_SPEED', () => {
  assert.equal(Game.speedForPower(0), CFG.MIN_SPEED);
  assert.equal(Game.speedForPower(1), CFG.MAX_SPEED);
});

test('powerToHit grows with distance, stays in range, and mirrors between sides', () => {
  const powers = CFG.POLES.map((x) => Game.powerToHit('left', x));
  assert.ok(powers.every((p) => p > 0 && p < 1));
  assert.ok(powers[0] < powers[1] && powers[1] < powers[2]);
  assert.ok(Math.abs(Game.powerToHit('right', CFG.POLES[2]) - powers[0]) < 1e-9);
});

test('createGame: left hosts, right joins, both start in the lobby', () => {
  const host = Game.createGame('left');
  const guest = Game.createGame('right');
  assert.equal(host.host, true);
  assert.equal(guest.host, false);
  assert.equal(host.phase, 'lobby');
  assert.deepEqual(host.scores, { left: 0, right: 0 });
  assert.deepEqual(
    host.poles.map((p) => p.points),
    [
      { left: 1, right: 3 },
      { left: 2, right: 2 },
      { left: 3, right: 1 },
    ],
  );
  assert.throws(() => Game.createGame('middle'), /unknown side "middle"/);
  assert.deepEqual(host.names, { left: 'YOU', right: 'FRIEND' });
  assert.deepEqual(guest.names, { left: 'FRIEND', right: 'YOU' });
  assert.equal(Game.them(host), 'right');
  assert.equal(Game.them(guest), 'left');
});

test('names are cleaned to what the pixel font draws, and setName insists on that', () => {
  assert.equal(Game.cleanName('al ice!'), 'ALICE');
  assert.equal(Game.cleanName('abcdefghijk'), 'ABCDEFGH');
  assert.equal(Game.cleanName(42), '42');
  assert.equal(Game.cleanName('éé'), '');
  const g = Game.createGame('right');
  Game.setName(g, 'BOB');
  assert.equal(g.names.right, 'BOB');
  for (const bad of ['', 'bob', 'TOOLONGNAME', 'A B', 7]) {
    assert.throws(() => Game.setName(g, bad), /invalid name/);
  }
});

test('on connect each side says hello; the host also starts the match', () => {
  const host = Game.createGame('left');
  Game.setName(host, 'ALICE');
  Game.connected(host);
  assert.deepEqual(host.outbox, [{ t: 'hello', name: 'ALICE' }, { t: 'start' }]);
  assert.equal(host.phase, 'countdown');

  const guest = Game.createGame('right');
  Game.setName(guest, 'BOB');
  Game.connected(guest);
  assert.deepEqual(guest.outbox, [{ t: 'hello', name: 'BOB' }]);
  assert.deepEqual(guest.lobby, ['CONNECTED', 'STARTING...']);

  Game.applyMessage(guest, host.outbox[0]);
  Game.applyMessage(host, guest.outbox[0]);
  assert.deepEqual(host.names, { left: 'ALICE', right: 'BOB' });
  assert.deepEqual(guest.names, { left: 'ALICE', right: 'BOB' });
});

test('lobby text only changes while in the lobby; lobby and ended ignore input', () => {
  const g = Game.createGame('left');
  Game.setLobby(g, ['WAITING']);
  assert.deepEqual(g.lobby, ['WAITING']);
  run(g, 1, true);
  assert.equal(g.phase, 'lobby');
  assert.equal(g.left.charging, false);

  Game.end(g, 'FRIEND LEFT');
  Game.setLobby(g, ['IGNORED']);
  assert.deepEqual(g.lobby, ['WAITING']);
  run(g, 1, true);
  assert.equal(g.phase, 'ended');
});

test('end keeps the first reason and stops any charging', () => {
  const g = playing();
  g.left.charging = true;
  g.right.charging = true;
  Game.end(g, 'FRIEND LEFT');
  Game.end(g, 'NETWORK ERROR');
  assert.equal(g.ending, 'FRIEND LEFT');
  assert.equal(g.left.charging, false);
  assert.equal(g.right.charging, false);
});

test('begin counts down, then play starts; a key held through GO does not charge', () => {
  const g = Game.createGame('left');
  Game.begin(g);
  assert.equal(g.phase, 'countdown');
  assert.deepEqual(g.outbox, [{ t: 'start' }]);
  run(g, CFG.COUNTDOWN - 0.1, true);
  assert.equal(g.phase, 'countdown');
  assert.equal(g.left.charging, false);
  run(g, 0.2, true);
  assert.equal(g.phase, 'playing');
  assert.equal(g.left.charging, false);
  Game.update(g, DT, false);
  Game.update(g, DT, true);
  assert.equal(g.left.charging, true);
});

test('holding charges a ping-pong meter and tells the peer', () => {
  const g = playing();
  Game.update(g, DT, true);
  assert.deepEqual(g.outbox, [{ t: 'charge' }]);
  assert.ok(Math.abs(g.left.power - DT / CFG.CHARGE_TIME) < 1e-9);
  run(g, CFG.CHARGE_TIME * 1.5, true);
  assert.equal(g.left.rising, false);
  assert.ok(g.left.power > 0.4 && g.left.power < 0.6);
  run(g, CFG.CHARGE_TIME * 0.8, true);
  assert.equal(g.left.rising, true);
  assert.ok(g.left.power >= 0 && g.left.power < 0.5);
});

test('releasing throws at the charged power, tells the peer, and starts a cooldown', () => {
  const g = playing();
  const d = throwAt(g, 0.5);
  const v = Game.speedForPower(0.5);
  assert.deepEqual(g.outbox, [{ t: 'throw', power: 0.5 }]);
  assert.equal(d.owner, 'left');
  assert.ok(Math.abs(d.vx - v * Math.cos(CFG.ANGLE)) < 1e-9);
  assert.ok(Math.abs(d.vy - (-v * Math.sin(CFG.ANGLE) + CFG.GRAVITY * DT)) < 1e-9);
  assert.equal(g.left.charging, false);
  assert.equal(g.left.cooldown, CFG.COOLDOWN);
  assert.equal(g.left.anim, CFG.THROW_ANIM);

  Game.update(g, DT, true);
  assert.equal(g.left.charging, false);
  run(g, CFG.COOLDOWN, true);
  assert.equal(g.left.charging, true);
  assert.equal(g.left.anim, 0);
});

test('a throw at the exact power rings each pole; the host scores it and reports', () => {
  CFG.POLES.forEach((x, i) => {
    const g = playing();
    const d = throwAt(g, Game.powerToHit('left', x));
    g.outbox.length = 0;
    runUntil(g, () => d.state !== 'flying');
    assert.equal(d.state, 'ringed');
    assert.equal(d.x, x);
    assert.equal(g.scores.left, i + 1);
    assert.deepEqual(g.outbox, [{ t: 'score', left: i + 1, right: 0 }]);
    assert.equal(g.poles[i].stack, 1);
    assert.equal(g.popups[0].text, `+${i + 1}`);
    run(g, 2);
    assert.equal(d.y, CFG.GROUND_Y - 4);
    assert.equal(g.popups.length, 0);
  });
});

test('where a disc lands does not depend on frame rate', () => {
  for (let p = 0.2; p < 0.9; p += 0.0025) {
    const outcomes = [1 / 30, 1 / 60, 1 / 144].map((dt) => {
      const g = playing();
      const d = throwAt(g, p);
      run(g, 4, false, dt);
      return d.state === 'ringed' ? `ringed@${d.x}` : d.state;
    });
    assert.equal(new Set(outcomes).size, 1, `power ${p}: ${outcomes}`);
  }
});

test('clipping the rim bounces the disc back up from the tip', () => {
  const g = playing();
  const pole = CFG.POLES[1];
  const d = addDisc(g, { x: pole - 8, y: CFG.POLE_TOP - 1, vx: 6, vy: 60 });
  Game.update(g, DT, false);
  assert.equal(d.state, 'flying');
  assert.ok(d.vx < 0);
  assert.ok(d.vy < 0);
  assert.equal(d.y, CFG.POLE_TOP - 1);
  assert.ok(Math.abs(pole - d.x) > CFG.CATCH && Math.abs(pole - d.x) <= CFG.RIM);
});

test('falling past the tip height away from any pole keeps flying', () => {
  const g = playing();
  const d = addDisc(g, { x: 60, y: CFG.POLE_TOP - 1, vy: 60 });
  Game.update(g, DT, false);
  assert.equal(d.state, 'flying');
  assert.ok(d.y > CFG.POLE_TOP);
});

test('pole shafts knock low discs back the way they came', () => {
  const g = playing();
  const fromLeft = addDisc(g, { x: CFG.POLES[0] - 12, y: 150, vx: 300 });
  const fromRight = addDisc(g, { x: CFG.POLES[2] + 12, y: 150, vx: -300 });
  Game.update(g, DT, false);
  assert.equal(fromLeft.x, CFG.POLES[0] - CFG.RIM);
  assert.ok(Math.abs(fromLeft.vx + 90) < 1e-9);
  assert.equal(fromRight.x, CFG.POLES[2] + CFG.RIM);
  assert.ok(Math.abs(fromRight.vx - 90) < 1e-9);
});

test('landed discs vanish after DEAD_TTL; off-screen discs are dropped', () => {
  const g = playing();
  const landed = addDisc(g, { x: 60, y: CFG.GROUND_Y - 2, vy: 100 });
  addDisc(g, { x: CFG.W + 15, y: 50, vx: 300 });
  addDisc(g, { x: -15, y: 50, vx: -300 });
  Game.update(g, DT, false);
  assert.equal(landed.state, 'dead');
  assert.equal(landed.y, CFG.GROUND_Y - 1);
  assert.deepEqual(g.discs, [landed]);
  run(g, CFG.DEAD_TTL - 0.1);
  assert.deepEqual(g.discs, [landed]);
  run(g, 0.2);
  assert.deepEqual(g.discs, []);
});

test('ring stacks rise up the pole but never past the tip', () => {
  const g = playing();
  g.poles[0].stack = 50;
  const d = addDisc(g, { x: CFG.POLES[0], y: CFG.POLE_TOP - 1, vy: 60 });
  Game.update(g, DT, false);
  assert.equal(d.state, 'ringed');
  assert.equal(d.restY, CFG.POLE_TOP + 2);
});

test('host: reaching WIN_SCORE ends the match and later rings do not score', () => {
  const g = playing();
  g.scores.left = 9;
  g.right.charging = true;
  addDisc(g, { x: CFG.POLES[2], y: CFG.POLE_TOP - 1, vy: 60 });
  Game.update(g, DT, false);
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'left');
  assert.equal(g.right.charging, false);
  assert.deepEqual(g.outbox, [{ t: 'over', winner: 'left', left: 12, right: 0 }]);

  g.outbox.length = 0;
  const late = addDisc(g, { owner: 'right', x: CFG.POLES[1], y: CFG.POLE_TOP - 1, vy: 60 });
  Game.update(g, DT, false);
  assert.equal(late.state, 'ringed');
  assert.equal(g.scores.right, 0);
  assert.deepEqual(g.outbox, []);
});

test('host: rematch needs both players; presses before the delay are ignored', () => {
  const g = playing();
  g.scores.left = 9;
  addDisc(g, { x: CFG.POLES[2], y: CFG.POLE_TOP - 1, vy: 60 });
  Game.update(g, DT, false);
  g.outbox.length = 0;

  Game.update(g, DT, true);
  assert.equal(g.rematch.left, false);
  Game.update(g, DT, false);
  run(g, CFG.RESTART_DELAY);
  Game.update(g, DT, true);
  assert.equal(g.rematch.left, true);
  assert.deepEqual(g.outbox, [{ t: 'ready' }]);
  Game.update(g, DT, false);
  Game.update(g, DT, true); // second press: already ready, nothing new
  assert.deepEqual(g.outbox, [{ t: 'ready' }]);
  assert.equal(g.phase, 'over');

  Game.applyMessage(g, { t: 'ready' });
  assert.equal(g.phase, 'countdown');
  assert.deepEqual(g.outbox, [{ t: 'ready' }, { t: 'start' }]);
  assert.deepEqual(g.scores, { left: 0, right: 0 });
  assert.deepEqual(g.rematch, { left: false, right: false });
});

test('a stray ready mid-match does not restart it', () => {
  const g = playing();
  Game.applyMessage(g, { t: 'ready' });
  assert.equal(g.phase, 'playing');
});

test('guest: rings pop up but only the host decides the score and the winner', () => {
  const g = playing('right');
  const d = throwAt(g, Game.powerToHit('right', CFG.POLES[0]));
  runUntil(g, () => d.state !== 'flying');
  assert.equal(d.state, 'ringed');
  assert.equal(g.popups[0].text, '+3');
  assert.deepEqual(g.scores, { left: 0, right: 0 });

  Game.applyMessage(g, { t: 'score', left: 2, right: 3 });
  assert.deepEqual(g.scores, { left: 2, right: 3 });
  Game.applyMessage(g, { t: 'over', winner: 'right', left: 2, right: 10 });
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 'right');
  assert.deepEqual(g.scores, { left: 2, right: 10 });

  // Guest asks for a rematch but cannot start one itself.
  run(g, CFG.RESTART_DELAY);
  Game.update(g, DT, true);
  assert.deepEqual(g.outbox.pop(), { t: 'ready' });
  Game.applyMessage(g, { t: 'ready' });
  assert.equal(g.phase, 'over');
  Game.applyMessage(g, { t: 'start' });
  assert.equal(g.phase, 'countdown');
  assert.deepEqual(g.scores, { left: 0, right: 0 });
});

test("the peer's charge animates locally and their throw carries the real power", () => {
  const g = playing();
  Game.applyMessage(g, { t: 'charge' });
  assert.equal(g.right.charging, true);
  run(g, 0.5);
  assert.ok(g.right.power > 0.3);
  Game.applyMessage(g, { t: 'throw', power: 0.25 });
  assert.equal(g.right.charging, false);
  const d = g.discs[0];
  assert.equal(d.owner, 'right');
  assert.ok(Math.abs(d.vx + Game.speedForPower(0.25) * Math.cos(CFG.ANGLE)) < 1e-9);
});

test('malformed or misdirected messages end the match loudly', () => {
  const host = [null, 'hi', {}, { t: 'nope' }, { t: 'hello' }, { t: 'hello', name: 'bob' },
    { t: 'hello', name: 'WAYTOOLONG' }, { t: 'throw', power: 2 }, { t: 'throw', power: -0.1 },
    { t: 'throw', power: '0.5' }, { t: 'start' }, { t: 'full' }, { t: 'score', left: 1, right: 1 },
    { t: 'over', winner: 'left', left: 10, right: 0 }];
  const guest = [{ t: 'score', left: -1, right: 0 }, { t: 'score', left: 1, right: 1.5 },
    { t: 'over', winner: 'middle', left: 10, right: 0 }];
  for (const [side, msgs] of [['left', host], ['right', guest]]) {
    for (const msg of msgs) {
      const g = playing(side);
      Game.applyMessage(g, msg);
      assert.equal(g.phase, 'ended', JSON.stringify(msg));
      assert.equal(g.ending, 'BAD MESSAGE FROM FRIEND');
    }
  }
});

test('guest told the room is full ends with that reason', () => {
  const g = Game.createGame('right');
  Game.applyMessage(g, { t: 'full' });
  assert.equal(g.phase, 'ended');
  assert.equal(g.ending, 'GAME IS FULL');
});

test('a full match over the wire: both screens agree, then a rematch starts', () => {
  const p = pair();
  Game.begin(p.host);
  step(p);
  assert.equal(p.guest.phase, 'countdown');
  stepFor(p, CFG.COUNTDOWN + DT);
  assert.equal(p.host.phase, 'playing');
  assert.equal(p.guest.phase, 'playing');

  // Guest charges: the host sees the meter move.
  step(p);
  step(p, false, true);
  step(p, false, true);
  assert.equal(p.host.right.charging, true);

  // Guest rings its 3-point pole until it wins.
  const power = Game.powerToHit('right', CFG.POLES[0]);
  while (p.host.phase === 'playing') {
    p.guest.right.charging = true;
    p.guest.right.power = power;
    step(p, false, false);
    stepFor(p, 1.5, false, false);
  }
  step(p);
  assert.equal(p.host.winner, 'right');
  assert.equal(p.guest.phase, 'over');
  assert.equal(p.guest.winner, 'right');
  assert.deepEqual(p.guest.scores, p.host.scores);
  assert.equal(p.host.scores.right, 12);
  assert.equal(
    p.guest.discs.filter((d) => d.state === 'ringed').length,
    p.host.discs.filter((d) => d.state === 'ringed').length,
  );

  stepFor(p, CFG.RESTART_DELAY);
  step(p, true, false);
  step(p, true, true);
  step(p);
  assert.equal(p.host.phase, 'countdown');
  assert.equal(p.guest.phase, 'countdown');
});
