// Pure game state and rules (no DOM, no network). Loaded as a global in the
// browser and as a CommonJS module by the tests.
//
// Two browsers play one match. Each runs this simulation and controls one
// side: the host is 'left', the friend who joined is 'right'. A disc's fate
// depends only on its throw power, so the peers just swap throw events and
// both screens agree on where every disc lands. The host alone keeps score
// and decides the winner; it tells the guest via messages.
const Game = (() => {
  const CFG = Object.freeze({
    W: 320,
    H: 180,
    GROUND_Y: 160,
    GRAVITY: 300,
    ANGLE: Math.PI / 4,
    MIN_SPEED: 140,
    MAX_SPEED: 265,
    CHARGE_TIME: 1.4, // seconds for the power meter to sweep 0 -> 1
    COOLDOWN: 0.4,
    MAX_DT: 1 / 30,
    WIN_SCORE: 10,
    COUNTDOWN: 3,
    POLES: [112, 160, 208],
    POLE_TOP: 128,
    DISC_HALF: 8,
    CATCH: 6, // max |disc.x - pole.x| at the pole tip that rings it
    RIM: 9, // past CATCH and up to here the disc clips the tip and bounces
    STACK_STEP: 2,
    SLIDE_SPEED: 120,
    DEAD_TTL: 1.5,
    POPUP_TTL: 0.8,
    POPUP_RISE: 12,
    RESTART_DELAY: 0.6,
    THROW_ANIM: 0.2,
    THROWERS: {
      left: { x: 24, handX: 30, handY: 144, dir: 1 },
      right: { x: 296, handX: 290, handY: 144, dir: -1 },
    },
  });

  // Bump whenever the messages peers exchange change. Browsers can keep a stale
  // copy of the page for a while, so two friends may run different versions.
  const PROTOCOL = 2;

  const SIDES = ['left', 'right'];
  const other = (side) => (side === 'left' ? 'right' : 'left');
  const them = (game) => other(game.me);

  // Names use only what the pixel font can draw.
  const NAME_MAX = 8;
  const isName = (s) => typeof s === 'string' && new RegExp(`^[A-Z0-9]{1,${NAME_MAX}}$`).test(s);
  const cleanName = (raw) => String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, NAME_MAX);

  // Nearest pole is worth 1, farthest is worth POLES.length.
  function pointsFor(side, poleIndex) {
    return side === 'left' ? poleIndex + 1 : CFG.POLES.length - poleIndex;
  }

  function speedForPower(power) {
    return CFG.MIN_SPEED + power * (CFG.MAX_SPEED - CFG.MIN_SPEED);
  }

  // Power (0..1) whose arc passes exactly through the tip of the pole at targetX.
  function powerToHit(side, targetX) {
    const t = CFG.THROWERS[side];
    const d = Math.abs(targetX - t.handX);
    const h = t.handY - CFG.POLE_TOP;
    const cos = Math.cos(CFG.ANGLE);
    const v = Math.sqrt((CFG.GRAVITY * d * d) / (2 * cos * cos * (d * Math.tan(CFG.ANGLE) - h)));
    return (v - CFG.MIN_SPEED) / (CFG.MAX_SPEED - CFG.MIN_SPEED);
  }

  const newThrower = () => ({ charging: false, power: 0, rising: true, ready: false, cooldown: 0, anim: 0 });

  function resetMatch(game) {
    game.scores = { left: 0, right: 0 };
    game.discs = [];
    game.popups = [];
    game.poles = CFG.POLES.map((x, i) => ({
      x,
      stack: 0,
      points: { left: pointsFor('left', i), right: pointsFor('right', i) },
    }));
    game.left = newThrower();
    game.right = newThrower();
    game.winner = null;
    game.overTimer = 0;
    game.countdown = CFG.COUNTDOWN;
    game.rematch = { left: false, right: false };
  }

  // `me` is the side this browser controls; the left side (the host) keeps score.
  function createGame(me) {
    if (!SIDES.includes(me)) throw new Error(`createGame: unknown side "${me}"`);
    const game = {
      cfg: CFG,
      me,
      host: me === 'left',
      phase: 'lobby',
      lobby: [],
      ending: '',
      hint: '',
      peerKnown: false, // set by the peer's hello
      // Placeholders until the players' names are known.
      names: { [me]: 'YOU', [other(me)]: 'FRIEND' },
      time: 0,
      prevDown: false,
      outbox: [], // messages for the peer, drained by the caller
    };
    resetMatch(game);
    return game;
  }

  // Lines shown while waiting to connect. Ignored once a match has started.
  function setLobby(game, lines) {
    if (game.phase === 'lobby') game.lobby = lines;
  }

  function setName(game, name) {
    if (!isName(name)) throw new Error(`setName: invalid name "${name}"`);
    game.names[game.me] = name;
  }

  function startCountdown(game) {
    resetMatch(game);
    game.phase = 'countdown';
  }

  // Host only: the friend is connected, start a match.
  function begin(game) {
    startCountdown(game);
    game.outbox.push({ t: 'start' });
  }

  // The link to the friend is up: introduce ourselves; the host starts the match.
  function connected(game) {
    game.outbox.push({ t: 'hello', v: PROTOCOL, name: game.names[game.me] });
    if (game.host) begin(game);
    else setLobby(game, ['CONNECTED', 'STARTING...']);
  }

  // Connection gone or broken. The first reason wins.
  function end(game, reason, hint = '') {
    if (game.phase === 'ended') return;
    game.phase = 'ended';
    game.ending = reason;
    game.hint = hint;
    game.left.charging = false;
    game.right.charging = false;
  }

  function finish(game, winner) {
    game.phase = 'over';
    game.winner = winner;
    game.overTimer = 0;
    game.left.charging = false;
    game.right.charging = false;
  }

  function maybeRestart(game) {
    if (game.host && game.phase === 'over' && game.rematch.left && game.rematch.right) begin(game);
  }

  // Ping-pong the power meter between 0 and 1.
  function sweep(t, dt) {
    const step = dt / CFG.CHARGE_TIME;
    t.power += t.rising ? step : -step;
    if (t.power > 1) {
      t.power = 2 - t.power;
      t.rising = false;
    } else if (t.power < 0) {
      t.power = -t.power;
      t.rising = true;
    }
  }

  function startCharging(t) {
    t.charging = true;
    t.power = 0;
    t.rising = true;
  }

  function throwDisc(game, side) {
    const t = game[side];
    const c = CFG.THROWERS[side];
    const v = speedForPower(t.power);
    game.discs.push({
      owner: side,
      state: 'flying',
      x: c.handX,
      y: c.handY,
      vx: c.dir * v * Math.cos(CFG.ANGLE),
      vy: -v * Math.sin(CFG.ANGLE),
      restY: 0,
      ttl: 0,
    });
    t.charging = false;
    t.cooldown = CFG.COOLDOWN;
    t.anim = CFG.THROW_ANIM;
  }

  // Charging starts on a fresh hold once the cooldown is over; releasing throws.
  function updateMine(game, dt, down) {
    const p = game[game.me];
    if (!down) p.ready = true;
    if (!p.charging && down && p.ready && p.cooldown === 0) {
      startCharging(p);
      p.ready = false;
      game.outbox.push({ t: 'charge' });
    }
    if (!p.charging) return;
    if (down) {
      sweep(p, dt);
    } else {
      game.outbox.push({ t: 'throw', power: p.power });
      throwDisc(game, game.me);
    }
  }

  function ring(game, d, i) {
    const pole = game.poles[i];
    d.state = 'ringed';
    d.x = pole.x;
    d.y = CFG.POLE_TOP;
    d.restY = Math.max(CFG.POLE_TOP + 2, CFG.GROUND_Y - 4 - pole.stack * CFG.STACK_STEP);
    pole.stack += 1;
    if (game.phase !== 'playing') return; // rings still land, but only count mid-match
    const pts = pole.points[d.owner];
    game.popups.push({ x: pole.x, y: CFG.POLE_TOP - 8, text: `+${pts}`, owner: d.owner, ttl: CFG.POPUP_TTL });
    if (!game.host) return; // the host's 'score' message is the guest's truth
    game.scores[d.owner] += pts;
    const { left, right } = game.scores;
    if (game.scores[d.owner] >= CFG.WIN_SCORE) {
      finish(game, d.owner);
      game.outbox.push({ t: 'over', winner: d.owner, left, right });
    } else {
      game.outbox.push({ t: 'score', left, right });
    }
  }

  function fly(game, d, dt) {
    const px = d.x;
    const py = d.y;
    const vy0 = d.vy;
    d.x += d.vx * dt;
    d.y += vy0 * dt + 0.5 * CFG.GRAVITY * dt * dt;
    d.vy += CFG.GRAVITY * dt;

    // Falling through the height of the pole tips: ring, clip the rim, or miss.
    // Solve for the exact crossing so both peers agree whatever their frame rate.
    if (py < CFG.POLE_TOP && d.y >= CFG.POLE_TOP) {
      const tau = (-vy0 + Math.sqrt(vy0 * vy0 + 2 * CFG.GRAVITY * (CFG.POLE_TOP - py))) / CFG.GRAVITY;
      const cx = px + d.vx * tau;
      for (const [i, pole] of game.poles.entries()) {
        const off = Math.abs(cx - pole.x);
        if (off <= CFG.CATCH) {
          ring(game, d, i);
          return;
        }
        if (off <= CFG.RIM) {
          d.x = cx;
          d.y = CFG.POLE_TOP - 1;
          d.vx = -d.vx * 0.4;
          d.vy = -(vy0 + CFG.GRAVITY * tau) * 0.3;
          return;
        }
      }
    }

    // Below the tips the disc bounces off pole shafts, back the way it came.
    if (d.y > CFG.POLE_TOP) {
      for (const pole of game.poles) {
        if (Math.abs(d.x - pole.x) < CFG.RIM) {
          const side = px < pole.x ? -1 : 1;
          d.x = pole.x + side * CFG.RIM;
          d.vx = side * Math.abs(d.vx) * 0.3;
        }
      }
    }

    if (d.y >= CFG.GROUND_Y - 1) {
      d.y = CFG.GROUND_Y - 1;
      d.state = 'dead';
      d.ttl = CFG.DEAD_TTL;
    } else if (d.x < -2 * CFG.DISC_HALF || d.x > CFG.W + 2 * CFG.DISC_HALF) {
      d.state = 'gone';
    }
  }

  function updateDiscs(game, dt) {
    for (const d of game.discs) {
      if (d.state === 'flying') {
        fly(game, d, dt);
      } else if (d.state === 'ringed') {
        d.y = Math.min(d.restY, d.y + CFG.SLIDE_SPEED * dt);
      } else {
        d.ttl -= dt;
        if (d.ttl <= 0) d.state = 'gone';
      }
    }
    game.discs = game.discs.filter((d) => d.state !== 'gone');
  }

  function updatePopups(game, dt) {
    for (const p of game.popups) {
      p.ttl -= dt;
      p.y -= CFG.POPUP_RISE * dt;
    }
    game.popups = game.popups.filter((p) => p.ttl > 0);
  }

  // Advance the game by dt seconds. `down` is whether the throw button is held.
  function update(game, dt, down) {
    const pressed = down && !game.prevDown;
    game.prevDown = down;
    game.time += dt;
    if (game.phase === 'lobby' || game.phase === 'ended') return;

    for (const side of SIDES) {
      game[side].cooldown = Math.max(0, game[side].cooldown - dt);
      game[side].anim = Math.max(0, game[side].anim - dt);
    }
    // The peer's meter is animated locally; their 'throw' carries the real power.
    const peer = game[them(game)];
    if (peer.charging) sweep(peer, dt);

    if (game.phase === 'countdown') {
      game.countdown -= dt;
      if (game.countdown <= 0) game.phase = 'playing';
    } else if (game.phase === 'playing') {
      updateMine(game, dt, down);
    } else {
      game.overTimer += dt;
      if (pressed && game.overTimer >= CFG.RESTART_DELAY && !game.rematch[game.me]) {
        game.rematch[game.me] = true;
        game.outbox.push({ t: 'ready' });
        maybeRestart(game);
      }
    }
    updateDiscs(game, dt);
    updatePopups(game, dt);
  }

  const isPower = (n) => typeof n === 'number' && n >= 0 && n <= 1;
  const isScore = (n) => Number.isInteger(n) && n >= 0;

  // Apply one message from the peer. Anything unexpected ends the match loudly.
  function applyMessage(game, msg) {
    const peer = them(game);
    const t = msg !== null && typeof msg === 'object' ? msg.t : undefined;
    // Every peer says hello first, so anything else first (bar a host turning us
    // away) means the friend runs a different version of the page.
    if (t === 'hello' ? msg.v !== PROTOCOL : !game.peerKnown && t !== 'full') {
      end(game, 'VERSION MISMATCH', 'BOTH PLAYERS RELOAD THE PAGE');
    } else if (t === 'hello' && isName(msg.name)) {
      game.names[peer] = msg.name;
      game.peerKnown = true;
    } else if (t === 'charge') {
      startCharging(game[peer]);
    } else if (t === 'throw' && isPower(msg.power)) {
      game[peer].power = msg.power;
      throwDisc(game, peer);
    } else if (t === 'ready') {
      game.rematch[peer] = true;
      maybeRestart(game);
    } else if (t === 'full' && !game.host) {
      end(game, 'GAME IS FULL');
    } else if (t === 'start' && !game.host) {
      startCountdown(game);
    } else if (
      (t === 'score' || (t === 'over' && SIDES.includes(msg.winner))) &&
      !game.host &&
      isScore(msg.left) &&
      isScore(msg.right)
    ) {
      game.scores = { left: msg.left, right: msg.right };
      if (t === 'over') finish(game, msg.winner);
    } else {
      end(game, 'BAD MESSAGE FROM FRIEND');
    }
  }

  return {
    CFG,
    PROTOCOL,
    createGame,
    update,
    applyMessage,
    setLobby,
    setName,
    cleanName,
    connected,
    begin,
    end,
    them,
    pointsFor,
    speedForPower,
    powerToHit,
  };
})();

if (typeof module !== 'undefined') module.exports = Game;
