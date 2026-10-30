import assert from 'node:assert/strict'

const names = ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-']

export function espnLiveEvent(game, box) {
  assert.ok(/^\d+$/.test(game.espnId), 'A retained ESPN game identity is required')
  const clock = /^PT(\d+)M([\d.]+)S$/.exec(box.gameClock ?? '')
  const status = { period: box.period ?? 0, displayClock: clock ? `${clock[1]}:${Number(clock[2]).toFixed(1).padStart(4, '0')}` : '0:00',
    type: { state: box.gameStatus === 3 ? 'post' : box.gameStatus === 2 ? 'in' : 'pre', completed: box.gameStatus === 3, detail: box.gameStatusText ?? '' } }
  const competition = { date: game.time, status, competitors: [['home', box.homeTeam], ['away', box.awayTeam]].map(([side, team]) => ({ homeAway: side, score: String(team.score), team: { abbreviation: team.teamTricode } })) }
  return { id: String(game.espnId), date: game.time, season: { type: 2, year: Number(game.date.slice(0, 4)) + (Number(game.date.slice(5, 7)) >= 7 ? 1 : 0) }, status, competitions: [competition] }
}

export function espnLiveSummary(game, box, identities, at) {
  const event = espnLiveEvent(game, box)
  return { header: { id: event.id, season: event.season, competitions: event.competitions }, meta: { lastUpdatedAt: new Date(at).toISOString() }, boxscore: {
    players: [box.homeTeam, box.awayTeam].map(team => ({ team: { abbreviation: team.teamTricode }, statistics: [{ names, athletes: team.players.filter(player => player.played !== '0' && player.played !== 0 && player.status !== 'INACTIVE').map(player => {
      const id = identities.get(Number(player.personId))
      assert.ok(id && /^\d+$/.test(id), `Missing retained ESPN athlete identity for NBA ${player.personId}`)
      const s = player.statistics
      const count = key => { assert.ok(Number.isFinite(s[key]), `Missing ${key} in the NBA replay snapshot`); return String(s[key]) }
      const minutes = /^PT(\d+)M([\d.]+)S$/.exec(s.minutes ?? '')
      assert.ok(minutes, 'NBA replay minutes must be present')
      return { athlete: { id: String(id), displayName: player.name }, didNotPlay: false, stats: [
        `${minutes[1]}:${Math.floor(Number(minutes[2])).toString().padStart(2, '0')}`, count('points'), `${count('fieldGoalsMade')}-${count('fieldGoalsAttempted')}`,
        `${count('threePointersMade')}-${count('threePointersAttempted')}`, `${count('freeThrowsMade')}-${count('freeThrowsAttempted')}`, count('reboundsTotal'),
        count('assists'), count('turnovers'), count('steals'), count('blocks'), count('reboundsOffensive'), count('reboundsDefensive'), count('foulsPersonal'), count('plusMinusPoints'),
      ] }
    }) }] })) },
  }
}
