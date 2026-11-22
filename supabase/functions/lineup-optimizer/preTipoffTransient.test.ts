Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { processPreTipoff } = await import('./preTipoff.ts')

const today = '2026-10-14'
const future = new Date(Date.now() + 3_600_000).toISOString()
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }

type Member = { league_id: string; league_season_id: string; member_id: string; auto_ir?: boolean }
type Body = Record<string, unknown>

const context = () => ({
  date: today, seasonYear: 2027, weekNumber: 1,
  templates: [{ slotType: 'PG', count: 1 }],
  players: [
    { playerId: 'p1', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'locked', eligiblePositions: ['PG'], injuryStatus: null, locked: true, hasGame: true },
  ],
  stored: [{ player_id: 'locked', slot_type: 'PG', is_auto_set: false, week_number: 1, locked: true }],
})
const projections = [{ player_id: 'p1', projection_fantasy_points: 10 }]
const member = (memberId: string, autoIr = false): Member =>
  ({ league_id: 'league', league_season_id: 'season', member_id: memberId, ...(autoIr ? { auto_ir: true } : {}) })

type Plan = {
  pendingStarters?: () => Member[]
  pendingAutoIr?: () => Member[]
  context?: () => Response
  projections?: () => Response
  apply?: (body: Body) => Response
  mark?: (body: Body) => Response
  record?: (body: Body) => Response
  finish?: (body: Body) => Response
  ir?: () => Response
}

function installFetch(plan: Plan) {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const name = new URL(request.url).pathname.split('/').at(-1) ?? ''
    if (!new URL(request.url).pathname.includes('/rest/v1/rpc/')) throw new Error(`Unexpected request ${name}`)
    const body = await request.json().catch(() => ({})) as Body
    const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members as string[] : []
    switch (name) {
      case 'claim_lineup_tipoff_dispatch': return Response.json(today)
      case 'get_pending_tipoff_members':
        return Response.json((plan.pendingStarters?.() ?? []).filter((row) => !excluded.includes(row.member_id)))
      case 'get_pending_auto_ir_members':
        return Response.json((plan.pendingAutoIr?.() ?? []).filter((row) => !excluded.includes(row.member_id)))
      case 'get_pre_tipoff_lineup_context': return plan.context?.() ?? Response.json(context())
      case 'get_league_projection_rows': return plan.projections?.() ?? Response.json(projections)
      case 'apply_pre_tipoff_lineup': return plan.apply?.(body) ?? Response.json(true)
      case 'mark_tipoff_ir_member_done': return plan.mark?.(body) ?? Response.json(true)
      case 'record_pre_tipoff_lineup_failure': return plan.record?.(body) ?? Response.json(null)
      case 'finish_lineup_tipoff_dispatch': return plan.finish?.(body) ?? Response.json(null)
      case 'auto_manage_ir_tipoff_service': return plan.ir?.() ?? Response.json({ moves: [], skipped: [], notices: [] })
      default: throw new Error(`Unexpected RPC ${name}`)
    }
  }
  return { restore: () => { globalThis.fetch = original } }
}

const unavailable = () => Response.json({ code: 'XX000', message: 'upstream unavailable' }, { status: 503 })

Deno.test('a 503 on apply_pre_tipoff_lineup retries and completes without a receipt', async () => {
  let applies = 0
  let recorded = 0
  const fixture = installFetch({
    pendingStarters: () => applies > 0 ? [] : [member('member')],
    apply: () => { applies++; return applies === 1 ? unavailable() : Response.json(true) },
    record: () => { recorded++; return Response.json(null) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(applies === 2, `the 503 was not retried: ${applies}`)
    assert(recorded === 0, 'a retryable 503 wrote a durable receipt')
    assert(result.optimized === 1 && result.failed === 0 && !result.batchFailed, 'a recovered 503 failed the dispatch')
  } finally { fixture.restore() }
})

Deno.test('exhausted 503s on apply stay retryable and a later attempt completes', async () => {
  let applies = 0
  let recorded = 0
  let healthy = false
  const finishes: Body[] = []
  const fixture = installFetch({
    pendingStarters: () => applies >= 6 ? [] : [member('member')],
    apply: () => { applies++; return healthy ? Response.json(true) : unavailable() },
    record: () => { recorded++; return Response.json(null) },
    finish: (body) => { finishes.push(body); return Response.json(null) },
  })
  try {
    const first = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(applies === 5, `the exhausted 503 was not retried five times: ${applies}`)
    assert(recorded === 0, 'an exhausted 503 wrote a durable receipt')
    assert(first.failed === 1 && first.batchFailed, 'an exhausted 503 finished the dispatch as successful')
    assert(typeof finishes[0].p_error === 'string', 'the failed dispatch did not record its error')
    healthy = true
    const second = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(applies === 6 && second.optimized === 1, 'a later attempt did not complete the member')
    assert(second.failed === 0 && !second.batchFailed && !('p_error' in finishes[1]), 'the retried dispatch did not finish cleanly')
  } finally { fixture.restore() }
})

Deno.test('a permanent 400 on apply still writes its receipt', async () => {
  let applies = 0
  let recorded = 0
  const fixture = installFetch({
    pendingStarters: () => recorded > 0 ? [] : [member('member')],
    apply: () => {
      applies++
      return Response.json({ code: 'PA004', message: 'Locked by trade 50917d7c.' }, { status: 400 })
    },
    record: () => { recorded++; return Response.json(null) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(applies === 1, 'a permanent 400 was retried')
    assert(recorded === 1, 'a permanent 400 did not write its receipt')
    assert(result.failed === 1 && !result.batchFailed, 'a permanent 400 failed the batch')
  } finally { fixture.restore() }
})

Deno.test('a sibling member succeeds while another member apply is transient', async () => {
  let flaky = 0
  let good = 0
  let recorded = 0
  const fixture = installFetch({
    pendingStarters: () => flaky === 0 || good === 0 ? [member('good'), member('flaky')] : [],
    apply: (body) => {
      if (body.p_member_id === 'flaky') { flaky++; return unavailable() }
      good++
      return Response.json(true)
    },
    record: () => { recorded++; return Response.json(null) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(good === 1, `the sibling member did not apply: ${good}`)
    assert(flaky === 5, `the transient member was not retried five times: ${flaky}`)
    assert(recorded === 0, 'the transient member wrote a durable receipt')
    assert(result.optimized === 1 && result.failed === 1 && result.batchFailed, 'the batch outcome is wrong')
  } finally { fixture.restore() }
})

Deno.test('a retry after a lost committed apply keeps the game lock and does not duplicate it', async () => {
  let applies = 0
  let recorded = 0
  const committed: Body[][] = []
  const fixture = installFetch({
    pendingStarters: () => applies > 0 ? [] : [member('member')],
    apply: (body) => {
      applies++
      const assignments = body.p_assignments as Body[]
      if (applies === 1) {
        committed.push(assignments)
        return unavailable()
      }
      return Response.json(false)
    },
    record: () => { recorded++; return Response.json(null) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(applies === 2, `the lost response was not retried: ${applies}`)
    assert(committed.length === 1, 'the committed apply was duplicated')
    assert(committed[0].some((row) => row.player_id === 'locked'), 'the retry dropped the game lock')
    assert(recorded === 0, 'a lost committed apply wrote a durable receipt')
    assert(result.optimized === 0 && result.failed === 0 && !result.batchFailed, 'the retried apply failed the dispatch')
  } finally { fixture.restore() }
})

Deno.test('a 503 on mark_tipoff_ir_member_done retries and completes', async () => {
  let marks = 0
  let marked = 0
  let recorded = 0
  const fixture = installFetch({
    pendingAutoIr: () => marked > 0 ? [] : [member('manual')],
    mark: () => {
      marks++
      if (marks === 1) return unavailable()
      marked++
      return Response.json(true)
    },
    record: () => { recorded++; return Response.json(null) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(marks === 2, `the 503 was not retried: ${marks}`)
    assert(marked === 1 && recorded === 0, 'a retryable 503 wrote a receipt')
    assert(result.failed === 0 && !result.batchFailed, 'a recovered 503 failed the dispatch')
  } finally { fixture.restore() }
})

Deno.test('a 503 on get_pre_tipoff_lineup_context retries and completes', async () => {
  let reads = 0
  let applies = 0
  const fixture = installFetch({
    pendingStarters: () => applies > 0 ? [] : [member('member')],
    context: () => { reads++; return reads === 1 ? unavailable() : Response.json(context()) },
    apply: () => { applies++; return Response.json(true) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(reads === 2, `the 503 was not retried: ${reads}`)
    assert(result.optimized === 1 && result.failed === 0 && !result.batchFailed, 'a recovered 503 failed the dispatch')
  } finally { fixture.restore() }
})

Deno.test('a 503 on the projection read retries and completes', async () => {
  let reads = 0
  let applies = 0
  const fixture = installFetch({
    pendingStarters: () => applies > 0 ? [] : [member('member')],
    projections: () => { reads++; return reads === 1 ? unavailable() : Response.json(projections) },
    apply: () => { applies++; return Response.json(true) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(reads === 2, `the 503 was not retried: ${reads}`)
    assert(result.optimized === 1 && result.failed === 0 && !result.batchFailed, 'a recovered 503 failed the dispatch')
  } finally { fixture.restore() }
})

Deno.test('a PGRST003 pool timeout on apply retries and completes', async () => {
  let applies = 0
  let recorded = 0
  const fixture = installFetch({
    pendingStarters: () => applies > 0 ? [] : [member('member')],
    apply: () => {
      applies++
      return applies === 1
        ? Response.json({ code: 'PGRST003', message: 'Timed out acquiring connection from connection pool' }, { status: 500 })
        : Response.json(true)
    },
    record: () => { recorded++; return Response.json(null) },
  })
  try {
    const result = await processPreTipoff({ tipoffAt: future, token: 'fixture' })
    assert(applies === 2, `the pool timeout was not retried: ${applies}`)
    assert(recorded === 0, 'a pool timeout wrote a durable receipt')
    assert(result.optimized === 1 && result.failed === 0 && !result.batchFailed, 'a recovered pool timeout failed the dispatch')
  } finally { fixture.restore() }
})
