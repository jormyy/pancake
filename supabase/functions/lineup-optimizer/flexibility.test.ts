import assert from 'node:assert/strict'
import { chooseAutoSetAssignments } from './assignments.ts'
import { LINEUP_SLOT_ALLOWED_POSITIONS } from '../_shared/lineupSlots.ts'

const early = '2026-11-04T00:00:00Z'
const late = '2026-11-04T03:00:00Z'
const player = (playerId: string, eligiblePositions: string[], projected: number, gameTime: string | null = early) => ({
  playerId, eligiblePositions, projected, gameTime, avoidInLineup: false, hasGame: true,
})
const assignment = (playerId: string, slotType: string) => ({ playerId, slotType })
const solve = (slots: string[], players: ReturnType<typeof player>[], stored: ReturnType<typeof assignment>[] = []) =>
  chooseAutoSetAssignments(slots, players, p => p.hasGame, stored)

Deno.test('early tipoffs leave UTIL available even when stored slots favor the reverse', () => {
  const players = [player('a-late', ['PG'], 30, late), player('z-early', ['PG'], 40)]
  const stored = [assignment('a-late', 'PG'), assignment('z-early', 'UTIL')]
  assert.deepEqual(solve(['PG', 'UTIL'], players, stored), [assignment('a-late', 'UTIL'), assignment('z-early', 'PG')])
})

Deno.test('an early multi-position player preserves the slots needed by later bench alternatives', () => {
  const players = [player('early-flex', ['PG', 'SF'], 50), player('late-flex', ['PG', 'SF'], 40, late), player('bench', ['PG'], 10, late)]
  const result = solve(['PG', 'SF'], players, [assignment('early-flex', 'PG'), assignment('late-flex', 'SF')])
  assert.deepEqual(result, [assignment('early-flex', 'SF'), assignment('late-flex', 'PG')])
  const remaining = players.filter(p => p.playerId !== 'early-flex' && p.playerId !== 'late-flex')
  assert.deepEqual(solve(['PG'], remaining), [assignment('bench', 'PG')])
})

Deno.test('global matching preserves higher scoring lineups across multi-position conflicts', () => {
  const players = [player('flex', ['PG', 'SF'], 50), player('guard', ['PG'], 40, late), player('forward', ['SF'], 5, late)]
  assert.deepEqual(solve(['PG', 'SF'], players), [assignment('flex', 'SF'), assignment('guard', 'PG')])
})

Deno.test('later unknown tipoffs preserve flexible slots and input permutations remain deterministic', () => {
  const players = [player('a-tbd', ['PG'], 30, null), player('z-early', ['PG'], 40)]
  const result = [assignment('a-tbd', 'UTIL'), assignment('z-early', 'PG')]
  for (const roster of [players, [...players].reverse()]) {
    for (const slots of [['PG', 'UTIL'], ['UTIL', 'PG']]) {
      assert.deepEqual(solve(slots, roster), result)
      assert.deepEqual(solve(slots, roster, result), result)
    }
  }
})

Deno.test('simultaneous tipoffs preserve existing assignments', () => {
  const players = [player('a', ['PG'], 30), player('b', ['PG'], 40)]
  const stored = [assignment('a', 'UTIL'), assignment('b', 'PG')]
  assert.deepEqual(solve(['PG', 'UTIL'], players, stored), stored)
})

Deno.test('playing projections outrank flexibility, names, inactive status and no-game fallbacks', () => {
  const dunn = player('dunn-fixture', ['PG'], 15)
  const harden = player('harden-fixture', ['PG'], 35, late)
  assert.deepEqual(solve(['PG'], [dunn, harden]), [assignment('harden-fixture', 'PG')])
  dunn.projected = 40
  assert.deepEqual(solve(['PG'], [dunn, harden]), [assignment('dunn-fixture', 'PG')])
  dunn.avoidInLineup = true
  assert.deepEqual(solve(['PG'], [dunn, harden]), [assignment('harden-fixture', 'PG')])
  harden.hasGame = false
  assert.equal(solve(['PG'], [harden]).length, 1)
  assert.equal(solve(['PG'], [dunn]).length, 1)
})

Deno.test('the solver matches exhaustive primary and future-option objectives across 200 conflicting rosters', () => {
  let seed = 291
  const random = () => (seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296
  const positions = ['PG', 'SG', 'SF', 'PF', 'C']
  const times = [early, '2026-11-04T01:00:00Z', late, null]
  const slots = ['PG', 'G', 'F', 'UTIL']
  const allowed = (slot: string, p: ReturnType<typeof player>) =>
    (LINEUP_SLOT_ALLOWED_POSITIONS[slot as keyof typeof LINEUP_SLOT_ALLOWED_POSITIONS] as readonly string[])
      .some(position => p.eligiblePositions.includes(position))
  const compare = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i]
    return 0
  }
  for (let trial = 0; trial < 200; trial++) {
    const roster = Array.from({ length: 6 }, (_, i) => ({
      ...player(String(i), positions.filter(() => random() < 0.4), Math.floor(random() * 25) - 5, times[Math.floor(random() * times.length)]),
      hasGame: random() < 0.8, avoidInLineup: random() < 0.2,
    }))
    const tip = (p: ReturnType<typeof player>) => p.hasGame && p.gameTime ? Date.parse(p.gameTime) : Infinity
    const cutoffs = [...new Set(roster.map(tip).filter(Number.isFinite))].sort((a, b) => a - b)
      .filter(time => roster.some(p => p.hasGame && !p.avoidInLineup && tip(p) > time))
    const score = (entries: ReturnType<typeof assignment>[]) => {
      const playing = entries.map(entry => roster.find(p => p.playerId === entry.playerId)!)
        .filter(p => p.hasGame && !p.avoidInLineup)
      return [entries.length, playing.reduce((sum, p) => sum + p.projected, 0), playing.length,
        ...cutoffs.flatMap(time => {
          const locked = entries.filter(entry => tip(roster.find(p => p.playerId === entry.playerId)!) <= time)
          const future = roster.filter(p => p.hasGame && !p.avoidInLineup && tip(p) > time)
          return [-locked.reduce((sum, entry) => sum + future.filter(p => allowed(entry.slotType, p)).length, 0),
            -locked.reduce((sum, entry) => sum + LINEUP_SLOT_ALLOWED_POSITIONS[entry.slotType as keyof typeof LINEUP_SLOT_ALLOWED_POSITIONS].length, 0)]
        })]
    }
    let optimum = score([])
    const search = (index: number, entries: ReturnType<typeof assignment>[]) => {
      if (index === slots.length) {
        const value = score(entries)
        if (compare(value, optimum) > 0) optimum = value
        return
      }
      search(index + 1, entries)
      for (const p of roster) {
        if (entries.some(entry => entry.playerId === p.playerId) || !allowed(slots[index], p)) continue
        search(index + 1, [...entries, assignment(p.playerId, slots[index])])
      }
    }
    search(0, [])
    const result = solve(slots, roster)
    assert.deepEqual(score(result), optimum, `trial ${trial}`)
    assert.equal(new Set(result.map(entry => entry.playerId)).size, result.length)
    for (const entry of result) assert(allowed(entry.slotType, roster.find(p => p.playerId === entry.playerId)!))
    assert.deepEqual(solve([...slots].reverse(), [...roster].reverse()), result)
    assert.deepEqual(solve(slots, roster, result), result)
  }
})
