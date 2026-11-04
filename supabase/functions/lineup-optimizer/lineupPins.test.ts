import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { tipoffAssignments, type TipoffContext } from './preTipoff.ts'
import { chooseAutoSetAssignments } from './assignments.ts'

type Player = TipoffContext['players'][number] & { lineupPin?: 'start' | 'bench' | null; projected: number }
const player = (playerId: string, projected: number, overrides: Partial<Player> = {}): Player => ({
  playerId, projected, eligiblePositions: ['PG'], injuryStatus: null, locked: false,
  hasGame: true, lineupPin: null, ...overrides,
})
function solve(players: Player[], slots = ['PG'], stored: TipoffContext['stored'] = []) {
  return tipoffAssignments({ date: '2099-01-02', seasonYear: 2099, weekNumber: 1, players, stored,
    templates: slots.map(slotType => ({ slotType, count: 1 })),
  }, players.map(p => ({ player_id: p.playerId, projection_fantasy_points: p.projected })))
}
const ids = (rows: ReturnType<typeof solve>) => rows.map(row => row.player_id).sort()

Deno.test('Start pin beats higher projection', () => {
  assert.deepEqual(ids(solve([player('pin', 1, { lineupPin: 'start' }), player('auto', 100)])), ['pin'])
})
Deno.test('excess Start pins keep the highest projected legal players', () => {
  assert.deepEqual(ids(solve([player('low', 1, { lineupPin: 'start' }), player('high', 20, { lineupPin: 'start' }), player('auto', 100)])), ['high'])
})
for (const [name, overrides] of Object.entries<Partial<Player>>({
  Out: { injuryStatus: 'Out' }, IR: { injuryStatus: 'IR' }, 'no game': { hasGame: false },
  postponed: { hasGame: false, gameTime: null },
})) {
  Deno.test(`${name} Start pin yields to a healthy player`, () => {
    assert.deepEqual(ids(solve([player('pin', 100, { lineupPin: 'start', ...overrides }), player('auto', 1)])), ['auto'])
  })
}
Deno.test('Out Start pin stays when no replacement can fill its slot', () => {
  assert.deepEqual(ids(solve([player('pin', 100, { lineupPin: 'start', injuryStatus: 'Out' })])), ['pin'])
})
for (const injuryStatus of ['Questionable', 'Doubtful']) {
  Deno.test(`${injuryStatus} Start pin stays`, () => {
    assert.deepEqual(ids(solve([player('pin', 1, { lineupPin: 'start', injuryStatus }), player('auto', 100)])), ['pin'])
  })
}
Deno.test('Bench pin sits behind every unpinned fallback', () => {
  for (const fallback of [{}, { injuryStatus: 'Out' }, { hasGame: false }, { injuryStatus: 'IR', hasGame: false }]) {
    assert.deepEqual(ids(solve([player('bench', 100, { lineupPin: 'bench' }), player('auto', -10, fallback)])), ['auto'])
  }
})
Deno.test('Bench pin fills a slot only when every non-Bench player is assigned or ineligible', () => {
  assert.deepEqual(ids(solve([player('bench', 100, { lineupPin: 'bench' }), player('auto', 1)], ['PG', 'UTIL'])), ['auto', 'bench'])
  assert.deepEqual(ids(solve([player('bench', 100, { lineupPin: 'bench' }), player('auto', 1, { eligiblePositions: ['C'] })])), ['bench'])
})
Deno.test('Bench penalty precedes Start count across flexible slots', () => {
  const rows = solve([player('pin', 1, { lineupPin: 'start', eligiblePositions: ['PG', 'C'] }),
    player('auto', 1), player('bench', 100, { lineupPin: 'bench', eligiblePositions: ['C'] })], ['PG', 'C'])
  assert.deepEqual(ids(rows), ['auto', 'pin'])
  assert.equal(rows.find(row => row.player_id === 'pin')?.slot_type, 'C')
})
Deno.test('locked pinned starters and bench players never move', () => {
  const rows = solve([player('locked', 0, { lineupPin: 'bench', locked: true }),
    player('benched', 100, { lineupPin: 'start', locked: true }), player('auto', 1)], ['PG', 'UTIL'],
  [{ player_id: 'locked', slot_type: 'PG', is_auto_set: false, week_number: 1, locked: true }])
  assert.deepEqual(ids(rows), ['auto', 'locked'])
  assert.equal(rows.find(row => row.player_id === 'locked')?.slot_type, 'PG')
})
Deno.test('no-pin assignments match the original deterministic corpus', () => {
  let seed = 107
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  const results = Array.from({ length: 100 }, (_, trial) => {
    const positions = ['PG', 'SG', 'SF', 'PF', 'C']
    const players = Array.from({ length: 12 }, (_, i) => ({ playerId: `${trial}-${i}`,
      eligiblePositions: positions.filter(() => random() > 0.55), projected: Math.floor(random() * 60) - 10,
      avoidInLineup: random() < 0.2, hasGame: random() > 0.2,
      gameTime: random() < 0.5 ? '2099-01-02T21:00:00Z' : '2099-01-03T02:00:00Z',
    }))
    return chooseAutoSetAssignments(['PG', 'C', 'F', 'UTIL'], players, p => p.hasGame)
  })
  assert.equal(createHash('sha256').update(JSON.stringify(results)).digest('hex'), 'b91f86c1c3f009ac29d2cd820b201bccca00022620bc9bb06be631e1a78adc98')
})
