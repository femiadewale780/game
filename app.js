const $ = id => document.getElementById(id);
const SESSION_KEY = 'four.session.v1';
const NAME_KEY = 'four.name.v1';
const state = { mode: 'create', session: null, room: null, connected: false, busy: false, generation: 0, stream: null, toastTimer: null, boardKey: null };

function storageGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { sessionStorage.setItem(key, value); } catch { /* Play still works if storage is unavailable. */ } }
function storageRemove(key) { try { sessionStorage.removeItem(key); } catch { /* Storage can be disabled. */ } }

function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

async function api(path, data, token = state.session?.token) {
  const headers = {};
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(path, {
      method: data === undefined ? 'GET' : 'POST', headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(12_000),
    });
  } catch { throw new Error('Can’t reach the game. Check your connection and try again.'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function setMode(mode, focus = false) {
  state.mode = mode;
  for (const item of document.querySelectorAll('.tab')) {
    const active = item.dataset.mode === mode;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
  }
  $('room-form').setAttribute('aria-labelledby', `${mode}-tab`);
  $('code-field').hidden = mode !== 'join';
  $('room-code').required = mode === 'join';
  $('start-label').textContent = mode === 'join' ? 'Join the game' : 'Let’s play';
  $('form-hint').textContent = mode === 'join' ? 'Your seat at the table is one code away.' : 'Create a room. Send the code. You’re in.';
  $('form-error').hidden = true;
  if (focus) $(`${mode}-tab`).focus();
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
  tab.addEventListener('keydown', e => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      setMode(e.key === 'Home' ? 'create' : e.key === 'End' ? 'join' : state.mode === 'create' ? 'join' : 'create', true);
    }
  });
}
$('room-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
$('room-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (state.busy) return;
  const name = $('player-name').value.trim();
  const code = $('room-code').value.toUpperCase();
  if (state.mode === 'join' && !/^[A-Z2-9]{6}$/.test(code)) {
    $('form-error').textContent = 'Enter the six-character code from your friend.';
    $('form-error').hidden = false;
    $('room-code').focus();
    return;
  }
  state.busy = true;
  $('form-error').hidden = true;
  for (const el of document.querySelectorAll('#room-form input, #start-button, .tab')) el.disabled = true;
  $('start-label').textContent = state.mode === 'create' ? 'Setting your table…' : 'Joining your friend…';
  try {
    const result = await api(state.mode === 'create' ? '/api/rooms' : `/api/rooms/${code}/join`, { name }, null);
    storageSet(NAME_KEY, name);
    enterRoom(result);
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
  } finally {
    state.busy = false;
    for (const el of document.querySelectorAll('#room-form input, #start-button, .tab')) el.disabled = false;
    $('start-label').textContent = state.mode === 'join' ? 'Join the game' : 'Let’s play';
    if (state.room) render();
  }
});

function persist() {
  if (state.session && state.room) storageSet(SESSION_KEY, JSON.stringify({ ...state.session, state: state.room }));
}

function enterRoom(result) {
  state.session = { token: result.token, code: result.state.code };
  state.room = result.state;
  state.boardKey = null;
  state.connected = false;
  persist();
  $('lobby').hidden = true;
  $('game').hidden = false;
  document.title = `Room ${state.room.code} — four.`;
  render();
  connect();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function updateRoom(room) {
  if (!state.session || room.code !== state.session.code) return;
  if (state.room && room.revision < state.room.revision) return;
  state.room = room;
  persist();
  render();
}

function stopStream() {
  state.generation++;
  state.stream?.abort();
  state.stream = null;
  state.connected = false;
}

async function connect() {
  stopStream();
  const generation = state.generation;
  let attempt = 0;
  while (state.session && generation === state.generation) {
    const controller = new AbortController();
    state.stream = controller;
    let watchdog;
    const touchWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), 40_000);
    };
    try {
      touchWatchdog();
      const response = await fetch(`/api/rooms/${state.session.code}/events`, { headers: { Authorization: `Bearer ${state.session.token}` }, signal: controller.signal });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        if ([401, 404, 410].includes(response.status)) {
          returnToLobby();
          toast(result.error || 'This room has expired. Create a fresh one.');
          return;
        }
        throw new Error(result.error || 'Connection interrupted');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (generation === state.generation) {
        const { value, done } = await reader.read();
        if (done) break;
        touchWatchdog();
        pending += decoder.decode(value, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const event = block.split('\n').find(line => line.startsWith('event: '))?.slice(7);
          const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6);
          if (event === 'superseded') {
            stopStream();
            render();
            toast('This seat is open in another tab. Refresh here to take it back.');
            return;
          }
          if (event === 'state' && data && generation === state.generation) {
            attempt = 0;
            state.connected = true;
            updateRoom(JSON.parse(data));
          }
        }
      }
    } catch { /* A fresh, complete snapshot is sent on every reconnect. */ }
    finally { clearTimeout(watchdog); controller.abort(); }
    if (generation !== state.generation || !state.session) return;
    state.connected = false;
    render();
    await new Promise(resolve => setTimeout(resolve, Math.min(500 * 2 ** attempt++, 5000)));
  }
}

const columnButtons = [];
const cells = Array.from({ length: 6 }, () => Array(7));
for (let col = 0; col < 7; col++) {
  const button = document.createElement('button');
  button.className = 'column';
  button.type = 'button';
  button.dataset.col = col;
  button.addEventListener('click', () => play(col));
  for (let row = 0; row < 6; row++) {
    const cell = document.createElement('span');
    cell.className = 'cell';
    cell.setAttribute('aria-hidden', 'true');
    cells[row][col] = cell;
    button.append(cell);
  }
  columnButtons.push(button);
  $('board').append(button);
}

function canPlay() {
  const r = state.room;
  return r && state.connected && !state.busy && !r.closed && r.players.every(p => p?.online) && r.game.status === 'playing' && r.game.turn === r.you;
}

function render() {
  const r = state.room;
  if (!r) return;
  const g = r.game;
  const opponent = r.players[r.you === 1 ? 1 : 0];
  const myTurn = g.turn === r.you;
  $('connection-label').textContent = state.connected ? 'Connected' : 'Reconnecting…';
  $('connection-badge').classList.toggle('offline', !state.connected);
  $('display-code').textContent = r.code;
  $('round-label').textContent = `ROUND ${String(r.round).padStart(2, '0')}`;
  $('move-count').textContent = `${g.moves} ${g.moves === 1 ? 'piece' : 'pieces'} played`;
  $('board').classList.toggle('player-two', r.you === 2);
  for (let i = 1; i <= 2; i++) {
    const player = r.players[i - 1];
    $(`name-${i}`).textContent = player ? `${player.name}${i === r.you ? ' (you)' : ''}` : 'Your plus one';
    $(`name-${i}`).title = $(`name-${i}`).textContent;
    $(`presence-${i}`).textContent = !player ? 'Waiting to join' : player.online ? (i === 1 ? 'Lime · ●' : 'Lilac · ◆') : 'Reconnecting…';
    $(`score-${i}`).textContent = r.scores[i - 1];
    $(`score-${i}`).setAttribute('aria-label', `${player?.name || `Player ${i}`}: ${r.scores[i - 1]} wins`);
    $(`player-${i}`).classList.toggle('current', !r.closed && state.connected && g.status === 'playing' && g.turn === i && r.players.every(p => p?.online));
  }
  let title, detail, symbol = '●';
  if (r.closed) {
    title = 'This room has ended'; detail = 'Thanks for playing. Start a new room for another game.'; symbol = '↗';
  } else if (!state.connected) {
    title = 'Getting you back to the table'; detail = 'Reconnecting automatically. Your seat is reserved.'; symbol = '↻';
  } else if (!opponent) {
    title = 'Your table is ready'; detail = 'Share the code with a friend to start playing.'; symbol = '✳';
  } else if (!opponent.online) {
    title = `${opponent.name} is reconnecting`; detail = 'The game is paused. Your pieces are staying put.'; symbol = '↻';
  } else if (g.status === 'won') {
    title = g.winner === r.you ? 'That’s four. You win!' : `${r.players[g.winner - 1].name} connects four!`;
    detail = r.ready.includes(r.you) ? 'Rematch requested. Waiting for your friend.' : r.ready.length ? 'Your friend is ready for a rematch. Join them?' : 'Well played. Same friend, fresh board?';
    symbol = '✳';
  } else if (g.status === 'draw') {
    title = 'A full board. An even match.';
    detail = r.ready.includes(r.you) ? 'Waiting for your friend to play again.' : 'It’s a draw. Ready for the next round?'; symbol = '=';
  } else {
    title = myTurn ? 'Your move. Make it a good one.' : `${opponent.name} is thinking…`;
    detail = myTurn ? 'Pick a column to drop your piece.' : 'Your next great move is worth the wait.';
    symbol = g.turn === 1 ? '●' : '◆';
  }
  $('turn-title').textContent = title;
  $('turn-detail').textContent = detail;
  $('turn-symbol').textContent = symbol;
  $('turn-banner').classList.toggle('opponent', g.status === 'playing' && g.turn === 2 && !!opponent?.online && !r.closed);
  $('invite-hint').textContent = r.closed ? 'This room has closed. Create a new one to play again.' : r.players[1] ? 'Both seats are taken. This table is just for the two of you.' : 'Send this to a friend. They can join from any device.';
  $('copy-code').disabled = r.closed;
  $('copy-link').disabled = r.closed;
  const key = `${r.round}:${g.moves}`;
  const changed = state.boardKey !== key;
  const animate = state.boardKey !== null && changed;
  if (changed) {
    for (let row = 0; row < 6; row++) {
      for (let col = 0; col < 7; col++) {
        const cell = cells[row][col];
        cell.replaceChildren();
        const piece = g.board[row][col];
        if (piece) {
          const disc = document.createElement('span');
          const isLast = g.lastMove?.row === row && g.lastMove?.col === col;
          const winning = g.winningCells.some(([r, c]) => r === row && c === col);
          disc.className = `piece ${piece === 1 ? 'one' : 'two'}${isLast ? ' last' : ''}${winning ? ' winning' : ''}${animate && isLast ? ' fresh' : ''}`;
          disc.textContent = piece === 1 ? '●' : '◆';
          cell.append(disc);
        }
      }
    }
    state.boardKey = key;
  }
  for (let col = 0; col < 7; col++) {
    let row = 5;
    while (row >= 0 && g.board[row][col]) row--;
    const button = columnButtons[col];
    button.disabled = !canPlay() || row < 0;
    button.classList.toggle('full', row < 0);
    const contents = g.board.map(r => r[col] === 1 ? 'lime' : r[col] === 2 ? 'lilac' : 'empty').join(', ');
    button.setAttribute('aria-label', `Column ${col + 1}${row < 0 ? ', full' : `, ${row + 1} empty spaces`}. Top to bottom: ${contents}`);
    for (let r = 0; r < 6; r++) cells[r][col].classList.toggle('ghost', r === row && canPlay());
  }
  $('rematch-button').hidden = !r.closed && g.status === 'playing';
  $('rematch-button').disabled = !r.closed && (state.busy || !state.connected || !opponent?.online || r.ready.includes(r.you));
  $('rematch-button').textContent = r.closed ? 'Back to the lobby ↗' : r.ready.includes(r.you) ? 'Waiting for your friend…' : r.ready.length ? 'Accept rematch ↻' : 'Play again ↻';
}

async function play(col) {
  if (!canPlay() || state.room.game.board[0][col]) return;
  state.busy = true;
  render();
  const { code, round, game } = state.room;
  try {
    const result = await api(`/api/rooms/${code}/move`, { col, round, moves: game.moves });
    updateRoom(result.state);
  } catch (error) { toast(error.message); }
  finally { state.busy = false; render(); }
}

$('rematch-button').addEventListener('click', async () => {
  if (state.room.closed) return returnToLobby();
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const result = await api(`/api/rooms/${state.room.code}/rematch`, { round: state.room.round });
    updateRoom(result.state);
  } catch (error) { toast(error.message); }
  finally { state.busy = false; render(); }
});

document.addEventListener('keydown', e => {
  if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !state.room || document.querySelector('dialog[open]')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
  if (/^[1-7]$/.test(e.key)) { e.preventDefault(); play(Number(e.key) - 1); }
});

function returnToLobby() {
  stopStream();
  state.session = null;
  state.room = null;
  state.boardKey = null;
  storageRemove(SESSION_KEY);
  $('game').hidden = true;
  $('lobby').hidden = false;
  document.title = 'four. — A little friendly competition.';
  history.replaceState(null, '', location.pathname);
  setMode('create');
  $('create-tab').focus();
}

$('rules-button').addEventListener('click', () => $('rules-dialog').showModal());
$('leave-button').addEventListener('click', () => state.room?.closed ? returnToLobby() : $('leave-dialog').showModal());
$('home-link').addEventListener('click', e => {
  e.preventDefault();
  if (state.room && !state.room.closed) $('leave-dialog').showModal();
  else returnToLobby();
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => $(button.dataset.close).close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', e => {
  const rect = dialog.getBoundingClientRect();
  if (e.target === dialog && (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)) dialog.close();
});
$('confirm-leave').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  $('confirm-leave').disabled = true;
  try {
    await api(`/api/rooms/${state.room.code}/leave`, {});
    $('leave-dialog').close();
    returnToLobby();
  } catch (error) { toast(error.message); }
  finally { state.busy = false; $('confirm-leave').disabled = false; }
});

async function copy(text, success) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error();
    await navigator.clipboard.writeText(text);
    toast(success);
  } catch {
    // Clipboard API requires HTTPS; this fallback also supports home Wi-Fi play.
    const area = document.createElement('textarea');
    area.value = text;
    area.className = 'copy-buffer';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    toast(copied ? success : `Copy this room code: ${state.room.code}`);
  }
}
$('copy-code').addEventListener('click', () => copy(state.room.code, 'Room code copied. Send it to your plus one.'));
$('copy-link').addEventListener('click', () => {
  const url = new URL('/', location.href);
  url.searchParams.set('room', state.room.code);
  copy(url.href, 'Invite link copied. Your friend’s seat is ready.');
});
window.addEventListener('online', () => { if (state.session) connect(); });
window.addEventListener('offline', () => { if (state.session) { stopStream(); render(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.session && !state.connected) connect(); });
window.addEventListener('pagehide', stopStream);
window.addEventListener('pageshow', e => { if (e.persisted && state.session) connect(); });

// Original decorative board, built from simple circles (never used as game state).
const demo = [
  [0,0,0,0,0,0,0], [0,0,0,0,0,0,0], [0,0,0,1,0,0,0],
  [0,0,1,2,0,0,0], [0,1,2,1,2,0,0], [1,2,1,2,1,2,0],
];
for (let row = 0; row < 6; row++) for (let col = 0; col < 7; col++) {
  const el = document.createElement('span');
  el.className = `demo-cell${demo[row][col] ? demo[row][col] === 1 ? ' one' : ' two' : ''}${row + col === 5 && col < 4 ? ' demo-win' : ''}`;
  $('demo-board').append(el);
}
$('player-name').value = storageGet(NAME_KEY) || '';
const invitation = new URL(location.href).searchParams.get('room')?.trim().toUpperCase();
if (invitation) { setMode('join'); $('room-code').value = invitation.replace(/[^A-Z0-9]/g, '').slice(0, 6); }
try {
  const saved = JSON.parse(storageGet(SESSION_KEY));
  if (saved?.token && /^[A-Z2-9]{6}$/.test(saved.code) && saved.state?.code === saved.code && Array.isArray(saved.state?.game?.board)) {
    enterRoom(saved);
    if (invitation && invitation !== saved.code) toast('Your current room was restored. Leave it first to join another.');
  }
} catch { storageRemove(SESSION_KEY); }
