import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const app = createApp(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const streams = [];
  t.after(async () => { for (const s of streams) s.close(); await app.close(); });
  async function request(path, data, token, extra = {}) {
    const res = await fetch(base + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: res.status, body: await res.json() };
  }
  async function create(name = 'Ada') { return (await request('/api/rooms', { name })).body; }
  async function join(code, name = 'Lin') { return (await request(`/api/rooms/${code}/join`, { name })).body; }
  async function stream(player) {
    const abort = new AbortController();
    const res = await fetch(`${base}/api/rooms/${player.state.code}/events`, { headers: { Authorization: `Bearer ${player.token}` }, signal: abort.signal });
    assert.equal(res.status, 200);
    let current;
    const waiters = [];
    const s = {
      get state() { return current; },
      close: () => abort.abort(),
      wait(predicate) {
        if (current && predicate(current)) return Promise.resolve(current);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Stream update timed out')), 2500) };
          waiters.push(waiter);
        });
      },
    };
    streams.push(s);
    (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let end;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            if (!block.startsWith('event: state')) continue;
            current = JSON.parse(block.split('\ndata: ')[1]);
            for (const waiter of [...waiters]) if (waiter.predicate(current)) {
              clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(current);
            }
          }
        }
      } catch (error) { if (error.name !== 'AbortError') throw error; }
    })();
    await s.wait(() => true);
    return s;
  }
  async function pair() {
    const a = await create(); const sa = await stream(a);
    const b = await join(a.state.code); const sb = await stream(b);
    await sa.wait(s => s.players.every(p => p?.online));
    return { a, b, sa, sb, code: a.state.code };
  }
  return { app, base, request, create, join, stream, pair };
}

test('static app and health endpoint are served with security headers', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/style.css', '/app.js', '/favicon.svg', '/healthz']) {
    const res = await fetch(f.base + path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    await res.arrayBuffer();
  }
  assert.equal((await f.request('/server.mjs')).status, 404);
});

test('room codes, private credentials, sanitized names and authenticated restoration', async t => {
  const f = await fixture(t);
  const a = await f.create('  Ada\u0001  ');
  assert.match(a.state.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.match(a.token, /^[a-f0-9]{64}$/);
  assert.equal(a.state.players[0].name, 'Ada');
  assert.equal(a.state.you, 1);
  assert.equal(JSON.stringify(a.state).includes(a.token), false);
  const restored = await f.request(`/api/rooms/${a.state.code}`, undefined, a.token);
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.state, a.state);
  assert.equal((await f.request(`/api/rooms/${a.state.code}`)).status, 401);
  assert.equal((await f.request(`/api/rooms/${a.state.code}`, undefined, 'x'.repeat(64))).status, 401);
  assert.equal((await f.request('/api/rooms/ZZZZZZ/join', {})).status, 404);
});

test('simultaneous joins reserve exactly one second seat', async t => {
  const f = await fixture(t); const a = await f.create();
  const results = await Promise.all([1,2,3].map(i => f.request(`/api/rooms/${a.state.code}/join`, { name: `Friend ${i}` })));
  assert.deepEqual(results.map(r => r.status).sort(), [200,409,409]);
});

test('moves wait for two connected players and reject another origin', async t => {
  const f = await fixture(t); const a = await f.create();
  assert.equal((await f.request(`/api/rooms/${a.state.code}/move`, { col: 0, round: 1, moves: 0 }, a.token)).status, 409);
  assert.equal((await f.request('/api/rooms', {}, null, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await f.request('/api/rooms', {}, null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('both streams receive moves, illegal turns fail and duplicated requests commit once', async t => {
  const f = await fixture(t); const { a, b, sa, sb, code } = await f.pair();
  assert.equal((await f.request(`/api/rooms/${code}/move`, { col: 1, round: 1, moves: 0 }, b.token)).status, 409);
  const move = () => f.request(`/api/rooms/${code}/move`, { col: 3, round: 1, moves: 0 }, a.token);
  const results = await Promise.all([move(), move()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200,409]);
  const [one, two] = await Promise.all([sa.wait(s => s.game.moves === 1), sb.wait(s => s.game.moves === 1)]);
  assert.deepEqual(one.game, two.game);
  assert.equal(one.game.board[5][3], 1);
  assert.equal(two.you, 2);
  assert.equal(JSON.stringify(two).includes(a.token), false);
  assert.equal((await f.request(`/api/rooms/${code}/move`, { col: 0, round: 99, moves: 1 }, b.token)).status, 409);
});

test('disconnect pauses moves and reconnect restores the same board and seat', async t => {
  const f = await fixture(t); const { a, b, sa, sb, code } = await f.pair();
  await f.request(`/api/rooms/${code}/move`, { col: 3, round: 1, moves: 0 }, a.token);
  sa.close();
  await sb.wait(s => !s.players[0].online);
  assert.equal((await f.request(`/api/rooms/${code}/move`, { col: 4, round: 1, moves: 1 }, b.token)).status, 409);
  const resumed = await f.stream(a);
  assert.equal(resumed.state.you, 1);
  assert.equal(resumed.state.game.board[5][3], 1);
  await sb.wait(s => s.players[0].online);
  assert.equal((await f.request(`/api/rooms/${code}/move`, { col: 4, round: 1, moves: 1 }, b.token)).status, 200);
});

test('win, score, mutual rematch and alternating starter are authoritative', async t => {
  const f = await fixture(t); const { a, b, sb, code } = await f.pair();
  assert.equal((await f.request(`/api/rooms/${code}/rematch`, { round: 1 }, a.token)).status, 409);
  const path = [0,1,0,1,0,1,0];
  for (let moves = 0; moves < path.length; moves++) {
    assert.equal((await f.request(`/api/rooms/${code}/move`, { col: path[moves], round: 1, moves }, moves % 2 ? b.token : a.token)).status, 200);
  }
  const won = await sb.wait(s => s.game.status === 'won');
  assert.deepEqual(won.scores, [1,0]);
  assert.equal(won.game.winningCells.length, 4);
  assert.equal((await f.request(`/api/rooms/${code}/move`, { col: 2, round: 1, moves: 7 }, b.token)).status, 409);
  const first = await f.request(`/api/rooms/${code}/rematch`, { round: 1 }, a.token);
  assert.equal(first.body.state.round, 1);
  assert.deepEqual(first.body.state.ready, [1]);
  const second = await f.request(`/api/rooms/${code}/rematch`, { round: 1 }, b.token);
  assert.equal(second.body.state.round, 2);
  assert.equal(second.body.state.game.turn, 2);
  assert.equal(second.body.state.game.moves, 0);
  assert.deepEqual(second.body.state.scores, [1,0]);
  assert.equal((await f.request(`/api/rooms/${code}/rematch`, { round: 1 }, a.token)).status, 409);
});

test('leaving ends the room for both players and blocks new joins', async t => {
  const f = await fixture(t); const { a, b, sb, code } = await f.pair();
  assert.equal((await f.request(`/api/rooms/${code}/leave`, {}, a.token)).status, 200);
  await sb.wait(s => s.closed);
  assert.equal((await f.request(`/api/rooms/${code}/move`, { col: 0, round: 1, moves: 0 }, b.token)).status, 410);
  assert.equal((await f.request(`/api/rooms/${code}/join`, {})).status, 410);
});

test('idle rooms expire and creation capacity recovers', async t => {
  let clock = 0;
  const f = await fixture(t, { now: () => clock, roomTTL: 1000, maxRooms: 1 });
  const a = await f.create();
  assert.equal((await f.request('/api/rooms', {})).status, 503);
  clock = 1001; f.app.sweep();
  assert.equal((await f.request(`/api/rooms/${a.state.code}`, undefined, a.token)).status, 404);
  assert.equal((await f.request('/api/rooms', {})).status, 201);
});
