import assert from 'node:assert/strict'
import { sql } from './local-stack.mjs'

export function postponementCases(schedule, games) {
  return schedule.filter(entry => entry.status === 'STATUS_POSTPONED').map(entry => {
    const match = /Makeup date ([A-Z][a-z]{2}) (\d+)/.exec(entry.notes.map(note => note.headline).join(' '))
    assert.ok(match)
    const date = new Date(`${match[1]} ${match[2]}, ${entry.date.slice(0, 4)} 12:00:00 GMT`).toISOString().slice(0, 10)
    const matches = games.filter(game => game.date === date && game.home === entry.home && game.away === entry.away)
    assert.equal(matches.length, 1)
    return { gameId: matches[0].id, originalDate: entry.date, playedDate: date, originalWeek: Math.floor((Date.parse(entry.date) - Date.parse('2025-10-20')) / 604800000) + 1, playedWeek: Math.floor((Date.parse(date) - Date.parse('2025-10-20')) / 604800000) + 1, source: entry.source }
  })
}

export async function assertPostponements(cases, date) {
  const results = []
  for (const item of cases.filter(item => [item.originalDate, item.playedDate].includes(date))) {
    const row = JSON.parse(await sql(`SELECT json_build_object('date',g.game_date,'week',g.week_number,'status',g.status,'statusText',g.game_status_text,'stats',(SELECT count(*) FROM player_game_stats s WHERE s.game_id=g.id),'wrongWeek',(SELECT count(*) FROM player_game_stats s WHERE s.game_id=g.id AND s.week_number<>${item.playedWeek})) FROM nba_games g WHERE nba_game_id='${item.gameId}'`))
    assert.ok(row)
    if (date === item.originalDate) {
      assert.equal(row.stats, 0, 'A postponed game must not score in its original week')
      assert.equal(row.statusText, 'Postponed', 'The real pipeline must observe the postponement before the makeup')
    }
    else {
      assert.equal(row.date, item.playedDate)
      assert.equal(row.week, item.playedWeek)
      assert.equal(row.status, 'Final')
      assert.ok(row.stats > 0)
      assert.equal(row.wrongWeek, 0, 'Makeup stats must use the week actually played')
    }
    results.push({ ...item, observed: row, passed: true })
  }
  return results
}
