export const ROWS = 6;
export const COLS = 7;

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function newGame(starter = 1) {
  return {
    board: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    turn: starter, starter, moves: 0, winner: null, winningCells: [],
    lastMove: null, status: 'playing',
  };
}

export function findWin(board, row, col, player) {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const cells = [[row, col]];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
        cells.push([r, c]);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return [];
}

export function dropPiece(game, player, col) {
  if (game.status !== 'playing') throw new GameError('This round is over. Ready for a rematch?', 409);
  if (game.turn !== player) throw new GameError('It is your opponent’s turn.', 409);
  if (!Number.isInteger(col) || col < 0 || col >= COLS) throw new GameError('Choose a column from 1 to 7.');
  let row = ROWS - 1;
  while (row >= 0 && game.board[row][col] !== 0) row--;
  if (row < 0) throw new GameError('That column is full. Try another.', 409);
  game.board[row][col] = player;
  game.moves++;
  game.lastMove = { row, col, player };
  game.winningCells = findWin(game.board, row, col, player);
  if (game.winningCells.length) {
    game.winner = player;
    game.status = 'won';
  } else if (game.moves === ROWS * COLS) {
    game.status = 'draw';
  } else {
    game.turn = player === 1 ? 2 : 1;
  }
  return game;
}
