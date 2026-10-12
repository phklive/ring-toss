// Pixel renderer: everything is a fillRect on the low-res canvas, which CSS
// scales up with nearest-neighbour filtering.
const Render = (() => {
  const PAL = {
    sky: '#6dc2ff',
    skyLow: '#a8dcff',
    sun: '#ffe066',
    cloud: '#ffffff',
    hills: '#7fcf7f',
    grass: '#4caf50',
    dirt: '#8b5a2b',
    speck: '#6b4220',
    pole: '#e0b07a',
    poleDark: '#a0703c',
    skin: '#f5c9a0',
    hair: '#4a2c17',
    pants: '#374151',
    ink: '#1f2937',
    left: '#3b82f6',
    leftDark: '#1e40af',
    leftLight: '#93c5fd',
    right: '#ef4444',
    rightDark: '#991b1b',
    rightLight: '#fca5a5',
    text: '#ffffff',
    title: '#facc15',
    bar: '#111827',
    barFill: '#facc15',
    overlay: 'rgba(0, 0, 0, 0.6)',
  };

  // 3x5 glyphs, rows separated by spaces.
  const FONT = {
    A: '.#. #.# ### #.# #.#',
    B: '##. #.# ##. #.# ##.',
    C: '.## #.. #.. #.. .##',
    D: '##. #.# #.# #.# ##.',
    E: '### #.. ##. #.. ###',
    F: '### #.. ##. #.. #..',
    G: '.## #.. #.# #.# .##',
    H: '#.# #.# ### #.# #.#',
    I: '### .#. .#. .#. ###',
    J: '..# ..# ..# #.# .#.',
    K: '#.# #.# ##. #.# #.#',
    L: '#.. #.. #.. #.. ###',
    M: '#.# ### ### #.# #.#',
    N: '##. #.# #.# #.# #.#',
    O: '### #.# #.# #.# ###',
    P: '##. #.# ##. #.. #..',
    Q: '.#. #.# #.# ##. .##',
    R: '##. #.# ##. #.# #.#',
    S: '.## #.. .#. ..# ##.',
    T: '### .#. .#. .#. .#.',
    U: '#.# #.# #.# #.# ###',
    V: '#.# #.# #.# #.# .#.',
    W: '#.# #.# ### ### #.#',
    X: '#.# #.# .#. #.# #.#',
    Y: '#.# #.# .#. .#. .#.',
    Z: '### ..# .#. #.. ###',
    0: '### #.# #.# #.# ###',
    1: '.#. ##. .#. .#. ###',
    2: '##. ..# .#. #.. ###',
    3: '##. ..# .#. ..# ##.',
    4: '#.# #.# ### ..# ..#',
    5: '### #.. ##. ..# ##.',
    6: '.## #.. ### #.# ###',
    7: '### ..# .#. .#. .#.',
    8: '### #.# ### #.# ###',
    9: '### #.# ### ..# ##.',
    '+': '... .#. ### .#. ...',
    '-': '... ... ### ... ...',
    '!': '.#. .#. .#. ... .#.',
    '.': '... ... ... ... .#.',
  };

  // 8x18 thrower facing right. h hair, s skin, k ink, c shirt (team colour), p pants.
  const SPRITE = [
    '..hhhh..',
    '.hhhhhh.',
    '.hhssss.',
    '.hsssks.',
    '..sssss.',
    '...ss...',
    '..cccc..',
    '.ccccc..',
    '.ccccc..',
    '..cccc..',
    '..cccc..',
    '..pppp..',
    '..p..p..',
    '..p..p..',
    '..p..p..',
    '..p..p..',
    '..p..p..',
    '.kk.kk..',
  ];

  const CLOUDS = [
    { x: 30, y: 30, speed: 4 },
    { x: 140, y: 18, speed: 6 },
    { x: 230, y: 44, speed: 3 },
  ];

  // Fixed scatter of pebbles in the dirt (sine hash, so it's the same every frame).
  const hash = (n) => {
    const s = Math.sin(n) * 43758.5453;
    return s - Math.floor(s);
  };
  const SPECKS = Array.from({ length: 60 }, (_, i) => [Math.floor(hash(i + 1) * 320), Math.floor(hash(i + 101) * 14)]);

  const textWidth = (text, scale = 1) => (text.length * 4 - 1) * scale;

  function drawText(ctx, text, x, y, color, scale = 1) {
    ctx.fillStyle = color;
    [...text].forEach((ch, i) => {
      if (ch === ' ') return;
      const glyph = FONT[ch];
      if (!glyph) throw new Error(`Render: no glyph for "${ch}"`);
      glyph.split(' ').forEach((row, gy) => {
        [...row].forEach((px, gx) => {
          if (px === '#') ctx.fillRect(x + (i * 4 + gx) * scale, y + gy * scale, scale, scale);
        });
      });
    });
  }

  // Text with a drop shadow so it reads on any background.
  function label(ctx, text, x, y, color, scale = 1) {
    drawText(ctx, text, x + 1, y + 1, PAL.ink, scale);
    drawText(ctx, text, x, y, color, scale);
  }

  function centered(ctx, game, text, y, color, scale = 1) {
    label(ctx, text, Math.round((game.cfg.W - textWidth(text, scale)) / 2), y, color, scale);
  }

  function rect(ctx, color, x, y, w, h) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }

  function line(ctx, color, x0, y0, x1, y1) {
    ctx.fillStyle = color;
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      ctx.fillRect(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 1, 1);
    }
  }

  function drawBackground(ctx, game) {
    const { W, H, GROUND_Y } = game.cfg;
    rect(ctx, PAL.sky, 0, 0, W, GROUND_Y);
    rect(ctx, PAL.skyLow, 0, GROUND_Y - 50, W, 50);
    for (let dy = -9; dy <= 9; dy++) {
      const w = Math.round(Math.sqrt(81 - dy * dy));
      rect(ctx, PAL.sun, 250 - w, 26 + dy, w * 2, 1);
    }
    for (const c of CLOUDS) {
      const x = Math.round(((c.x + game.time * c.speed) % (W + 40)) - 20);
      rect(ctx, PAL.cloud, x, c.y, 18, 4);
      rect(ctx, PAL.cloud, x + 4, c.y - 3, 9, 3);
    }
    ctx.fillStyle = PAL.hills;
    for (let x = 0; x < W; x++) {
      const h = Math.round(14 + 6 * Math.sin(x / 23) + 3 * Math.sin(x / 7));
      ctx.fillRect(x, GROUND_Y - h, 1, h);
    }
    rect(ctx, PAL.grass, 0, GROUND_Y, W, 3);
    rect(ctx, PAL.dirt, 0, GROUND_Y + 3, W, H - GROUND_Y - 3);
    ctx.fillStyle = PAL.speck;
    for (const [x, y] of SPECKS) ctx.fillRect(x, GROUND_Y + 5 + y, 1, 1);
  }

  // A disc seen edge-on: back edge (dark) one row above the front edge (bright).
  function discBack(ctx, game, d) {
    rect(ctx, PAL[`${d.owner}Dark`], Math.round(d.x) - game.cfg.DISC_HALF, Math.round(d.y) - 1, game.cfg.DISC_HALF * 2, 1);
  }
  function discFront(ctx, game, d) {
    rect(ctx, PAL[d.owner], Math.round(d.x) - game.cfg.DISC_HALF, Math.round(d.y), game.cfg.DISC_HALF * 2, 1);
  }
  function disc(ctx, game, d) {
    discBack(ctx, game, d);
    discFront(ctx, game, d);
  }

  function drawPoles(ctx, game) {
    const { POLE_TOP, GROUND_Y } = game.cfg;
    for (const pole of game.poles) {
      rect(ctx, PAL.pole, pole.x - 1, POLE_TOP, 1, GROUND_Y - POLE_TOP);
      rect(ctx, PAL.poleDark, pole.x, POLE_TOP, 1, GROUND_Y - POLE_TOP);
      rect(ctx, PAL.poleDark, pole.x - 3, GROUND_Y - 3, 6, 3);
      // Points for each side, written in the dirt under the pole.
      drawText(ctx, String(pole.points.left), pole.x - 5, GROUND_Y + 7, PAL.leftLight);
      drawText(ctx, String(pole.points.right), pole.x + 2, GROUND_Y + 7, PAL.rightLight);
    }
  }

  function drawThrower(ctx, game, owner) {
    const c = game.cfg.THROWERS[owner];
    const t = game[owner];
    const top = game.cfg.GROUND_Y - SPRITE.length;
    const left = c.x - 4;
    const colX = (col) => (c.dir > 0 ? left + col : left + 7 - col);
    const colors = { h: PAL.hair, s: PAL.skin, k: PAL.ink, p: PAL.pants, c: PAL[owner] };

    const sx = colX(5);
    const sy = top + 6;
    let hx = sx + c.dir;
    let hy = sy + 6;
    if (t.anim > 0) {
      hx = c.handX;
      hy = c.handY;
    } else if (t.charging) {
      hx = sx - c.dir * 4;
      hy = sy + 3;
    }
    if (t.charging) disc(ctx, game, { owner, x: hx, y: hy });

    SPRITE.forEach((row, y) => {
      [...row].forEach((ch, col) => {
        if (ch !== '.') rect(ctx, colors[ch], colX(col), top + y, 1, 1);
      });
    });
    line(ctx, PAL.skin, sx, sy, hx, hy);

    if (t.charging) {
      rect(ctx, PAL.bar, c.x - 7, top - 7, 14, 4);
      rect(ctx, PAL.barFill, c.x - 6, top - 6, Math.round(12 * t.power), 2);
    }
  }

  const them = (game) => (game.me === 'left' ? 'right' : 'left');

  function drawHud(ctx, game) {
    const { W, WIN_SCORE } = game.cfg;
    label(ctx, `${game.names.left} ${game.scores.left}`, 4, 4, PAL.leftLight, 2);
    const right = `${game.names.right} ${game.scores.right}`;
    label(ctx, right, W - 4 - textWidth(right, 2), 4, PAL.rightLight, 2);
    centered(ctx, game, `FIRST TO ${WIN_SCORE}`, 7, PAL.text);
  }

  const blinkOn = (game) => Math.floor(game.time * 2) % 2 === 0;

  function drawOverlay(ctx, game) {
    const { W, H, RESTART_DELAY, WIN_SCORE } = game.cfg;
    const mine = PAL[`${game.me}Light`];
    const theirName = game.names[them(game)];
    if (game.phase === 'lobby') {
      rect(ctx, PAL.overlay, 0, 0, W, H);
      centered(ctx, game, 'RING TOSS', 22, PAL.title, 3);
      centered(ctx, game, 'HOLD SPACE OR CLICK TO CHARGE', 54, PAL.text);
      centered(ctx, game, 'RELEASE TO THROW YOUR RING', 64, PAL.text);
      centered(ctx, game, 'FAR POLES SCORE MORE', 74, PAL.text);
      centered(ctx, game, `FIRST TO ${WIN_SCORE} WINS`, 84, PAL.text);
      game.lobby.forEach((line, i) => centered(ctx, game, line, 104 + i * 10, PAL.title));
    } else if (game.phase === 'countdown') {
      centered(ctx, game, String(Math.ceil(game.countdown)), 50, PAL.text, 5);
      centered(ctx, game, game.me === 'left' ? 'YOU ARE BLUE' : 'YOU ARE RED', 86, mine, 2);
      centered(ctx, game, `VS ${theirName}`, 106, PAL[`${them(game)}Light`], 2);
    } else if (game.phase === 'over') {
      rect(ctx, PAL.overlay, 0, 0, W, H);
      const won = game.winner === game.me;
      centered(ctx, game, won ? 'YOU WIN!' : `${theirName} WINS!`, 40, PAL[`${game.winner}Light`], 3);
      const { names, scores } = game;
      centered(ctx, game, `${names.left} ${scores.left}  ${names.right} ${scores.right}`, 74, PAL.text, 2);
      if (game.rematch[game.me]) {
        centered(ctx, game, `WAITING FOR ${theirName}...`, 104, PAL.text);
      } else {
        if (game.overTimer >= RESTART_DELAY && blinkOn(game)) {
          centered(ctx, game, 'PRESS SPACE FOR REMATCH', 104, PAL.text);
        }
        if (game.rematch[them(game)]) centered(ctx, game, `${theirName} WANTS A REMATCH!`, 118, PAL.title);
      }
    } else if (game.phase === 'ended') {
      rect(ctx, PAL.overlay, 0, 0, W, H);
      centered(ctx, game, game.ending, 60, PAL.title, 2);
      if (blinkOn(game)) centered(ctx, game, 'PRESS SPACE FOR A NEW GAME', 100, PAL.text);
    }
  }

  function draw(ctx, game) {
    drawBackground(ctx, game);
    // Rings on a pole straddle it: back edge behind the pole, front edge in front.
    const ringed = game.discs.filter((d) => d.state === 'ringed');
    ringed.forEach((d) => discBack(ctx, game, d));
    drawPoles(ctx, game);
    ringed.forEach((d) => discFront(ctx, game, d));
    drawThrower(ctx, game, 'left');
    drawThrower(ctx, game, 'right');
    for (const d of game.discs) {
      if (d.state === 'flying') disc(ctx, game, d);
      // Dead discs blink out during their last half second.
      else if (d.state === 'dead' && (d.ttl > 0.5 || Math.floor(d.ttl * 10) % 2 === 1)) disc(ctx, game, d);
    }
    for (const p of game.popups) {
      label(ctx, p.text, Math.round(p.x - textWidth(p.text) / 2), Math.round(p.y), PAL[`${p.owner}Light`]);
    }
    drawHud(ctx, game);
    drawOverlay(ctx, game);
  }

  return { draw, drawText, textWidth, FONT, PAL };
})();

if (typeof module !== 'undefined') module.exports = Render;
