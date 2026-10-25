import assert from 'node:assert/strict'
import test from 'node:test'
import { preseasonGames } from './collect-rosters.mjs'

test('only preseason games can supply pre-opening roster observations',()=>{
  const base={gameDateEst:'2024-10-04T00:00:00Z',gameDateTimeUTC:'2024-10-04T16:00:00Z',homeTeam:{teamTricode:'BOS'},awayTeam:{teamTricode:'DEN'}}
  const games=preseasonGames({leagueSchedule:{gameDates:[{games:[{...base,gameId:'0012400001'},{...base,gameId:'0022400001'},{...base,gameId:'0062400001'}]}]}})
  assert.equal(games.length,1)
  assert.equal(games[0].rosterOnly,true)
})
