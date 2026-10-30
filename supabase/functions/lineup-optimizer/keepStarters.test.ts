import type { TipoffContext } from './preTipoff.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { tipoffAssignments, processPreTipoff } = await import('./preTipoff.ts')
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }
const fixture = JSON.parse(await Deno.readTextFile(new URL('../../../tests/fixtures/autoset-michael.json', import.meta.url)))

for (const day of fixture.days) {
  Deno.test(`Michael ${day.date} keeps every eligible starting slot filled`, () => {
    const teams = new Set(day.games.flatMap((game: { homeTeam: string; awayTeam: string }) => [game.homeTeam, game.awayTeam]))
    const context: TipoffContext = {
      date: day.date, seasonYear: fixture.member.season_year, weekNumber: day.weekNumber,
      templates: fixture.templates, stored: day.stored,
      players: fixture.roster.filter((p: { isOnIr: boolean; isOnTaxi: boolean }) => !p.isOnIr && !p.isOnTaxi)
        .map((p: { nbaTeam: string }) => ({ ...p, locked: false, hasGame: teams.has(p.nbaTeam) })),
    }
    const result = tipoffAssignments(context, day.projections)
    const count = context.templates.reduce((sum, template) => sum + template.count, 0)
    assert(result.length === count, `Only ${result.length}/${count} starting slots filled.`)
    assert(new Set(result.map(entry => entry.player_id)).size === count, 'A player fills multiple slots.')
    context.stored = result.map(entry => ({ ...entry, locked: false }))
    assert(JSON.stringify(tipoffAssignments(context, day.projections)) === JSON.stringify(result), 'A repeated auto-set changes the lineup.')
  })
}

Deno.test('a no-game starter stays beside locked starters and locked bench players', () => {
  const context: TipoffContext = {
    date: '2026-10-29', seasonYear: 2027, weekNumber: 1,
    templates: [{ slotType: 'PG', count: 1 }, { slotType: 'PF', count: 1 }, { slotType: 'UTIL', count: 1 }],
    stored: [
      { player_id: 'locked', slot_type: 'PG', is_auto_set: false, week_number: 1, locked: true },
      { player_id: 'resting', slot_type: 'PF', is_auto_set: false, week_number: 1, locked: false },
    ],
    players: [
      { playerId: 'locked', eligiblePositions: ['PG'], injuryStatus: 'Out', locked: true, hasGame: true },
      { playerId: 'resting', eligiblePositions: ['PF'], injuryStatus: null, locked: false, hasGame: false },
      { playerId: 'bench-locked', eligiblePositions: ['C'], injuryStatus: null, locked: true, hasGame: true },
      { playerId: 'fallback', eligiblePositions: ['C'], injuryStatus: null, locked: false, hasGame: false },
    ],
  }
  const result = tipoffAssignments(context, [])
  assert(result.length === 3 && result.some(entry => entry.player_id === 'resting' && entry.slot_type === 'PF'), 'A resting starter is removed.')
  assert(result.some(entry => entry.player_id === 'locked' && entry.slot_type === 'PG') && !result.some(entry => entry.player_id === 'bench-locked'), 'A locked player moves.')
  assert(result.filter(entry => 'expected_active' in entry).every(entry => entry.expected_active === false), 'Fallback requests active-game validation.')
})

Deno.test('the Edge worker submits intentional no-game fallbacks through apply', async () => {
  const original = globalThis.fetch
  let batches = 0, applied = false
  const context: TipoffContext = { date: '2026-10-29', seasonYear: 2027, weekNumber: 1,
    templates: [{ slotType: 'PF', count: 1 }],
    stored: [{ player_id: 'resting', slot_type: 'PF', is_auto_set: false, week_number: 1, locked: false }],
    players: [{ playerId: 'resting', eligiblePositions: ['PF'], injuryStatus: null, locked: false, hasGame: false }],
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const name = new URL(request.url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context.date)
    if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? [{ league_id: 'league', league_season_id: 'season', member_id: 'member' }] : [])
    if (name === 'get_pre_tipoff_lineup_context') return Response.json(context)
    if (name === 'get_league_projection_rows') return Response.json([])
    if (name === 'apply_pre_tipoff_lineup') {
      const { p_assignments } = await request.json()
      assert(p_assignments.length === 1 && p_assignments[0].player_id === 'resting' && p_assignments[0].expected_active === false, 'Worker empties PF or treats a fallback as active.')
      applied = true
      return Response.json(true)
    }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ tipoffAt: new Date(Date.now() + 60_000).toISOString(), token: 'fixture' })
    assert(applied && result.optimized === 1 && result.failed === 0, 'Edge fallback write fails.')
  } finally { globalThis.fetch = original }
})
