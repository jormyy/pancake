import { toETDate } from '../_shared/date.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { processPreTipoff } = await import('./preTipoff.ts')
const { processDaily } = await import('./daily.ts')
const { processEnabledLineupOptimizers } = await import('./run.ts')
const { withWorkContext } = await import('../_shared/workContext.ts')

const today = toETDate(new Date())
const future = new Date(Date.now() + 3_600_000).toISOString()
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }

const context = () => ({
  date: today, seasonYear: 2027, weekNumber: 1,
  templates: [{ slotType: 'PG', count: 1 }],
  players: [{ playerId: 'p1', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true }],
  stored: [],
})
const projections = [{ player_id: 'p1', projection_fantasy_points: 10 }]

type PendingMember = { league_id: string; league_season_id: string; member_id: string; auto_ir?: boolean }
type Fixture = {
  ir: () => Response
  pendingStarters?: () => PendingMember[]
  pendingAutoIr?: () => PendingMember[]
  onIr?: () => void
}

function installFetch(config: Fixture) {
  const original = globalThis.fetch
  const log: string[] = []
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const name = url.pathname.split('/').at(-1) ?? ''
    log.push(name)
    if (url.pathname.includes('/rest/v1/rpc/')) {
      if (name === 'auto_manage_ir_service' || name === 'auto_manage_ir_tipoff_service') {
        config.onIr?.()
        return config.ir()
      }
      if (name === 'claim_lineup_tipoff_dispatch') return Response.json(today)
      if (name === 'get_pending_tipoff_members') {
        const body = await request.json().catch(() => ({}))
        const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
        const rows = config.pendingStarters ? config.pendingStarters() : []
        return Response.json(rows.filter((row) => !excluded.includes(row.member_id)))
      }
      if (name === 'get_pending_auto_ir_members') {
        const body = await request.json().catch(() => ({}))
        const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
        const rows = config.pendingAutoIr ? config.pendingAutoIr() : []
        return Response.json(rows.filter((row) => !excluded.includes(row.member_id)))
      }
      if (name === 'get_pre_tipoff_lineup_context') return Response.json(context())
      if (name === 'get_league_projection_rows') return Response.json(projections)
      if (name === 'apply_pre_tipoff_lineup') return Response.json(true)
      if (name === 'apply_daily_lineup') return Response.json(true)
      if (name === 'mark_tipoff_ir_member_done') return Response.json(true)
      if (name === 'record_pre_tipoff_lineup_failure') return Response.json(null)
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
          : Response.json([{ enabled: true }])
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
  return { restore: () => { globalThis.fetch = original }, log }
}

function manualMember() {
  return [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }]
}

function starterMember() {
  return [{ league_id: 'league', league_season_id: 'season', member_id: 'member', auto_ir: true }]
}

Deno.test('a plain-text 503 on the manual IR path retries and completes', async () => {
  let irCalls = 0
  let marked = 0
  let recorded = 0
  const finishes: Record<string, unknown>[] = []
  const fixture = installFetch({
    ir: () => {
      irCalls++
      return irCalls === 1
        ? new Response('Service Unavailable', { status: 503 })
        : Response.json({ moves: [{ kind: 'designate', designatePlayerId: 'injured' }], skipped: [], notices: [] })
    },
    pendingAutoIr: () => marked > 0 ? [] : manualMember(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    if (name === 'finish_lineup_tipoff_dispatch') {
      finishes.push(await new Request(input, init).json())
      return Response.json(null)
    }
    return original(input, init)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(irCalls === 2, `the 503 was not retried: ${irCalls}`)
    assert(marked === 1, 'the recovered IR move was not marked done')
    assert(recorded === 0, 'a retryable 503 wrote a durable receipt')
    assert(result.failed === 0 && !result.batchFailed, 'a recovered 503 failed the dispatch')
    assert(!('p_error' in finishes[0]), 'a recovered 503 recorded a dispatch error')
  } finally { fixture.restore() }
})

Deno.test('a structured JSON 500 on the Auto Lineup path retries and sets starters', async () => {
  let irCalls = 0
  let applies = 0
  const fixture = installFetch({
    ir: () => {
      irCalls++
      return irCalls === 1
        ? Response.json({ code: 'XX000', message: 'upstream unavailable' }, { status: 500 })
        : Response.json({ moves: [], skipped: [], notices: [] })
    },
    pendingStarters: () => applies > 0 ? [] : starterMember(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'apply_pre_tipoff_lineup') { applies++; return Response.json(true) }
    return original(input, init)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(irCalls === 2, `the structured 500 was not retried: ${irCalls}`)
    assert(applies === 1, 'the Auto Lineup member did not set starters after the retry')
    assert(result.optimized === 1 && result.failed === 0 && !result.batchFailed, 'a recovered 500 failed the dispatch')
  } finally { fixture.restore() }
})

for (const status of [429, 504]) {
  Deno.test(`a ${status} on the manual IR path retries and completes`, async () => {
    let irCalls = 0
    let marked = 0
    let recorded = 0
    const fixture = installFetch({
      ir: () => {
        irCalls++
        return irCalls === 1
          ? new Response(status === 429 ? 'Too Many Requests' : 'Gateway Timeout', { status })
          : Response.json({ moves: [], skipped: [], notices: [] })
      },
      pendingAutoIr: () => marked > 0 ? [] : manualMember(),
    })
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
      if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
      if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
      return original(input, init)
    }
    try {
      const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
      assert(irCalls === 2, `the ${status} was not retried: ${irCalls}`)
      assert(marked === 1 && recorded === 0, `the ${status} was receipted instead of retried`)
      assert(result.failed === 0 && !result.batchFailed, `a recovered ${status} failed the dispatch`)
    } finally { fixture.restore() }
  })
}

Deno.test('exhausted 503s stay retryable and a fresh same-revision run completes', async () => {
  let irCalls = 0
  let marked = 0
  let recorded = 0
  let healthy = false
  const finishes: Record<string, unknown>[] = []
  const fixture = installFetch({
    ir: () => {
      irCalls++
      return healthy
        ? Response.json({ moves: [{ kind: 'designate', designatePlayerId: 'injured' }], skipped: [], notices: [] })
        : new Response('Service Unavailable', { status: 503 })
    },
    pendingAutoIr: () => marked > 0 ? [] : manualMember(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    if (name === 'finish_lineup_tipoff_dispatch') {
      finishes.push(await new Request(input, init).json())
      return Response.json(null)
    }
    return original(input, init)
  }
  try {
    const first = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(irCalls === 5, `the exhausted 503 was not retried five times: ${irCalls}`)
    assert(recorded === 0, 'an exhausted 503 wrote a durable receipt')
    assert(first.failed === 1 && first.batchFailed, 'an exhausted 503 finished the dispatch as successful')
    assert(typeof finishes[0].p_error === 'string', 'the failed dispatch did not record its error')
    healthy = true
    const second = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(irCalls === 6 && marked === 1, 'a fresh same-revision run did not retry and complete')
    assert(second.failed === 0 && !second.batchFailed && !('p_error' in finishes[1]), 'the retried dispatch did not finish cleanly')
  } finally { fixture.restore() }
})

Deno.test('an abort after a 503 never becomes a completion receipt', async () => {
  const controller = new AbortController()
  let irCalls = 0
  let marked = 0
  let recorded = 0
  const fixture = installFetch({
    ir: () => {
      irCalls++
      controller.abort(new Error('work aborted'))
      return new Response('Service Unavailable', { status: 503 })
    },
    pendingAutoIr: () => manualMember(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    return original(input, init)
  }
  try {
    const result = await withWorkContext({ signal: controller.signal }, () =>
      processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' }))
    assert(irCalls === 1, `the aborted run made ${irCalls} IR calls`)
    assert(marked === 0 && recorded === 0, 'an aborted run wrote a completion or failure receipt')
    assert(result.batchFailed, 'an aborted run finished the dispatch as successful')
  } finally { fixture.restore() }
})

Deno.test('an ambiguous 503 after a committed IR move never produces a second move', async () => {
  let irCalls = 0
  let committed = false
  let moves = 0
  let marked = 0
  const fixture = installFetch({
    ir: () => {
      irCalls++
      if (!committed) {
        committed = true
        moves++
        return new Response('Service Unavailable', { status: 503 })
      }
      return Response.json({ moves: [], skipped: [], notices: [] })
    },
    pendingAutoIr: () => marked > 0 ? [] : manualMember(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    return original(input, init)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(irCalls === 2, `the ambiguous response was not retried: ${irCalls}`)
    assert(moves === 1, `the retry produced a second IR move: ${moves}`)
    assert(marked === 1 && result.failed === 0 && !result.batchFailed, 'the committed move was not completed')
  } finally { fixture.restore() }
})

Deno.test('a 4xx validation refusal stays a permanent member failure', async () => {
  let irCalls = 0
  let recorded = 0
  const fixture = installFetch({
    ir: () => {
      irCalls++
      return Response.json({ code: 'P0001', message: 'Auto IR management exceeded the IR capacity.' }, { status: 400 })
    },
    pendingAutoIr: () => recorded > 0 ? [] : manualMember(),
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    return original(input, init)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: future, token: 'fixture' })
    assert(irCalls === 1, 'a 4xx validation refusal was retried')
    assert(recorded === 1, 'a 4xx validation refusal did not write its receipt')
    assert(result.failed === 1 && !result.batchFailed, 'a 4xx validation refusal failed the batch')
  } finally { fixture.restore() }
})

Deno.test('an unrelated league keeps the legacy swallow-and-continue IR path', async () => {
  let irCalls = 0
  let applies = 0
  const fixture = installFetch({
    ir: () => {
      irCalls++
      return new Response('Service Unavailable', { status: 503 })
    },
  })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'auto_set_lineup_service_atomic') { applies++; return Response.json(null) }
    return original(input, init)
  }
  try {
    const result = await processEnabledLineupOptimizers(today)
    assert(irCalls === 1, `the legacy path made ${irCalls} IR calls`)
    assert(applies === 1, 'the legacy path skipped the lineup write after a 503')
    assert(result.optimized === 1 && result.failed === 0, 'the legacy path changed behavior after a 503')
  } finally { fixture.restore() }
})

Deno.test('the daily path treats a 503 as retryable and recovers on the next run', async () => {
  let irCalls = 0
  let healthy = false
  const fixture = installFetch({
    ir: () => {
      irCalls++
      return healthy
        ? Response.json({ moves: [], skipped: [], notices: [] })
        : new Response('Service Unavailable', { status: 503 })
    },
    pendingAutoIr: () => [{ league_id: 'league', league_season_id: 'season', member_id: 'member' }],
  })
  try {
    let threw = false
    try { await processDaily({ date: today }) } catch { threw = true }
    assert(threw, 'the daily path hid a retryable 503 as a permanent member failure')
    healthy = true
    const second = await processDaily({ date: today })
    assert(irCalls === 2, `the daily path did not retry on the next run: ${irCalls}`)
    assert(second.failed === 0, 'the recovered daily run still reported a failure')
  } finally { fixture.restore() }
})
