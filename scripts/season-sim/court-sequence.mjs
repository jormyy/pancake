import assert from 'node:assert/strict'
import { courtTime } from './court.mjs'

const cache = new WeakMap()
const seconds = value => {
  const match = /^PT(\d+)M([\d.]+)S$/.exec(value)
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN
}

export function courtSequence(box, actions, summary = null) {
  const cached = cache.get(box)
  if (cached?.source === actions) return cached.result
  try {
    courtTime(box, actions, actions)
    const result = { actions, removed: [], reassigned: [] }
    cache.set(box, { source: actions, result })
    return result
  } catch (original) {
    const players = [box.game.homeTeam, box.game.awayTeam].flatMap(team => team.players)
    const duration = actions.reduce((max, action) => Math.max(max, action.period), 0) <= 4 ? 2880 : 2880 + (Math.max(...actions.map(action => action.period)) - 4) * 300
    const inconsistent = [box.game.homeTeam, box.game.awayTeam].filter(team => Math.abs(team.players.reduce((sum, p) => sum + seconds(p.statistics.minutes), 0) - duration * 5) > 2).flatMap(team => team.players)
    const name = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const references = (summary?.boxscore?.players ?? []).flatMap(team => team.statistics.flatMap(stat => stat.athletes.map(row => ({ name: row.athlete.displayName, minutes: row.stats[stat.names.indexOf('MIN')] }))))
    const minuteEvidence = inconsistent.flatMap(player => {
      const reference = references.filter(row => name(row.name) === name(player.name))
      if (reference.length !== 1 || !/^\d+$/.test(reference[0].minutes)) return []
      const expected = Number(reference[0].minutes) * 60
      if (Math.abs(seconds(player.statistics.minutes) - expected) <= 30.5) return []
      return [{ personId: player.personId, nbaMinutes: player.statistics.minutes, espnRoundedMinutes: reference[0].minutes, seconds: expected, tolerance: 30.5 }]
    })
    const previous = new Map(), candidates = new Set(), groups = new Map()
    for (const action of actions.filter(action => action.actionType === 'substitution')) {
      const group = `${action.period}:${action.teamId}:${action.clock}`
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(action)
      const key = `${action.period}:${action.personId}`
      const prior = previous.get(key)
      if (prior?.subType === action.subType) {
        candidates.add(prior.group)
        candidates.add(group)
      }
      previous.set(key, { subType: action.subType, group })
    }
    const options = [...candidates].map(key => groups.get(key)).filter(group => group.filter(action => action.subType === 'out').length === group.filter(action => action.subType === 'in').length)
    assert.ok(options.length <= 12, `No bounded unique substitution repair: ${box.game.gameId}: ${original.message}`)
    const matches = []
    const matchesMinutes = revised => {
      const result = courtTime(box, revised, revised)
      return players.every(player => {
        const evidence = minuteEvidence.find(row => row.personId === player.personId)
        return Math.abs(result.get(player.personId).seconds - (evidence?.seconds ?? seconds(player.statistics.minutes))) <= (evidence?.tolerance ?? 1.1)
      })
    }
    for (let mask = 1; mask < 2 ** options.length; mask++) {
      const removed = new Set(options.flatMap((group, index) => mask & 2 ** index ? group.map(action => action.actionNumber) : []))
      if (matches.length && removed.size > matches[0].removed.length) continue
      const revised = actions.filter(action => !removed.has(action.actionNumber))
      try {
        if (!matchesMinutes(revised)) continue
        if (matches.length && removed.size < matches[0].removed.length) matches.length = 0
        matches.push({ actions: revised, removed: [...removed].sort((a, b) => a - b), reassigned: [] })
      } catch {}
    }
    if (!matches.length) {
      const failed = /Substitution out absent player: \S+ (\d+)/.exec(original.message)
      const event = actions.find(action => action.actionNumber === Number(failed?.[1]))
      const team = [box.game.homeTeam, box.game.awayTeam].find(team => team.players.some(player => player.personId === event?.personId))
      for (const player of team?.players ?? []) {
        if (player.personId === event.personId) continue
        const revised = actions.map(action => action === event ? { ...action, personId: player.personId } : action)
        try {
          if (matchesMinutes(revised)) matches.push({ actions: revised, removed: [], reassigned: [{ actionNumber: event.actionNumber, original: event.personId, replacement: player.personId }] })
        } catch {}
      }
    }
    assert.equal(matches.length, 1, `No unique final-minute-supported substitution repair: ${box.game.gameId}: ${original.message}`)
    const result = { ...matches[0], minuteEvidence }
    cache.set(box, { source: actions, result })
    return result
  }
}
