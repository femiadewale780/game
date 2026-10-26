import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { GameError, newGame, dropPiece } from './game.mjs';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const IDLE_TTL = 30 * 60 * 1000;
const NAME_LIMIT = 18;
const PUBLIC = new URL('./public/', import.meta.url);
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

function playerName(value, seat) {
  const name = typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
  return Array.from(name).slice(0, NAME_LIMIT).join('') || `Player ${seat}`;
}

function tokenMatches(a, b) {
  if (typeof a !== 'string' || !/^[a-f0-9]{64}$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw new GameError('Send JSON with this request.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new GameError('Request is too large.', 413);
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { throw new GameError('Invalid JSON. Please try again.'); }
}

/** One process owns the rooms. Run one instance, or add shared storage before scaling. */
export function createApp({ now = Date.now, roomTTL = IDLE_TTL, maxRooms = 2000, publicOrigin = process.env.PUBLIC_ORIGIN } = {}) {
  const rooms = new Map();
  const limits = new Map();
  const sockets = new Set();

  function limit(req, kind, max) {
    // Deliberately do not trust client-supplied X-Forwarded-For headers.
    const key = `${req.socket.remoteAddress}:${kind}`;
    const time = now();
    let bucket = limits.get(key);
    if (!bucket || time - bucket.start >= 60_000) {
      bucket = { start: time, count: 0 };
      limits.set(key, bucket);
    }
    if (++bucket.count > max) throw new GameError('A little too fast. Please try again in a minute.', 429);
  }

  function snapshot(room, seat) {
    return {
      code: room.code, you: seat, round: room.round, revision: room.revision,
      game: room.game, closed: room.closed, scores: room.scores,
      players: room.players.map(p => p ? { name: p.name, online: p.streams.size > 0 } : null),
      ready: [...room.ready],
    };
  }

  function broadcast(room) {
    room.revision++;
    for (let i = 0; i < 2; i++) {
      const player = room.players[i];
      if (!player) continue;
      const event = `event: state\ndata: ${JSON.stringify(snapshot(room, i + 1))}\n\n`;
      for (const res of player.streams) {
        if (res.destroyed || res.writableLength > 64 * 1024) { res.destroy(); continue; }
        res.write(event);
      }
    }
  }

  function sweep() {
    for (const [code, room] of rooms) {
      const online = room.players.some(p => p?.streams.size);
      if (!online && now() - room.lastActive >= roomTTL) rooms.delete(code);
    }
    for (const [key, bucket] of limits) if (now() - bucket.start >= 60_000) limits.delete(key);
  }

  function authorize(req, room) {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const i = room.players.findIndex(p => p && tokenMatches(token, p.token));
    if (i < 0) throw new GameError('Your seat could not be restored. Join a new room.', 401);
    return i + 1;
  }

  function newPlayer(name, seat) {
    return { name: playerName(name, seat), token: randomBytes(32).toString('hex'), streams: new Set() };
  }

  function checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new GameError('Open the game directly to play.', 403);
    const origin = req.headers.origin;
    if (!origin) return;
    try {
      const allowed = publicOrigin ? new URL(publicOrigin).origin : null;
      if (allowed ? new URL(origin).origin !== allowed : new URL(origin).host !== req.headers.host) throw new Error();
    } catch { throw new GameError('This origin is not allowed.', 403); }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') return json(res, 200, { ok: true });
      if (req.method === 'GET' && ASSETS.has(path)) {
        const [file, type] = ASSETS.get(path);
        const content = await readFile(new URL(file, PUBLIC));
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        return res.end(content);
      }
      if (!path.startsWith('/api/')) throw new GameError('Not found.', 404);
      checkOrigin(req);
      if (req.method === 'POST') limit(req, 'actions', 180);
      if (path === '/api/rooms' && req.method === 'POST') {
        limit(req, 'create', 12);
        const data = await body(req);
        sweep();
        if (rooms.size >= maxRooms) throw new GameError('All tables are busy. Please try again soon.', 503);
        let code;
        do { code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join(''); } while (rooms.has(code));
        const player = newPlayer(data.name, 1);
        const room = { code, players: [player, null], game: newGame(), round: 1, revision: 1, scores: [0, 0], ready: new Set(), closed: false, lastActive: now() };
        rooms.set(code, room);
        return json(res, 201, { token: player.token, state: snapshot(room, 1) });
      }
      const match = path.match(/^\/api\/rooms\/([A-Z2-9]{6})(?:\/(join|events|move|rematch|leave))?$/);
      if (!match) throw new GameError('Check your six-character room code.', 404);
      const [, code, action] = match;
      const room = rooms.get(code);
      if (!room) throw new GameError('Room not found. Check the code or create a new room.', 404);
      if (action === 'join' && req.method === 'POST') {
        limit(req, 'join', 30);
        const data = await body(req);
        if (room.closed) throw new GameError('This room has ended. Create a new one.', 410);
        if (room.players[1]) throw new GameError('This room already has two players.', 409);
        const player = newPlayer(data.name, 2);
        room.players[1] = player;
        room.lastActive = now();
        broadcast(room);
        return json(res, 200, { token: player.token, state: snapshot(room, 2) });
      }
      const seat = authorize(req, room);
      const player = room.players[seat - 1];
      if (!action && req.method === 'GET') return json(res, 200, { state: snapshot(room, seat) });
      if (action === 'events' && req.method === 'GET') {
        limit(req, 'streams', 120);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        req.socket.setKeepAlive(true);
        req.socket.setTimeout(0);
        // A refreshed or duplicated tab takes over this seat's stream.
        for (const previous of player.streams) previous.end('event: superseded\ndata: {}\n\n');
        player.streams.clear();
        player.streams.add(res);
        room.lastActive = now();
        broadcast(room);
        const heartbeat = setInterval(() => {
          if (res.destroyed || res.writableLength > 64 * 1024) res.destroy();
          else res.write(': heartbeat\n\n');
        }, 15_000);
        heartbeat.unref();
        res.on('close', () => {
          clearInterval(heartbeat);
          if (!player.streams.delete(res)) return;
          room.lastActive = now();
          broadcast(room);
        });
        return;
      }
      if (req.method !== 'POST') throw new GameError('Method not allowed.', 405);
      const data = await body(req);
      if (action === 'leave') {
        room.closed = true;
        room.ready.clear();
        room.lastActive = now();
        broadcast(room);
        return json(res, 200, { ok: true });
      }
      if (room.closed) throw new GameError('This room has ended. Start a fresh game.', 410);
      if (!room.players.every(p => p?.streams.size)) throw new GameError('Waiting for both players to connect.', 409);
      if (action === 'move') {
        if (data.round !== room.round || data.moves !== room.game.moves) throw new GameError('The board changed. Please try your move again.', 409);
        dropPiece(room.game, seat, data.col);
        if (room.game.winner) room.scores[room.game.winner - 1]++;
      } else if (action === 'rematch') {
        if (data.round !== room.round) throw new GameError('A new round has already started.', 409);
        if (room.game.status === 'playing') throw new GameError('Finish this round first.', 409);
        room.ready.add(seat);
        if (room.ready.size === 2) {
          room.round++;
          room.game = newGame(room.game.starter === 1 ? 2 : 1);
          room.ready.clear();
        }
      } else throw new GameError('Not found.', 404);
      room.lastActive = now();
      broadcast(room);
      return json(res, 200, { state: snapshot(room, seat) });
    } catch (err) {
      if (res.headersSent) { res.destroy(); return; }
      const status = err instanceof GameError ? err.status : 500;
      if (status === 429) res.setHeader('Retry-After', '60');
      if (status === 500) console.error('Request failed:', err);
      json(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : err.message });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const cleaner = setInterval(sweep, 60_000);
  cleaner.unref();
  server.on('close', () => clearInterval(cleaner));
  return {
    server, sweep,
    async close() {
      clearInterval(cleaner);
      for (const socket of sockets) socket.destroy();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`four. is ready at http://localhost:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
