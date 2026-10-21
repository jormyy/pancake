import assert from 'node:assert/strict'
import { oracleWeek } from './calendar-oracle.mjs'
import { monday, shiftDay } from './season-model.mjs'

export function postponementTimeline(entries, games, confirmations = {}) {
  const timelines = [], gaps = []
  for (const entry of entries.filter(row => row.status === 'STATUS_POSTPONED')) {
    const note = entry.notes.map(note => note.headline).join(' ')
    const match = /Makeup date ([A-Z][a-z]{2}) (\d+)/.exec(note)
    const originalDate = entry.sourceDate
    const confirmed = confirmations[`${originalDate}:${entry.away}:${entry.home}`]
    if (!match && !confirmed) { gaps.push({ entry, reason: 'No makeup date in the raw ESPN note or pinned official announcement' }); continue }
    const date = confirmed?.date ?? new Date(`${match[1]} ${match[2]}, ${originalDate.slice(0, 4)} 12:00 GMT`).toISOString().slice(0, 10)
    const candidates = games.filter(game => game.date === date && game.home === entry.home && game.away === entry.away)
    if (candidates.length !== 1) { gaps.push({ entry, date, reason: 'Makeup NBA identity is not unique' }); continue }
    const game = candidates[0]
    const rawOriginalTime = entry.date === originalDate
    const originalTime = rawOriginalTime ? entry.time : `${originalDate}T23:00:00Z`
    const publicationDate=confirmed?.announcedDate??[date, monday(originalDate)===monday(date)?shiftDay(originalDate,1):shiftDay(monday(originalDate),8)].sort()[0]
    timelines.push({ id: game.id, espnId: entry.espnId, home: entry.home, away: entry.away, originalDate, originalTime, makeupDate: date, makeupTime: game.time,
      postponedAt: Date.parse(`${originalDate}T05:00:00Z`), rescheduledAt: Date.parse(`${publicationDate}T12:00:00Z`),
      facts: { originalDate: 'REAL-RAW ESPN date scoreboard', postponed: 'REAL-RAW ESPN STATUS_POSTPONED and note', makeupDate: confirmed ? `REAL-DERIVED from REAL-RAW official announcement ${confirmed.source} and final box` : 'REAL-RAW final box and ESPN note', sameNbaId: 'REAL-DERIVED unique team/date correlation; original NBA snapshot not found', originalTime: rawOriginalTime ? 'REAL-RAW' : 'SYNTHETIC unverified original tipoff', transitionTimes: 'SYNTHETIC conservative replay availability; historical announcement times unproven' }, source: entry.source })
  }
  return { provenance: 'REAL-DERIVED facts; SYNTHETIC transition availability', timelines, gaps }
}

export function checkPostponement({ timeline, calendar, originalMatchups, storedGames, stats, date, closedThrough = date }) {
  const originalWeek = oracleWeek(calendar, timeline.originalDate), playedWeek = oracleWeek(calendar, timeline.makeupDate)
  if (closedThrough > calendar.weeks.find(row => row.week_number === originalWeek).week_end) {
    assert.ok(originalMatchups.length, 'Postponement original week has expected fantasy rows')
    assert.ok(originalMatchups.every(row => row.is_finalized), 'A confirmed postponement cannot hold its original fantasy week open')
  }
  const rows = storedGames.filter(row => row.nba_game_id === timeline.id)
  assert.equal(rows.length, 1, 'Postponed and makeup observations retain one NBA game row')
  if (date >= timeline.makeupDate) {
    assert.equal(rows[0].game_date, timeline.makeupDate, 'Makeup scores in its actual played date')
    assert.equal(rows[0].week_number, playedWeek, 'Makeup uses the independent played fantasy week')
    assert.ok(stats.length, 'A played makeup game has stored player stats')
    assert.equal(new Set(stats.map(row => row.player_id)).size, stats.length, 'Makeup player stats occur exactly once')
  }
  return { passed: true, gameId: timeline.id, originalWeek, playedWeek, checkedDate: date }
}
