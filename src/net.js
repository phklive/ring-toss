// Peer-to-peer link over WebRTC, using PeerJS and its free public signalling
// server. The host registers its room code as a peer id; the guest dials it.
const Net = (() => {
  const PREFIX = 'ringtoss-v1-';
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: easy to read aloud
  const CONNECT_TIMEOUT_MS = 15000;
  const FULL_CLOSE_MS = 500;
  const ERRORS = {
    'peer-unavailable': 'GAME NOT FOUND',
    'browser-incompatible': 'BROWSER NOT SUPPORTED',
  };

  const isCode = (code) => /^[A-HJ-NP-Z]{4}$/.test(code);
  const peerId = (code) => PREFIX + code.toLowerCase();

  // handlers: onOpen(code) host is reachable, onConnect() link up,
  // onMessage(msg), onClose() link gone, onError(text) fatal problem.
  function createNet(Peer, handlers, rng = Math.random) {
    let peer = null;
    let conn = null;
    let timer = null;

    const fail = (text) => {
      clearTimeout(timer);
      handlers.onError(text);
    };

    // Once the link is up the signalling server is no longer needed, so its
    // errors (server restarts, dropped websocket) don't end the match.
    const onPeerError = (err) => {
      if (conn && conn.open) return;
      fail(ERRORS[err.type] || 'NETWORK ERROR');
    };

    function attach(c) {
      conn = c;
      c.on('open', () => {
        clearTimeout(timer);
        handlers.onConnect();
      });
      c.on('data', handlers.onMessage);
      c.on('close', handlers.onClose);
      c.on('error', () => fail('NETWORK ERROR'));
    }

    // Anyone dialling in after the friend is told the game is full.
    function turnAway(c) {
      c.on('open', () => {
        c.send({ t: 'full' });
        setTimeout(() => c.close(), FULL_CLOSE_MS);
      });
    }

    function host() {
      const code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join('');
      peer = new Peer(peerId(code));
      peer.on('open', () => handlers.onOpen(code));
      peer.on('connection', (c) => (conn ? turnAway(c) : attach(c)));
      peer.on('error', (err) => {
        if (err.type !== 'unavailable-id') return onPeerError(err);
        peer.destroy(); // code already taken: roll a new one
        host();
      });
    }

    function join(code) {
      if (!isCode(code)) throw new Error(`Net.join: bad room code "${code}"`);
      peer = new Peer();
      peer.on('open', () => attach(peer.connect(peerId(code), { reliable: true, serialization: 'json' })));
      peer.on('error', onPeerError);
      timer = setTimeout(() => fail('COULD NOT CONNECT'), CONNECT_TIMEOUT_MS);
    }

    function send(msg) {
      if (conn && conn.open) conn.send(msg);
    }

    return { host, join, send };
  }

  return { createNet, isCode, CONNECT_TIMEOUT_MS, FULL_CLOSE_MS };
})();

if (typeof module !== 'undefined') module.exports = Net;
