const test = require('node:test');
const assert = require('node:assert/strict');
const Game = require('../src/game.js');
const Render = require('../src/render.js');

const { CFG } = Game;

// Canvas stand-in that records every fillRect with the colour in effect.
function fakeCtx() {
  const rects = [];
  return {
    rects,
    fillStyle: '',
    fillRect(x, y, w, h) {
      rects.push({ color: this.fillStyle, x, y, w, h });
    },
  };
}

const has = (ctx, pred) => ctx.rects.some(pred);

test('textWidth counts 4px per glyph minus the trailing gap, times scale', () => {
  assert.equal(Render.textWidth('AB'), 7);
  assert.equal(Render.textWidth('AB', 2), 14);
});

test('drawText paints one rect per lit glyph pixel and skips spaces', () => {
  const ctx = fakeCtx();
  Render.drawText(ctx, 'A A', 10, 20, '#abcdef');
  assert.equal(ctx.rects.length, 20);
  assert.ok(ctx.rects.every((r) => r.color === '#abcdef' && r.w === 1));
  assert.deepEqual(ctx.rects[0], { color: '#abcdef', x: 11, y: 20, w: 1, h: 1 });
  assert.equal(ctx.rects[10].x, 19);

  const big = fakeCtx();
  Render.drawText(big, '1', 0, 0, '#fff', 3);
  assert.ok(big.rects.every((r) => r.w === 3 && r.h === 3));
});

test('every glyph in the font is 3x5', () => {
  for (const [ch, glyph] of Object.entries(Render.FONT)) {
    const rows = glyph.split(' ');
    assert.equal(rows.length, 5, ch);
    assert.ok(rows.every((r) => r.length === 3 && /^[#.]+$/.test(r)), ch);
  }
});

test('drawText fails loudly on a character the font lacks', () => {
  assert.throws(() => Render.drawText(fakeCtx(), 'a', 0, 0, '#fff'), /no glyph for "a"/);
});

const draw = (game) => {
  const ctx = fakeCtx();
  Render.draw(ctx, game);
  return ctx;
};
// Text at a given scale shows up as rects of that size in that colour.
const textAt = (ctx, color, scale, y) => has(ctx, (r) => r.color === color && r.w === scale && (y === undefined || r.y === y));

test('lobby shows the title, how to play, and the connection status', () => {
  const g = Game.createGame('left');
  Game.setLobby(g, ['WAITING FOR FRIEND', 'SEND THEM THE LINK BELOW']);
  const c = draw(g);
  assert.ok(has(c, (r) => r.color === Render.PAL.overlay));
  assert.ok(textAt(c, Render.PAL.title, 3));
  assert.ok(textAt(c, Render.PAL.title, 1, 104));
  assert.ok(textAt(c, Render.PAL.title, 1, 114));
});

test('countdown shows the number and which colour you play', () => {
  const host = Game.createGame('left');
  Game.begin(host);
  const h = draw(host);
  assert.ok(!has(h, (r) => r.color === Render.PAL.overlay));
  assert.ok(textAt(h, Render.PAL.text, 5));
  assert.ok(textAt(h, Render.PAL.leftLight, 2, 86));

  assert.ok(textAt(h, Render.PAL.rightLight, 2, 106)); // VS <their name>

  const guest = Game.createGame('right');
  Game.applyMessage(guest, { t: 'start' });
  const c = draw(guest);
  assert.ok(textAt(c, Render.PAL.rightLight, 2, 86));
  assert.ok(textAt(c, Render.PAL.leftLight, 2, 106));
});

test('the scoreboard shows both names, as wide as names get', () => {
  const g = Game.createGame('left');
  Game.setName(g, 'WWWWWWWW');
  Game.applyMessage(g, { t: 'hello', name: 'MMMMMMMM' });
  g.phase = 'playing';
  g.scores = { left: 10, right: 10 };
  const c = draw(g);
  const hud = c.rects.filter((r) => r.w === 2 && r.y < 20 && r.color !== Render.PAL.ink);
  const left = hud.filter((r) => r.color === Render.PAL.leftLight);
  const right = hud.filter((r) => r.color === Render.PAL.rightLight);
  // Left name ends before the centre title, right name starts after it, both on screen.
  assert.ok(Math.max(...left.map((r) => r.x)) < 140);
  assert.ok(Math.min(...right.map((r) => r.x)) > 180);
  assert.ok(Math.max(...right.map((r) => r.x)) < CFG.W);
});

test('playing frame draws throwers, power bars, discs in every state, and popups', () => {
  const g = Game.createGame('left');
  g.phase = 'playing';
  g.left.charging = true;
  g.left.power = 0.5;
  g.right.anim = 0.1;
  g.discs.push(
    { owner: 'left', state: 'flying', x: 100.4, y: 80.6 },
    { owner: 'right', state: 'ringed', x: 160, y: 150 },
    { owner: 'right', state: 'dead', x: 60, y: 159, ttl: 1 },
    { owner: 'left', state: 'dead', x: 250, y: 159, ttl: 0.45 }, // blink: hidden
    { owner: 'left', state: 'dead', x: 270, y: 159, ttl: 0.35 }, // blink: shown
  );
  g.popups.push({ x: 112, y: 120.3, text: '+1', owner: 'left', ttl: 0.5 });
  const c = draw(g);

  assert.ok(!has(c, (r) => r.color === Render.PAL.overlay));
  // Power bar: half of 12px.
  assert.ok(has(c, (r) => r.color === Render.PAL.barFill && r.w === 6));
  // Flying disc, rounded to pixels, 16px wide.
  assert.ok(has(c, (r) => r.color === Render.PAL.left && r.x === 92 && r.y === 81 && r.w === 16));
  // Ringed disc's back edge drawn before the pole, front edge after.
  const back = c.rects.findIndex((r) => r.color === Render.PAL.rightDark && r.x === 152 && r.y === 149);
  const pole = c.rects.findIndex((r) => r.color === Render.PAL.pole && r.x === 159);
  const front = c.rects.findIndex((r) => r.color === Render.PAL.right && r.x === 152 && r.y === 150);
  assert.ok(back >= 0 && back < pole && pole < front);
  // Dead discs: steady, blinked off, blinked on.
  assert.ok(has(c, (r) => r.color === Render.PAL.right && r.x === 52 && r.y === 159));
  assert.ok(!has(c, (r) => r.color === Render.PAL.left && r.x === 242 && r.y === 159));
  assert.ok(has(c, (r) => r.color === Render.PAL.left && r.x === 262 && r.y === 159));
  // Popup text.
  assert.ok(textAt(c, Render.PAL.leftLight, 1, 120));
});

test('game over: winner in their colour, rematch prompt blinks after the delay', () => {
  const g = Game.createGame('right');
  g.phase = 'over';
  g.winner = 'left';
  g.scores = { left: 10, right: 4 };

  const early = draw(g);
  assert.ok(textAt(early, Render.PAL.leftLight, 3));

  g.overTimer = CFG.RESTART_DELAY;
  const prompt = draw(g);
  assert.ok(textAt(prompt, Render.PAL.text, 1, 104));

  g.time = 0.5;
  assert.ok(!textAt(draw(g), Render.PAL.text, 1, 104));

  g.rematch.left = true;
  assert.ok(textAt(draw(g), Render.PAL.title, 1, 118));

  g.rematch.right = true;
  const waiting = draw(g);
  assert.ok(textAt(waiting, Render.PAL.text, 1, 104));
  assert.ok(!textAt(waiting, Render.PAL.title, 1, 118));

  g.me = 'left';
  assert.ok(textAt(draw(g), Render.PAL.leftLight, 3));
});

test('ended screen shows the reason and a blinking new-game prompt', () => {
  const g = Game.createGame('left');
  Game.end(g, 'FRIEND LEFT');
  const on = draw(g);
  assert.ok(textAt(on, Render.PAL.title, 2, 60));
  assert.ok(textAt(on, Render.PAL.text, 1, 100));
  g.time = 0.5;
  assert.ok(!textAt(draw(g), Render.PAL.text, 1, 100));
});

test('every message the game can show is drawable', () => {
  const ctx = fakeCtx();
  for (const text of ['GAME IS FULL', 'BAD MESSAGE FROM FRIEND', 'GAME NOT FOUND', 'BROWSER NOT SUPPORTED',
    'NETWORK ERROR', 'COULD NOT CONNECT', 'BAD GAME LINK', 'CREATING GAME...', 'JOINING GAME WXYZ...',
    'CONNECTED', 'STARTING...', 'ENTER YOUR NAME BELOW', 'ABCDEFGH LEFT', 'MMMMMMMM WANTS A REMATCH!']) {
    Render.drawText(ctx, text, 0, 0, '#fff');
  }
});
