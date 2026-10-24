import assert from 'node:assert/strict'

const nameKey = name => name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/[^a-z0-9]/g, '')

function rawFantasy(player, settings) {
  const mapping = { points: 'points', rebounds: 'reboundsTotal', assists: 'assists', steals: 'steals', blocks: 'blocks', turnovers: 'turnovers', field_goals_made: 'fieldGoalsMade', field_goals_attempted: 'fieldGoalsAttempted', free_throws_made: 'freeThrowsMade', free_throws_attempted: 'freeThrowsAttempted', three_pointers_made: 'threePointersMade', three_pointers_attempted: 'threePointersAttempted', offensive_rebounds: 'reboundsOffensive', defensive_rebounds: 'reboundsDefensive', personal_fouls: 'foulsPersonal', plus_minus: 'plusMinusPoints' }
  let value = Object.entries(mapping).reduce((sum, [key, raw]) => sum + Number(player.statistics[raw] ?? 0) * Number(settings[key] ?? 0), 0)
  const doubles = ['points','reboundsTotal','assists','steals','blocks'].filter(key => player.statistics[key] >= 10).length
  value += doubles >= 2 ? Number(settings.double_double ?? 0) : 0
  value += doubles >= 3 ? Number(settings.triple_double ?? 0) : 0
  return Math.sign(value) * Math.round(Math.abs(Number(value.toFixed(8))) * 100) / 100
}

export function checkIdentityGame({ expected, players, stats, fantasy, lineups, settings }) {
  const canonical = players.filter(row => String(row.nba_id) === expected.nbaId)
  assert.equal(canonical.length, 1, `One canonical NBA identity: ${expected.name}`)
  const player = canonical[0]
  const duplicate = players.filter(row => row.id !== player.id && nameKey(row.display_name) === nameKey(expected.name))
  assert.equal(duplicate.length, 0, `No unlinked draft identity remains: ${expected.name}`)
  if (expected.draftPlayerId) assert.equal(player.id, expected.draftPlayerId, 'Draft identity links in place on first NBA appearance')
  const rows = stats.filter(row => row.player_id === player.id && row.nba_game_id === expected.gameId)
  assert.equal(rows.length, 1, `Every real rookie/traded-player game is ingested once: ${expected.name}/${expected.gameId}`)
  const points = fantasy.filter(row => row.player_id === player.id && row.nba_game_id === expected.gameId)
  assert.equal(points.length, 1, 'Every real rookie game has a fantasy-points row')
  assert.equal(Number(points[0].fantasy_points), rawFantasy(expected.raw, settings), 'Rookie/traded-player points equal the independent raw box oracle')
  if (expected.starter != null) {
    const lineup = lineups.filter(row => row.player_id === player.id && row.game_date === expected.date)
    assert.ok(lineup.length <= 1, 'A rookie has at most one lineup row for the date')
    assert.ok(lineup.every(row => row.member_id === expected.owner), 'Rookie lineup retains the intended owner')
    assert.equal(lineup.some(row => !['BE','IR'].includes(row.slot_type)), expected.starter, 'Rookie start/bench action reaches the locked lineup')
  }
  return { passed: true, playerId: player.id, nbaId: expected.nbaId, gameId: expected.gameId, date:expected.date, owner: expected.owner ?? null, started: expected.starter ?? null, points: Number(points[0].fantasy_points) }
}

export function checkContinuity(expected, players, roster, afterGameCount) {
  assert.equal(players.filter(row => String(row.nba_id) === expected.nbaId).length, 1, 'NBA trade retains one canonical person')
  assert.equal(players.find(row => String(row.nba_id) === expected.nbaId)?.id, expected.playerId, 'NBA trade keeps the same player row')
  if(expected.to!=null)assert.equal(players.find(row=>String(row.nba_id)===expected.nbaId)?.nba_team,expected.to,'The canonical player follows its raw-box-confirmed NBA team change')
  assert.equal(roster.filter(row => row.player_id === expected.playerId).length, 1, 'NBA trade retains one fantasy roster row')
  assert.equal(roster.find(row => row.player_id === expected.playerId)?.member_id, expected.owner, 'NBA team trade does not transfer fantasy ownership')
  assert.ok(afterGameCount > 0, 'The NBA-traded player continues scoring after the team change')
  return { passed: true, ...expected, afterGameCount }
}
