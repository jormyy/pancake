import { strict as assert } from 'node:assert'
import { parseSleeperProjections } from './parser.ts'

const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/week-2026-1.json', import.meta.url)))
const context = { seasonYear: 2027, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }

Deno.test('parses recorded per-game makes, attempts, seconds, and fractional bonuses', () => {
  const rows = parseSleeperProjections(fixture, context)
  assert.equal(rows.length, 3)
  assert.equal(rows[1].stats.fga, 11.02)
  assert.equal(rows[1].stats.dd, 0.15)
  assert.equal(rows[0].stats.sp, 300)
})

Deno.test('rejects malformed or wrong-season responses as a whole', () => {
  for (const value of [null, {}, [], { error: 'unavailable' }, [...fixture, fixture[0]]]) {
    assert.throws(() => parseSleeperProjections(value, context))
  }
  for (const change of [
    { date: '2026-10-26' }, { date: '2026-02-30' }, { season: '2027' }, { week: 2 },
    { company: 'unknown' }, { last_modified: 'today' }, { game_id: '' }, { player: {} },
    { stats: { ...fixture[0].stats, fga: undefined } }, { stats: { ...fixture[0].stats, pts: '14' } },
    { stats: { ...fixture[0].stats, ftm: -1 } }, { stats: { ...fixture[0].stats, fgm: 999 } },
    { stats: { ...fixture[0].stats, gp: 2 } }, { stats: { ...fixture[0].stats, dd: Number.NaN } },
  ]) assert.throws(() => parseSleeperProjections([fixture[0], { ...fixture[1], ...change }], context))
})
