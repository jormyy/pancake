import assert from 'node:assert/strict'
import { orderedActions, gameEndTime } from './snapshots.mjs'

const faultDates = ['2025-10-22', '2025-10-23', '2025-10-24', '2025-10-25', '2025-10-26', '2025-10-27', '2025-10-28', '2025-11-04']
const boundaryDates = ['2026-01-08', '2026-01-09', '2026-01-24', '2026-01-25', '2026-01-26', '2026-01-29', '2026-03-18', '2026-03-31']

export function dayClass(date) {
  if (faultDates.includes(date)) return 'fault'
  if (boundaryDates.includes(date)) return 'postponement'
  if (date >= '2026-02-09' && date <= '2026-02-22') return 'all-star'
  if (date >= '2026-03-23' && date <= '2026-04-12') return 'playoff'
  const hash = [...date].reduce((value, char) => (Math.imul(value, 31) + char.charCodeAt(0)) >>> 0, 493)
  return Number(date.slice(8)) === 7 || hash % 13 === 0 ? 'seeded-dense' : 'standard'
}

export function coverWindows(windows, tipoffs) {
  const remaining = [...windows].sort((a, b) => a.end - b.end)
  const events = []
  while (remaining.length) {
    const first = remaining[0]
    let at = first.end
    for (const tip of [...tipoffs].sort((a, b) => b - a)) if (at >= tip - 240000 && at <= tip + 120000) at = tip - 240001
    if (at < first.start) at = Math.max(first.start, ...tipoffs.filter(tip => tip + 120001 <= first.end && tip + 120001 >= first.start).map(tip => tip + 120001))
    assert.ok(at >= first.start && at <= first.end, 'No safe live checkpoint inside the source interval')
    assert.ok(!tipoffs.some(tip => at >= tip - 240000 && at <= tip + 120000), 'Live checkpoint overlaps a pre-tip window')
    const covered = remaining.filter(window => window.start <= at && window.end >= at)
    events.push({ at, type: 'live', covers: covered.map(window => ({ gameId: window.gameId, period: window.period })) })
    for (const window of covered) remaining.splice(remaining.indexOf(window), 1)
  }
  return events
}

export function canOverlapDispatch(event, next) {
  return !next || next.at - event.at >= 360000
}

export async function planDay(games, store, date) {
  const category = dayClass(date)
  const dense = category !== 'standard'
  const nextDate = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const offset = new Intl.DateTimeFormat('en', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date(`${date}T12:00:00Z`)).find(part => part.type === 'timeZoneName').value.replace('GMT', '')
  const boardDeadline = Date.parse(`${nextDate}T00:00:00${offset}`) - 240000
  const windows = [], finals = [], tipoffs = [...new Set(games.map(game => Date.parse(game.time)))]
  for (const game of games) {
    const actions = orderedActions(await store.json(`playbyplay-${game.id}`))
    const endTime = gameEndTime(actions)
    const liveActions = actions.filter(action => Date.parse(action.timeActual) <= endTime)
    const groups = dense ? [1, 2, 3, 4].map(period => liveActions.filter(action => action.period === period)) : [liveActions]
    for (const group of groups) {
      assert.ok(group.length)
      const start = Date.parse(group[Math.floor(group.length * 0.15)].timeActual)
      const end = Math.min(Date.parse(group[Math.floor(group.length * 0.75)].timeActual), dense ? Infinity : boardDeadline)
      windows.push({ gameId: game.id, period: dense ? group[0].period : null, start, end })
    }
    finals.push(endTime + 60000)
  }
  const events = [...tipoffs.map(at => ({ at: at - 60000, type: 'pre-tipoff' })), ...coverWindows(windows, tipoffs)]
  if (finals.length) events.push({ at: Math.max(...finals), type: 'final' })
  events.sort((a, b) => a.at - b.at)
  return { category, requiredPeriods: dense ? [1, 2, 3, 4] : null, minimumSnapshots: dense ? 4 : 1, windows, events }
}
