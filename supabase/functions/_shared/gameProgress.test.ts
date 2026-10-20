import { equal, throws } from 'node:assert/strict'
import { gameElapsedSeconds } from './gameProgress.ts'

Deno.test('game progress orders regulation and overtime across resets', () => {
  equal(gameElapsedSeconds({ gameStatus: 1 }), 0)
  equal(gameElapsedSeconds({ gameStatus: 2, period: 1, gameClock: 'PT06M30.50S' }), 329.5)
  equal(gameElapsedSeconds({ gameStatus: 2, period: 2, gameClock: 'PT12M00.00S' }), 720)
  equal(gameElapsedSeconds({ gameStatus: 2, period: 5, gameClock: 'PT05M00.00S' }), 2880)
  equal(gameElapsedSeconds({ gameStatus: 2, period: 6, gameClock: 'PT04M00.00S' }), 3240)
})

Deno.test('missing or impossible live clocks fail closed', () => {
  for (const game of [{ gameStatus: 2 }, { gameStatus: 2, period: 1, gameClock: 'invalid' }, { gameStatus: 2, period: 5, gameClock: 'PT12M00.00S' }, { gameStatus: 2, period: 0, gameClock: 'PT00M00.00S' }]) throws(() => gameElapsedSeconds(game))
})
