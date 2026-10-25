import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fixtureDirectory, dates, miniRoot, season, writeJson } from './common.mjs'
import { fixtureStore } from './fixtures.mjs'
import { orderedActions, gameEndTime } from './snapshots.mjs'
import { twoPlan } from './two-checks.mjs'
import { planDay } from './planner.mjs'
import { courtSequence } from './court-sequence.mjs'

const directory = fixtureDirectory
const { games } = JSON.parse(await readFile(path.join(directory, 'games.json'), 'utf8'))
const store = await fixtureStore(directory)
const plans = [], anomalies = [], repeatedEnds = [], courtRepairs = [], courtGaps = []
const real=await twoPlan(),profiles=real?.seasons??[season]
for (const game of games) {
  const actions = orderedActions(await store.json(`playbyplay-${game.id}`))
  if (real) {
    try {
      const revised = courtSequence(await store.json(`boxscore-${game.id}`), actions, await store.json(`summary-${game.espnId}`))
      if (revised.removed.length || revised.reassigned.length) courtRepairs.push({ gameId: game.id, removed: revised.removed, reassigned: revised.reassigned, minuteEvidence: revised.minuteEvidence, provenance: 'REAL-DERIVED', basis: 'Unique minimal conflicting substitution correction that matches final NBA minutes within 1.1 seconds; impossible NBA team-minute totals require corroborating rounded ESPN minutes within 30.5 seconds.' })
    } catch (error) { courtGaps.push({ gameId: game.id, error: error.message }) }
  }
  const end = gameEndTime(actions)
  const ends = actions.filter(action => action.actionType === 'game' && action.subType === 'end')
  if (ends.length > 1) repeatedEnds.push({ gameId: game.id, ends })
  assert.ok(end > Date.parse(game.time) && end < Date.parse(game.time) + 43200000, `Invalid historical game end: ${game.id}`)
  const late = actions.filter(action => Date.parse(action.timeActual) > end)
  if (late.length) anomalies.push({ gameId: game.id, finalAt: new Date(end + 60000).toISOString(), ends, late })
}
await writeJson(path.join(miniRoot, 'evidence/court-source-audit.json'), { games: games.length, repairs: courtRepairs, gaps: courtGaps })
await writeJson(path.join(miniRoot, 'evidence/source-time-audit.json'), { games: games.length, anomalies, repeatedEnds, policy: 'Final delivery uses the last recorded game-end event plus 60 seconds. Live windows exclude actions timestamped after that event. Raw fixtures remain unchanged.' })
for (const profile of profiles) for (const date of dates(profile.start, profile.end)) {
  const today = games.filter(game => game.date === date)
  const plan = await planDay(today, store, date,real?{profile,calendar:profile.calendar,postponements:real.postponements.timelines,playoffStart:profile.playoffStart}:undefined)
  for (const window of plan.windows) assert.ok(plan.events.some(event => event.type === 'live' && event.at >= window.start && event.at <= window.end))
  const nextMorning = Date.parse(`${date}T09:00:00Z`) + 86400000
  assert.ok(plan.events.every(event => event.at < nextMorning), `Game events cross the next morning: ${date}`)
  plans.push({ date, games: today.length, ...plan })
}
assert.equal(plans.reduce((sum, plan) => sum + plan.games, 0), profiles.reduce((sum,row)=>sum+row.games,0))
const classes = {}
for (const plan of plans) {
  const group = classes[plan.category] ??= { dates: 0, games: 0, dispatches: 0, minimumLiveSnapshots: plan.minimumSnapshots }
  group.dates++
  group.games += plan.games
  group.dispatches += plan.events.length
}
await writeJson(path.join(miniRoot, 'evidence/plan-audit.json'), { seed: 493, classes, plans,calendars:real?.seasons.map(row=>({year:row.year,...row.calendar})),postponements:real?.postponements,cupFinals:real?.seasons.map(row=>({year:row.year,excluded:row.cupFinals,counted:row.countedCupGames})) })
console.log(JSON.stringify(classes))

assert.equal(courtGaps.length, 0, 'Every real game needs an unambiguous live court reconstruction; see court-source-audit.json')
