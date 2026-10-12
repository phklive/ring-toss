// Browser wiring: room link, network, input, integer pixel scaling, frame loop.
function boot({ win, doc, Game, Render, Net, Peer }) {
  const el = (id) => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`boot: #${id} not found`);
    return node;
  };
  const canvas = el('game');
  const share = el('share');
  const link = el('link');
  const copy = el('copy');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('boot: 2D canvas context unavailable');
  if (typeof Peer !== 'function') throw new Error('boot: PeerJS failed to load');

  const { W, H, MAX_DT } = Game.CFG;
  canvas.width = W;
  canvas.height = H;

  // A link ending in #CODE joins that room; no code means host a new one.
  const code = win.location.hash.slice(1).toUpperCase();
  const game = Game.createGame(code ? 'right' : 'left');
  const net = Net.createNet(Peer, {
    onOpen(roomCode) {
      link.value = `${win.location.origin}${win.location.pathname}#${roomCode}`;
      share.hidden = false;
      Game.setLobby(game, ['WAITING FOR FRIEND', 'SEND THEM THE LINK BELOW']);
    },
    onConnect() {
      share.hidden = true;
      if (game.host) Game.begin(game);
      else Game.setLobby(game, ['CONNECTED', 'STARTING...']);
    },
    onMessage: (msg) => Game.applyMessage(game, msg),
    onClose: () => Game.end(game, 'FRIEND LEFT'),
    onError: (text) => Game.end(game, text),
  });
  if (!code) {
    Game.setLobby(game, ['CREATING GAME...']);
    net.host();
  } else if (Net.isCode(code)) {
    Game.setLobby(game, [`JOINING GAME ${code}...`]);
    net.join(code);
  } else {
    Game.end(game, 'BAD GAME LINK');
  }

  // The link stays selected, so a refused clipboard still leaves Cmd/Ctrl+C.
  copy.addEventListener('click', () => {
    link.select();
    win.navigator.clipboard.writeText(link.value).then(
      () => {
        copy.textContent = 'Copied!';
      },
      () => {
        copy.textContent = 'Press Cmd/Ctrl+C';
      },
    );
  });

  // Space, mouse, or touch: anything held counts as the throw button.
  // Once the game has ended, any press starts a fresh room.
  let down = false;
  const press = () => {
    if (game.phase === 'ended') win.location.assign(win.location.pathname);
    down = true;
  };
  const release = () => {
    down = false;
  };
  const onKey = (handler) => (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    handler();
  };
  win.addEventListener('keydown', onKey(press));
  win.addEventListener('keyup', onKey(release));
  win.addEventListener('pointerdown', press);
  win.addEventListener('pointerup', release);
  win.addEventListener('pointercancel', release);
  win.addEventListener('blur', release);

  const fit = () => {
    const scale = Math.max(1, Math.floor(Math.min(win.innerWidth / W, win.innerHeight / H)));
    canvas.style.width = `${W * scale}px`;
    canvas.style.height = `${H * scale}px`;
  };
  win.addEventListener('resize', fit);
  fit();

  let last = null;
  const frame = (now) => {
    const dt = last === null ? 0 : Math.min((now - last) / 1000, MAX_DT);
    last = now;
    Game.update(game, dt, down);
    for (const msg of game.outbox.splice(0)) net.send(msg);
    Render.draw(ctx, game);
    win.requestAnimationFrame(frame);
  };
  win.requestAnimationFrame(frame);
  return game;
}

if (typeof module !== 'undefined') module.exports = boot;
