import { strict as assert } from 'node:assert'
import { parseSleeperProjections, SleeperProjectionParseError } from './parser.ts'

const fixture = JSON.parse(await Deno.readTextFile(new URL('./fixtures/week-2026-1.json', import.meta.url)))
const nextWeek = JSON.parse(await Deno.readTextFile(new URL('./fixtures/week-2026-2.json', import.meta.url)))
const context = { seasonYear: 2027, sleeperWeek: 1, weekStart: '2026-10-19', weekEnd: '2026-10-25' }
const secondContext = { ...context, sleeperWeek: 2, weekStart: '2026-10-26', weekEnd: '2026-11-01' }

Deno.test('parses two complete recorded real weeks without rejecting rows', () => {
  for (const [body, scope] of [[fixture, context], [nextWeek, secondContext]] as const) {
    const result = parseSleeperProjections(body, scope)
    assert.ok(body.length > 1000)
    assert.equal(result.rows.length, body.length)
    assert.equal(result.inputRowCount, body.length)
    assert.equal(result.rejectedRowCount, 0)
  }
})

Deno.test('empty stats and missing or zero gp project a sit with every stored stat zero', () => {
  const sit = fixture.find((row: { player_id: string; date: string }) => row.player_id === '1946' && row.date === '2026-10-20')
  assert.deepEqual(sit.stats, {})
  for (const stats of [sit.stats, { pts: 20, sp: 100 }, { gp: 0, pts: 20, sp: 100, fga: 'unused for a sit' }]) {
    const result = parseSleeperProjections([{ ...sit, stats }], context)
    assert.ok(Object.values(result.rows[0].stats).every((stat) => stat === 0))
    assert.equal(result.rejectedRowCount, 0)
  }
})

Deno.test('omitted zero keys stay zero and unused derived keys are ignored', () => {
  const omitted = nextWeek.find((row: { player_id: string; date: string }) => row.player_id === '1541' && row.date === '2026-10-26')
  assert.equal(omitted.stats.tpm, undefined)
  const parsed = parseSleeperProjections([omitted], secondContext).rows[0]
  assert.equal(parsed.stats.tpm, 0)
  const bothMissing = { ...omitted, stats: { ...omitted.stats } }
  delete bothMissing.stats.tpa
  bothMissing.stats.fgmi = -0.02
  bothMissing.stats.unknown = 'ignored'
  assert.equal(parseSleeperProjections([bothMissing], secondContext).rows[0].stats.tpa, 0)
})

Deno.test('recorded rounding differences raise attempts to makes', () => {
  const rounded = nextWeek.find((row: { player_id: string; date: string }) => row.player_id === '4913' && row.date === '2026-10-28')
  assert.equal(rounded.stats.fgm, 0.67)
  assert.equal(rounded.stats.fga, 0.65)
  assert.equal(rounded.stats.fgmi, -0.02)
  const parsed = parseSleeperProjections([rounded], secondContext).rows[0]
  assert.equal(parsed.stats.fga, 0.67)
  const allMakes = parseSleeperProjections([{ ...rounded, stats: { gp: 1, fgm: 0.67, fga: 0.65, ftm: 0.12, fta: 0.1, tpm: 0.05, tpa: 0.04 } }], secondContext).rows[0]
  assert.equal(allMakes.stats.fta, 0.12)
  assert.equal(allMakes.stats.tpa, 0.05)
})

Deno.test('skips isolated malformed rows and counts duplicates and exactly twenty percent invalid', () => {
  const valid = fixture.slice(0, 4)
  for (const change of [
    { player_id: '' }, { player_id: 'bad' }, { game_id: 123 }, { date: '2026-10-26' },
    { date: '2026-02-30' }, { week: 2 }, { season: '2027' }, { player: {} }, { last_modified: 'today' },
    { stats: { gp: 1, pts: '14' } }, { stats: { gp: 1, ftm: -1 } }, { stats: { gp: 1, dd: Number.NaN } },
  ]) {
    const result = parseSleeperProjections([...valid, { ...valid[0], ...change }], context)
    assert.equal(result.rows.length, 4)
    assert.equal(result.rejectedRowCount, 1)
    assert.equal(result.inputRowCount, 5)
  }
  assert.equal(parseSleeperProjections([...valid, valid[0]], context).rejectedRowCount, 1)
})

Deno.test('fails invalid bodies, zero valid rows, and more than twenty percent invalid', () => {
  for (const value of [null, {}, { error: 'unavailable' }, [], [{ ...fixture[0], player_id: '' }]]) {
    assert.throws(() => parseSleeperProjections(value, context), SleeperProjectionParseError)
  }
  assert.throws(() => parseSleeperProjections([...fixture.slice(0, 3), fixture[0]], context), (error) => {
    assert.ok(error instanceof SleeperProjectionParseError)
    assert.equal(error.inputRowCount, 4)
    assert.equal(error.rejectedRowCount, 1)
    return true
  })
})
