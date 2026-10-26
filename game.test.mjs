import test from 'node:test';
import assert from 'node:assert/strict';
import { newGame, dropPiece, findWin } from '../game.mjs';

export const DRAW = [5,5,1,6,1,5,1,5,0,4,0,6,0,6,4,3,6,1,5,4,4,6,3,4,2,1,5,4,1,2,3,0,3,3,0,6,0,2,3,2,2,2];

test('pieces fall to the lowest empty space and turns alternate', () => {
  const game = newGame();
  dropPiece(game, 1, 3);
  assert.equal(game.board[5][3], 1);
  assert.equal(game.turn, 2);
  dropPiece(game, 2, 3);
  assert.equal(game.board[4][3], 2);
  assert.equal(game.moves, 2);
});

test('rejects invalid columns, out-of-turn moves and full columns without mutations', () => {
  const game = newGame();
  for (const col of [-1, 7, 1.5, '2', null]) assert.throws(() => dropPiece(game, 1, col));
  assert.throws(() => dropPiece(game, 2, 0));
  assert.equal(game.moves, 0);
  for (let i = 0; i < 6; i++) dropPiece(game, game.turn, 3);
  const before = structuredClone(game);
  assert.throws(() => dropPiece(game, game.turn, 3), /full/);
  assert.deepEqual(game, before);
});

for (const [name, path] of [
  ['vertical', [0,1,0,1,0,1,0]],
  ['horizontal', [0,6,1,6,2,5,3]],
  ['rising diagonal', [0,1,1,2,4,2,2,3,4,3,5,3,3]],
  ['falling diagonal', [6,5,5,4,2,4,4,3,2,3,1,3,3]],
]) test(`${name} win ends the round and locks moves`, () => {
  const game = newGame();
  for (const col of path) dropPiece(game, game.turn, col);
  assert.equal(game.status, 'won');
  assert.equal(game.winner, 1);
  assert.equal(game.winningCells.length, 4);
  assert.throws(() => dropPiece(game, game.turn, 6), /over/);
});

test('detects a win joined through the middle and at an edge', () => {
  const board = newGame().board;
  board[5] = [1,1,1,1,1,0,0];
  assert.equal(findWin(board, 5, 2, 1).length, 5);
  assert.equal(findWin(board, 5, 0, 1).length, 5);
});

test('a complete legal 42-move game can end in a draw', () => {
  const game = newGame();
  for (const col of DRAW) dropPiece(game, game.turn, col);
  assert.equal(game.status, 'draw');
  assert.equal(game.winner, null);
  assert.equal(game.moves, 42);
  assert.deepEqual(game.winningCells, []);
});
