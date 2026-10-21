import assert from 'node:assert/strict'
import { courtTime, minutesIso } from './court.mjs'
import { courtSequence } from './court-sequence.mjs'

export const countingStats = ['points', 'assists', 'blocks', 'reboundsTotal', 'reboundsOffensive', 'reboundsDefensive', 'steals', 'turnovers', 'foulsPersonal', 'fieldGoalsAttempted', 'fieldGoalsMade', 'threePointersAttempted', 'threePointersMade', 'freeThrowsAttempted', 'freeThrowsMade']

const orderedCache = new WeakMap()

export function orderedActions(payload) {
  if (orderedCache.has(payload)) return orderedCache.get(payload)
  const actions = payload.game?.actions
  assert.ok(Array.isArray(actions) && actions.length > 0, 'Play-by-play actions are required')
  assert.equal(new Set(actions.map(action => action.actionNumber)).size, actions.length, 'Duplicate historical action numbers')
  for (const action of actions) assert.ok(Number.isFinite(Date.parse(action.timeActual)), `Missing historical action time: ${action.actionNumber}`)
  const ordered = [...actions].sort((a, b) => a.orderNumber - b.orderNumber)
  orderedCache.set(payload, ordered)
  return ordered
}

export function gameEndTime(actions) {
  const end = actions.filter(action => action.actionType === 'game' && action.subType === 'end').at(-1)
  assert.ok(end, 'Historical game-end event is required')
  return Date.parse(end.timeActual)
}

export function snapshot(box, playbyplay, at, withCourt = true, summary = null) {
  assert.equal(playbyplay.game.gameId, box.game.gameId)
  const cutoff = Date.parse(at)
  assert.ok(Number.isFinite(cutoff))
  const ordered = orderedActions(playbyplay)
  const sequence = withCourt ? courtSequence(box, ordered, summary) : { actions: ordered, removed: [], reassigned: [] }
  const allActions = sequence.actions
  const actions = allActions.filter(action => Date.parse(action.timeActual) <= cutoff)
  const court = withCourt ? courtTime(box, allActions, actions) : null
  const players = new Map()
  const game = structuredClone(box.game)
  const teams = [game.homeTeam, game.awayTeam]
  for (const team of teams) {
    delete team.statistics
    delete team.periods
    delete team.timeoutsRemaining
    delete team.inBonus
    for (const player of team.players) {
      player.statistics = Object.fromEntries(countingStats.map(key => [key, 0]))
      const time = court?.get(player.personId)
      player.statistics.minutes = minutesIso(time?.seconds ?? 0)
      player.statistics.plusMinusPoints = (time?.plus ?? 0) - (time?.minus ?? 0)
      player.statistics.plus = time?.plus ?? 0
      player.statistics.minus = time?.minus ?? 0
      player.played = player.starter === '1' && actions.length ? '1' : '0'
      player.oncourt = time?.oncourt ?? '0'
      if (time) player.played = time.played
      players.set(player.personId, player)
    }
  }
  const add = (id, stat, value = 1) => {
    if (!id) return
    assert.ok(players.has(id), `Play-by-play references an unknown player: ${id}`)
    players.get(id).statistics[stat] += value
  }
  const set = (id, stat, value) => {
    if (id && value != null) {
      assert.ok(Number.isFinite(value), `Invalid historical ${stat}`)
      assert.ok(players.has(id), `Play-by-play references an unknown player: ${id}`)
      players.get(id).statistics[stat] = value
    }
  }
  for (const action of actions) {
    const id = action.personId
    if (id && players.has(id) && (['2pt', '3pt', 'rebound', 'steal', 'block', 'turnover', 'freethrow'].includes(action.actionType) || (action.actionType === 'substitution' && action.subType === 'in'))) players.get(id).played = '1'
    if (['2pt', '3pt'].includes(action.actionType)) {
      add(id, 'fieldGoalsAttempted')
      if (action.actionType === '3pt') add(id, 'threePointersAttempted')
      if (action.shotResult === 'Made') {
        add(id, 'fieldGoalsMade')
        if (action.actionType === '3pt') add(id, 'threePointersMade')
      }
    }
    if (action.actionType === 'freethrow') {
      add(id, 'freeThrowsAttempted')
      if (action.shotResult === 'Made') add(id, 'freeThrowsMade')
    }
    if (action.actionType === 'steal') add(id, 'steals')
    if (action.actionType === 'block') add(id, 'blocks')
    set(id, 'points', action.pointsTotal)
    set(id, 'reboundsTotal', action.reboundTotal)
    set(id, 'reboundsDefensive', action.reboundDefensiveTotal)
    set(id, 'reboundsOffensive', action.reboundOffensiveTotal)
    set(id, 'turnovers', action.turnoverTotal)
    set(id, 'foulsPersonal', action.foulPersonalTotal)
    set(action.assistPersonId, 'assists', action.assistTotal)
  }
  const last = actions.at(-1)
  game.gameStatus = actions.length ? 2 : 1
  game.gameStatusText = last ? `Q${last.period} ${last.clock}` : 'Scheduled'
  game.period = last?.period ?? 0
  game.gameClock = last?.clock ?? 'PT12M00.00S'
  game.homeTeam.score = Number(last?.scoreHome ?? 0)
  game.awayTeam.score = Number(last?.scoreAway ?? 0)
  delete game.duration
  delete game.attendance
  delete game.sellout
  return {
    meta: { provenance: 'REAL-DERIVED', sources: [`boxscore-${game.gameId}`, `playbyplay-${game.gameId}`], at, limitations: ['Final corrected play-by-play is time-sliced; original live revisions are unavailable.', 'Minutes and plus-minus derive from PBP substitutions, period starters, clocks, and scores.'], removedConflictingSubstitutions: sequence.removed, reassignedSubstitutions: sequence.reassigned, finalMinuteConflicts: sequence.minuteEvidence ?? [], lastAction: last?.actionNumber ?? null },
    game,
  }
}

export function compareFinalCounts(box, playbyplay) {
  const all = orderedActions(playbyplay)
  const at = new Date(Math.max(...all.map(action => Date.parse(action.timeActual)))).toISOString()
  const derived = snapshot(box, playbyplay, at, false)
  const differences = []
  for (const side of ['homeTeam', 'awayTeam']) {
    if (derived.game[side].score !== box.game[side].score) differences.push({ side, field: 'score', expected: box.game[side].score, actual: derived.game[side].score })
    for (const expected of box.game[side].players) {
      const actual = derived.game[side].players.find(player => player.personId === expected.personId)
      for (const field of countingStats) {
        if (actual.statistics[field] !== expected.statistics[field]) differences.push({ player: expected.personId, name: expected.name, field, expected: expected.statistics[field], actual: actual.statistics[field] })
      }
    }
  }
  return differences
}
