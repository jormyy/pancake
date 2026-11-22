import { toETDate } from '../_shared/date.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { processEnabledLineupOptimizers, processManualRestOfSeason } = await import('./run.ts')
const { processDaily } = await import('./daily.ts')
const { processPreTipoff } = await import('./preTipoff.ts')

const today = toETDate(new Date())
const future = new Date(Date.now() + 3_600_000).toISOString()
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }

type Call = { name: string; method: string; search: string }

const irOutcome = {
  moves: [{ kind: 'designate', designatePlayerId: 'p2' }],
  skipped: [{ playerId: 'p3', reason: 'game_locked' }],
  notices: [{ playerId: 'p2', playerName: 'Injured Star', reason: 'ir_choice_uncertain', action: 'Choose who moves to IR' }],
}

function installFetch(config: { log: Call[]; ir?: () => Response; settingEnabled?: boolean }) {
  const original = globalThis.fetch
  let tipoffBatches = 0
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const name = url.pathname.split('/').at(-1) ?? ''
    config.log.push({ name, method: request.method, search: url.search })
    if (url.pathname.includes('/rest/v1/rpc/')) {
      if (name === 'auto_manage_ir_service') return config.ir ? config.ir() : Response.json(irOutcome)
      if (name === 'get_league_projection_rows') {
        return Response.json([{ player_id: 'p1', projection_fantasy_points: 10, projection_source: 'fixture', projection_source_label: 'Fixture', projection_view: 'today' }])
      }
      if (name === 'auto_set_lineup_service_atomic') return Response.json(null)
      if (name === 'get_pre_tipoff_lineup_context') {
        return Response.json({
          date: today, seasonYear: 2027, weekNumber: 1,
          templates: [{ slotType: 'PG', count: 1 }],
          players: [{ playerId: 'p1', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true }],
          stored: [],
        })
      }
      if (name === 'apply_daily_lineup') return Response.json(true)
      if (name === 'claim_lineup_tipoff_dispatch') return Response.json(today)
      if (name === 'get_pending_tipoff_members') {
        return Response.json(tipoffBatches++ === 0
          ? [{ league_id: 'league', league_season_id: 'season', member_id: 'member' }]
          : [])
      }
      if (name === 'get_pending_auto_ir_members') return Response.json([])
      if (name === 'apply_pre_tipoff_lineup') return Response.json(true)
      if (name === 'finish_lineup_tipoff_dispatch') return Response.json(null)
      throw new Error(`Unexpected RPC ${name}`)
    }
    if (request.method === 'PATCH') return new Response(null, { status: 204 })
    switch (name) {
      case 'nba_games':
        if (url.searchParams.get('offset') && url.searchParams.get('offset') !== '0') return Response.json([])
        return Response.json([{
          season_year: 2027, game_date: today, home_team: 'AAA', away_team: 'BBB',
          status: 'Scheduled', game_status_text: null, game_time: future, started_at: null,
        }])
      case 'season_weeks':
        return Response.json([{ season_year: 2027, week_number: 1, week_start: today, week_end: today }])
      case 'lineup_optimizer_settings':
        return url.searchParams.get('select')?.includes('season')
          ? Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'member', last_optimized_at: null, last_daily_optimized_date: null }])
          : Response.json([{ enabled: config.settingEnabled ?? true }])
      case 'leagues':
        return Response.json({ status: 'active' })
      case 'league_seasons':
        return Response.json({ season_year: 2027, is_current: true })
      case 'roster_players':
        return Response.json(url.searchParams.get('select') === 'player_id'
          ? [{ player_id: 'p1' }]
          : [{ player_id: 'p1', players: { position: 'PG', eligible_positions: ['PG'], nba_team: 'AAA', injury_status: null } }])
      case 'lineup_slot_templates':
        return Response.json([{ slot_type: 'PG', slot_count: 1 }])
      case 'weekly_lineups':
        return Response.json([])
      case 'lineup_player_pins':
        return Response.json([])
      default:
        throw new Error(`Unexpected request ${name}`)
    }
  }
  return () => { globalThis.fetch = original }
}

function assertIrBefore(log: Call[], rosterCall: string) {
  const irCalls = log.filter((call) => call.name === 'auto_manage_ir_service')
  assert(irCalls.length === 1, `IR boundary called ${irCalls.length} times`)
  const irIndex = log.findIndex((call) => call.name === 'auto_manage_ir_service')
  const rosterIndex = log.findIndex((call) => call.name === rosterCall)
  assert(rosterIndex > irIndex, `IR boundary ran after ${rosterCall}`)
}

Deno.test('enabled background run manages IR once per member before loading the roster', async () => {
  const log: Call[] = []
  const restore = installFetch({ log })
  try {
    const result = await processEnabledLineupOptimizers(today)
    assert(result.optimized === 1 && result.failed === 0, `unexpected result ${JSON.stringify(result)}`)
    assertIrBefore(log, 'roster_players')
  } finally { restore() }
})

Deno.test('daily mode manages IR once per member before loading the lineup context', async () => {
  const log: Call[] = []
  const restore = installFetch({ log })
  try {
    const result = await processDaily({ date: today })
    assert(result.optimized === 1 && result.failed === 0, `unexpected result ${JSON.stringify(result)}`)
    assertIrBefore(log, 'get_pre_tipoff_lineup_context')
  } finally { restore() }
})

Deno.test('manual run manages IR before the roster and returns moves and notices', async () => {
  const log: Call[] = []
  const restore = installFetch({ log })
  try {
    const result = await processManualRestOfSeason({
      mode: 'rest_of_season', leagueId: 'league', leagueSeasonId: 'season', memberId: 'member',
    })
    assert(result.optimized === 1, `unexpected result ${JSON.stringify(result)}`)
    assertIrBefore(log, 'roster_players')
    assert(JSON.stringify(result.ir) === JSON.stringify({ moves: irOutcome.moves, notices: irOutcome.notices }),
      `manual response lost the IR outcome: ${JSON.stringify(result.ir)}`)
  } finally { restore() }
})

Deno.test('manual run skips IR management when the member setting is disabled', async () => {
  const log: Call[] = []
  const restore = installFetch({ log, settingEnabled: false })
  try {
    const result = await processManualRestOfSeason({
      mode: 'rest_of_season', leagueId: 'league', leagueSeasonId: 'season', memberId: 'member',
    })
    assert(result.optimized === 1, `unexpected result ${JSON.stringify(result)}`)
    assert(!log.some((call) => call.name === 'auto_manage_ir_service'), 'disabled manual run managed IR')
    assert(JSON.stringify(result.ir) === JSON.stringify({ moves: [], notices: [] }), 'disabled manual run reported IR work')
  } finally { restore() }
})

Deno.test('pre-tipoff mode never manages IR for leagues without the policy', async () => {
  const log: Call[] = []
  const restore = installFetch({ log })
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(result.optimized === 1 && result.failed === 0, `unexpected result ${JSON.stringify(result)}`)
    assert(!log.some((call) => call.name === 'auto_manage_ir_service'), 'pre-tipoff managed IR')
  } finally { restore() }
})

Deno.test('an IR boundary error is logged and the lineup step still writes', async () => {
  const log: Call[] = []
  const restore = installFetch({
    log,
    ir: () => Response.json({ code: 'XX000', message: 'IR boundary unavailable' }, { status: 500 }),
  })
  try {
    const result = await processEnabledLineupOptimizers(today)
    assert(result.optimized === 1 && result.failed === 0, `IR failure blocked the lineup: ${JSON.stringify(result)}`)
    assert(log.some((call) => call.name === 'auto_set_lineup_service_atomic'), 'lineup write was skipped')
  } finally { restore() }
})
