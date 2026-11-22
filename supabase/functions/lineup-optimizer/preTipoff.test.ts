import type { TipoffContext } from './preTipoff.ts'

Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { tipoffAssignments, processPreTipoff } = await import('./preTipoff.ts')
const { withWorkContext } = await import('../_shared/workContext.ts')

const context = (): TipoffContext => ({
  date: '2026-10-14', seasonYear: 2027, weekNumber: 1,
  templates: [{ slotType: 'PG', count: 1 }, { slotType: 'UTIL', count: 1 }],
  players: [
    { playerId: 'a', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'b', eligiblePositions: ['PG', 'SG'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'c', eligiblePositions: ['C'], injuryStatus: null, locked: false, hasGame: true },
    { playerId: 'd', eligiblePositions: ['C'], injuryStatus: null, locked: false, hasGame: true },
  ], stored: [],
})
const projections = [
  { player_id: 'a', projection_fantasy_points: 50 },
  { player_id: 'b', projection_fantasy_points: 40 },
  { player_id: 'c', projection_fantasy_points: 30 },
]
const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }

Deno.test('late injury benches an unlocked Out starter and uses fresh projections', () => {
  const c = context()
  const initial = tipoffAssignments(c, projections)
  c.stored = initial.map((entry) => ({ ...entry, locked: false }))
  c.players[0].injuryStatus = 'Out'
  const result = tipoffAssignments(c, [...projections, { player_id: 'd', projection_fantasy_points: 100 }])
  assert(!result.some((row) => row.player_id === 'a') && result.some((row) => row.player_id === 'b'), 'Late Out stays in lineup.')
  assert(result.some((row) => row.player_id === 'd') && !result.some((row) => row.player_id === 'c'), 'Fresh projection does not change the starter.')
  c.players.forEach((p) => { p.injuryStatus = 'Out' })
  assert(tipoffAssignments(c, projections).length === 2, 'Eligible zero-point fallback slots remain empty.')
})

Deno.test('staggered games preserve a locked starter declared Out and leave locked bench players benched', () => {
  const c = context()
  c.stored = [{ player_id: 'a', slot_type: 'PG', is_auto_set: false, week_number: 1, locked: true }]
  c.players[0].locked = true
  c.players[0].injuryStatus = 'Out'
  c.players[1].locked = true
  const result = tipoffAssignments(c, projections)
  assert(JSON.stringify(result[0]) === JSON.stringify({ player_id: 'a', slot_type: 'PG', is_auto_set: false, week_number: 1 }), 'Locked Out starter moves.')
  assert(!result.some((row) => row.player_id === 'b') && result.some((row) => row.player_id === 'c'), 'Locked bench player starts.')
})

Deno.test('early specialist assignment keeps a later center replacement legal after a late guard is Out', () => {
  const c = context()
  c.players = [
    { playerId: 'early', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true, gameTime: '2026-11-04T00:00:00Z' },
    { playerId: 'late', eligiblePositions: ['PG'], injuryStatus: null, locked: false, hasGame: true, gameTime: '2026-11-04T03:00:00Z' },
    { playerId: 'replacement', eligiblePositions: ['C'], injuryStatus: null, locked: false, hasGame: true, gameTime: '2026-11-04T03:00:00Z' },
  ]
  c.stored = [
    { player_id: 'early', slot_type: 'UTIL', is_auto_set: false, week_number: 1, locked: false },
    { player_id: 'late', slot_type: 'PG', is_auto_set: false, week_number: 1, locked: false },
  ]
  const points = [{ player_id: 'early', projection_fantasy_points: 50 }, { player_id: 'late', projection_fantasy_points: 45 },
    { player_id: 'replacement', projection_fantasy_points: 40 }]
  const first = tipoffAssignments(c, points)
  assert(first.some(row => row.player_id === 'early' && row.slot_type === 'PG'), 'Early guard consumes UTIL.')
  c.stored = first.map(entry => ({ ...entry, locked: entry.player_id === 'early' }))
  c.players[0].locked = true
  c.players[1].injuryStatus = 'Out'
  const next = tipoffAssignments(c, points)
  assert(next.some(row => row.player_id === 'early' && row.slot_type === 'PG'), 'Early lock moves.')
  assert(next.some(row => row.player_id === 'replacement' && row.slot_type === 'UTIL'), 'Later replacement loses its legal slot.')
  assert(!next.some(row => row.player_id === 'late'), 'Unlocked Out guard displaces the healthy center.')
})

Deno.test('departed locked starters keep their slots', () => {
  const c = context()
  c.stored = [{ player_id: 'departed', slot_type: 'PG', is_auto_set: true, week_number: 1, locked: true }]
  const result = tipoffAssignments(c, projections)
  assert(result[0].player_id === 'departed' && result.filter((row) => row.slot_type === 'PG').length === 1, 'Departed lock loses its slot.')
})

Deno.test('multi-position eligibility fills PG SG SF PF C G F and UTIL without duplicates', () => {
  const c = context()
  const slots = ['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F', 'UTIL']
  c.templates = slots.map((slotType) => ({ slotType, count: 1 }))
  const eligibility = [['PG', 'SF'], ['SG'], ['SF'], ['PF', 'C'], ['C'], ['PG', 'SG'], ['SF', 'PF'], ['C']]
  c.players = eligibility.map((eligiblePositions, i) => ({ playerId: String(i), eligiblePositions, locked: false, injuryStatus: null, hasGame: true }))
  const result = tipoffAssignments(c, c.players.map((p, i) => ({ player_id: p.playerId, projection_fantasy_points: 10 + i })))
  assert(result.length === 8 && new Set(result.map((row) => row.player_id)).size === 8, 'Eligible slots remain empty or reuse players.')
  for (const row of result) {
    const allowed = row.slot_type === 'UTIL' ? ['PG', 'SG', 'SF', 'PF', 'C'] : row.slot_type === 'G' ? ['PG', 'SG'] : row.slot_type === 'F' ? ['SF', 'PF'] : [row.slot_type]
    assert(c.players.find((p) => p.playerId === row.player_id)!.eligiblePositions.some((pos) => allowed.includes(pos)), 'Ineligible assignment.')
  }
})

Deno.test('postponed games cannot supply new starters and identical retries keep assignments', () => {
  const c = context()
  c.players[0].hasGame = false
  const first = tipoffAssignments(c, projections)
  assert(!first.some((row) => row.player_id === 'a'), 'Postponed player starts.')
  c.stored = first.map((entry) => ({ ...entry, locked: false }))
  assert(JSON.stringify(tipoffAssignments(c, projections)) === JSON.stringify(first), 'Retry changes assignments.')
})


Deno.test('negative projections still fill eligible starting slots', () => {
  const c = context()
  const result = tipoffAssignments(c, c.players.map((p) => ({ player_id: p.playerId, projection_fantasy_points: -10 })))
  assert(result.length === 2, 'Auto-set empties eligible slots for negative projections.')
})


Deno.test('missing season weeks fail instead of certifying an unprocessed team', () => {
  const c = context()
  c.weekNumber = null
  let failed = false
  try { tipoffAssignments(c, projections) } catch { failed = true }
  assert(failed, 'Missing calendar context silently succeeds.')
})

Deno.test('zero, null, and absent projections fill eligible open starter slots', () => {
  const c = context()
  c.templates = ['PG', 'G', 'C', 'UTIL'].map((slotType) => ({ slotType, count: 1 }))
  for (const scores of [[], [{ player_id: 'a', projection_fantasy_points: 0 }], [
    { player_id: 'a', projection_fantasy_points: null },
    { player_id: 'b', projection_fantasy_points: 40 },
  ]]) {
    const result = tipoffAssignments(c, scores)
    assert(result.length === 4 && new Set(result.map((row) => row.player_id)).size === 4, 'A healthy playing player with no positive projection remains benched beside an empty eligible slot.')
  }
})

Deno.test('a started player without a stored lineup row stays benched at a later tipoff', () => {
  const c = context()
  c.players[0].locked = true
  const result = tipoffAssignments(c, projections)
  assert(!result.some((row) => row.player_id === 'a'), 'A started bench player enters the lineup.')
  assert(c.stored.length === 0 && result.length === 2, 'A started bench player prevents legal unlocked assignments.')
})

Deno.test('teams sharing one tipoff claim do not submit competing apply transactions', async () => {
  const original = globalThis.fetch
  let batches = 0
  let active = 0
  let maximum = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? Array.from({ length: 3 }, (_, i) => ({ league_id: 'league', league_season_id: 'season', member_id: `member-${i}` })) : [])
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'get_pre_tipoff_lineup_context') return Response.json(context())
    if (name === 'get_league_projection_rows') return Response.json(projections)
    if (name === 'apply_pre_tipoff_lineup') {
      active++
      maximum = Math.max(maximum, active)
      const conflict = active > 1
      await new Promise(resolve => setTimeout(resolve, 30))
      active--
      return conflict ? Response.json({ code: '55P03', message: 'canceling statement due to lock timeout' }, { status: 500 }) : Response.json(true)
    }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(result.failed === 0 && result.optimized === 3, 'A shared tipoff claim fails teams under its own parallel writes.')
    assert(maximum === 1, 'Apply calls compete for the same dispatch row.')
  } finally { globalThis.fetch = original }
})

for (const code of ['55P03', '40P01', '40001', '57014', 'fetch_timeout', '23514', 'persistent']) {
  Deno.test(`tipoff ${code} errors preserve fresh injury guards and bounded failures`, async () => {
    const original = globalThis.fetch
    let batches = 0
    let reads = 0
    let applies = 0
    let recorded = 0
    const transient = !['23514', 'persistent'].includes(code)
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      const name = new URL(req.url).pathname.split('/').at(-1)
      if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
      if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? [{ league_id: 'league', league_season_id: 'season', member_id: 'member' }] : [])
      if (name === 'get_pending_auto_ir_members') return Response.json([])
      if (name === 'get_pre_tipoff_lineup_context') {
        const fresh = context()
        if (reads++ > 0) fresh.players[0].injuryStatus = 'Out'
        return Response.json(fresh)
      }
      if (name === 'get_league_projection_rows') return Response.json(projections)
      if (name === 'apply_pre_tipoff_lineup') {
        applies++
        if (applies === 1 || !transient) return Response.json({ code: code === 'persistent' ? '55P03' : code === 'fetch_timeout' ? '' : code, message: code === 'fetch_timeout' ? 'FetchError: TimeoutError: Signal timed out.' : 'write conflict' }, { status: 500 })
        const body = await req.json()
        assert(!body.p_assignments.some((row: { player_id: string }) => row.player_id === 'a'), 'Retry reuses the injured starter from stale context.')
        return Response.json(true)
      }
      if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
      if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
      throw new Error(`Unexpected RPC ${name}`)
    }
    try {
      const result = await processPreTipoff({ tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
      assert(applies === (transient ? 2 : code === 'persistent' ? 5 : 1), 'Retry count does not match the transient error budget.')
      assert(reads === applies, 'A retry does not load current lineup context.')
      assert(result.optimized === (transient ? 1 : 0) && result.failed === (transient ? 0 : 1), 'A transient conflict fails or a permanent failure is hidden.')
      assert(recorded === (code === '23514' ? 1 : 0), 'Only a permanent failure writes a durable receipt.')
      assert(result.batchFailed === (code === 'persistent'), 'Only an exhausted transient failure fails the batch.')
    } finally { globalThis.fetch = original }
  })
}

Deno.test('exhausted transient IR failure stays retryable and a later attempt performs the move', async () => {
  const original = globalThis.fetch
  let locked = true
  let irCalls = 0
  let recorded = 0
  let marked = 0
  const finishes: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
      return Response.json(excluded.includes('manual') || marked > 0
        ? []
        : [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      return locked
        ? Response.json({ code: '55P03', message: 'canceling statement due to lock timeout' }, { status: 500 })
        : Response.json({ moves: [{ kind: 'designate', designatePlayerId: 'injured' }], skipped: [], notices: [] })
    }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') { finishes.push(body); return Response.json(true) }
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const tipoffAt = new Date(Date.now() + 60000).toISOString()
    const first = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt, token: 'fixture' })
    assert(irCalls === 5, 'The transient IR failure is not retried five times.')
    assert(recorded === 0, 'A transient IR failure wrote a durable receipt.')
    assert(first.failed === 1 && first.batchFailed, 'A transient IR failure finished the dispatch as successful.')
    assert(typeof finishes[0].p_error === 'string', 'The failed dispatch did not record its error.')
    locked = false
    const second = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt, token: 'fixture' })
    assert(irCalls === 6 && marked === 1, 'A later attempt with unchanged inputs did not perform the IR move.')
    assert(second.failed === 0 && !second.batchFailed && !('p_error' in finishes[1]), 'The retried dispatch did not finish cleanly.')
  } finally { globalThis.fetch = original }
})

Deno.test('a returned transient IR skip fails the dispatch instead of receipting it', async () => {
  const original = globalThis.fetch
  let locked = true
  let irCalls = 0
  let marked = 0
  const finishes: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
      return Response.json(excluded.includes('manual') || marked > 0
        ? []
        : [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      return locked
        ? Response.json({ moves: [], skipped: [{ playerId: 'injured', reason: 'canceling statement due to lock timeout', sqlstate: '55P03' }], notices: [] })
        : Response.json({ moves: [{ kind: 'designate', designatePlayerId: 'injured' }], skipped: [], notices: [] })
    }
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') { finishes.push(body); return Response.json(true) }
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const tipoffAt = new Date(Date.now() + 60000).toISOString()
    const first = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt, token: 'fixture' })
    assert(irCalls === 5, 'A returned transient IR skip is not retried.')
    assert(marked === 0, 'A returned transient IR skip wrote a tipoff receipt.')
    assert(first.failed === 1 && first.batchFailed, 'A returned transient IR skip finished the dispatch as successful.')
    assert(typeof finishes[0].p_error === 'string', 'The failed dispatch did not record its error.')
    locked = false
    const second = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt, token: 'fixture' })
    assert(irCalls === 6 && marked === 1, 'A later attempt with unchanged inputs did not perform the IR move.')
    assert(second.failed === 0 && !second.batchFailed && !('p_error' in finishes[1]), 'The retried dispatch did not finish cleanly.')
  } finally { globalThis.fetch = original }
})

Deno.test('an ordinary IR skip completes the dispatch without a retry', async () => {
  const original = globalThis.fetch
  let irCalls = 0
  let marked = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
      return Response.json(excluded.includes('manual') || marked > 0
        ? []
        : [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      return Response.json({ moves: [], skipped: [{ playerId: 'injured', reason: 'Auto IR management exceeded the IR capacity.', sqlstate: 'P0001' }], notices: [] })
    }
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(irCalls === 1, 'An ordinary IR skip was retried.')
    assert(marked === 1, 'An ordinary IR skip did not receipt the member.')
    assert(result.failed === 0 && !result.batchFailed, 'An ordinary IR skip failed the dispatch.')
  } finally { globalThis.fetch = original }
})

Deno.test('tipoff retries stop before another write when the work lease is lost', async () => {
  const original = globalThis.fetch
  let batches = 0
  let applies = 0
  globalThis.fetch = async (input, init) => {
    const name = new URL(new Request(input, init).url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json(batches++ === 0 ? ['first', 'second'].map(member_id => ({ league_id: 'league', league_season_id: 'season', member_id })) : [])
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'get_pre_tipoff_lineup_context') return Response.json(context())
    if (name === 'get_league_projection_rows') return Response.json(projections)
    if (name === 'apply_pre_tipoff_lineup') {
      applies++
      return Response.json({ code: '55P03', message: 'write conflict' }, { status: 500 })
    }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await withWorkContext({ signal: new AbortController().signal, renewLease: () => Promise.reject(new Error('Work lease lost')) }, () => processPreTipoff({ tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' }))
    assert(applies === 1 && result.optimized === 0 && result.failed === 1, 'The optimizer writes again after losing its work lease.')
    assert(result.errors.includes('Work lease lost'), 'The work lease failure is not reported.')
    assert(result.batchFailed, 'Lease loss must remain retryable.')
  } finally { globalThis.fetch = original }
})

for (const recordFails of [false, true]) {
  Deno.test(`member failure is isolated and durable; failure receipt unavailable=${recordFails}`, async () => {
    const original = globalThis.fetch
    let batches = 0
    const applied: string[] = []
    const recorded: Record<string, unknown>[] = []
    let finish: Record<string, unknown> = {}
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      const name = new URL(req.url).pathname.split('/').at(-1)
      const body = await req.json()
      if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
      if (name === 'get_pending_tipoff_members') {
        if (batches++ > 0) assert(JSON.stringify(body.p_excluded_members) === '["bad"]', 'The failed member repeats in the same invocation.')
        return Response.json(batches === 1 ? ['first', 'bad', 'last'].map(member_id => ({ league_id: 'league', league_season_id: 'season', member_id })) : [])
      }
      if (name === 'get_pending_auto_ir_members') return Response.json([])
      if (name === 'get_pre_tipoff_lineup_context') return Response.json(context())
      if (name === 'get_league_projection_rows') return Response.json(projections)
      if (name === 'apply_pre_tipoff_lineup') {
        applied.push(body.p_member_id)
        return body.p_member_id === 'bad'
          ? Response.json({ code: 'PA004', message: 'Locked by trade 50917d7c. Cancel the trade to change this asset.' }, { status: 400 })
          : Response.json(true)
      }
      if (name === 'record_pre_tipoff_lineup_failure') {
        recorded.push(body)
        return recordFails ? Response.json({ code: '40001', message: 'Tipoff claim is no longer current.' }, { status: 409 }) : Response.json(null)
      }
      if (name === 'finish_lineup_tipoff_dispatch') { finish = body; return Response.json(null) }
      throw new Error(`Unexpected RPC ${name}`)
    }
    try {
      const tipoffAt = new Date(Date.now() + 60000).toISOString()
      const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt, token: 'fixture' })
      assert(JSON.stringify(applied) === '["first","bad","last"]', 'A failed member blocks another member or repeats its permanent failure.')
      assert(recorded.length === 1 && recorded[0].p_member_id === 'bad' && recorded[0].p_tipoff_at === tipoffAt && recorded[0].p_token === 'fixture', 'The member failure is not recorded under the current claim.')
      assert(String(recorded[0].p_error).startsWith('Locked by trade 50917d7c.'), 'The durable failure loses the database error.')
      assert(result.optimized === 2 && result.failed === (recordFails ? 2 : 1), 'The member outcome is lost.')
      assert(result.batchFailed === recordFails, 'Only an unrecorded failure should make the batch retryable.')
      assert(('p_error' in finish) === recordFails, 'A recorded member error fails the dispatch.')
    } finally { globalThis.fetch = original }
  })
}

for (const failingRpc of ['get_pending_tipoff_members', 'finish_lineup_tipoff_dispatch']) {
  Deno.test(`dispatch failure remains retryable: ${failingRpc}`, async () => {
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init)
      const name = new URL(req.url).pathname.split('/').at(-1)
      if (name === failingRpc) return Response.json({ message: 'Dispatch service unavailable' }, { status: 503 })
      if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
      if (name === 'get_pending_tipoff_members') return Response.json([])
      if (name === 'get_pending_auto_ir_members') return Response.json([])
      if (name === 'finish_lineup_tipoff_dispatch') {
        const body = await req.json()
        assert(body.p_error === 'Dispatch service unavailable', 'A dispatch read failure is hidden from its receipt.')
        return Response.json(null)
      }
      throw new Error(`Unexpected RPC ${name}`)
    }
    try {
      const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
      assert(result.batchFailed && result.failed === 1 && result.errors[0] === 'Dispatch service unavailable', 'A dispatch failure is treated as a completed member failure.')
    } finally { globalThis.fetch = original }
  })
}

Deno.test('league auto IR members resolve IR without choosing starters', async () => {
  const original = globalThis.fetch
  let autoIrBatches = 0
  const irCalls: string[] = []
  const marked: Record<string, unknown>[] = []
  let starterReads = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      return Response.json(autoIrBatches++ === 0
        ? [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }]
        : [])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls.push(body.p_member_id)
      return Response.json({ moves: [{ kind: 'designate', designatePlayerId: 'injured' }], skipped: [], notices: [] })
    }
    if (name === 'mark_tipoff_ir_member_done') { marked.push(body); return Response.json(true) }
    if (name === 'get_pre_tipoff_lineup_context') { starterReads++; return Response.json(context()) }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const tipoffAt = new Date(Date.now() + 60000).toISOString()
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt, token: 'fixture' })
    assert(JSON.stringify(irCalls) === '["manual"]', 'The league auto IR member is not resolved exactly once.')
    assert(marked.length === 1 && marked[0].p_member_id === 'manual' && marked[0].p_tipoff_at === tipoffAt,
      'The IR-only member is not recorded under the current claim.')
    assert(starterReads === 0, 'An Auto Lineup off member had starters chosen.')
    assert(result.optimized === 0 && result.failed === 0 && !result.batchFailed, 'IR-only work changes the lineup result.')
  } finally { globalThis.fetch = original }
})

Deno.test('league auto IR failures retry transient errors and record permanent ones', async () => {
  const original = globalThis.fetch
  let autoIrBatches = 0
  let irCalls = 0
  const recorded: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      return Response.json(autoIrBatches++ === 0
        ? [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }]
        : [])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      return irCalls === 1
        ? Response.json({ code: '55P03', message: 'write conflict' }, { status: 500 })
        : Response.json({ code: 'P0001', message: 'Auto IR management exceeded the IR capacity.' }, { status: 400 })
    }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded.push(body); return Response.json(null) }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(irCalls === 2, 'A transient IR failure is not retried.')
    assert(recorded.length === 1 && recorded[0].p_member_id === 'manual', 'A permanent IR failure is not recorded.')
    assert(result.failed === 1 && !result.batchFailed, 'A recorded IR failure is not isolated.')
  } finally { globalThis.fetch = original }
})

Deno.test('a non-transient PostgREST error still writes its receipt', async () => {
  const original = globalThis.fetch
  let batches = 0
  const recorded: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      return Response.json(batches++ === 0
        ? [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }]
        : [])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      return Response.json({ code: 'PGRST202', message: 'Could not find the function public.auto_manage_ir_tipoff_service' }, { status: 404 })
    }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded.push(body); return Response.json(null) }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(recorded.length === 1 && recorded[0].p_member_id === 'manual', 'A non-transient PostgREST error did not write its receipt.')
    assert(result.failed === 1 && !result.batchFailed, 'A non-transient PostgREST error failed the batch.')
  } finally { globalThis.fetch = original }
})

Deno.test('a policy league Auto Lineup on member resolves IR before starters', async () => {
  const original = globalThis.fetch
  const order: string[] = []
  let batches = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') {
      return Response.json(batches++ === 0
        ? [{ league_id: 'league', league_season_id: 'season', member_id: 'member', auto_ir: true }]
        : [])
    }
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'auto_manage_ir_tipoff_service') { order.push('ir'); return Response.json({ moves: [], skipped: [], notices: [] }) }
    if (name === 'get_pre_tipoff_lineup_context') { order.push('context'); return Response.json(context()) }
    if (name === 'get_league_projection_rows') return Response.json(projections)
    if (name === 'apply_pre_tipoff_lineup') { order.push('apply'); return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(JSON.stringify(order) === '["ir","context","apply"]', `IR did not precede the fresh context: ${JSON.stringify(order)}`)
    assert(result.optimized === 1 && result.failed === 0, 'The policy member did not choose starters after IR.')
  } finally { globalThis.fetch = original }
})

Deno.test('a league without the policy keeps pre-tipoff free of IR calls', async () => {
  const original = globalThis.fetch
  const order: string[] = []
  let batches = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') {
      return Response.json(batches++ === 0
        ? [{ league_id: 'league', league_season_id: 'season', member_id: 'member', auto_ir: false }]
        : [])
    }
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'auto_manage_ir_tipoff_service') { order.push('ir'); return Response.json({ moves: [], skipped: [], notices: [] }) }
    if (name === 'get_pre_tipoff_lineup_context') { order.push('context'); return Response.json(context()) }
    if (name === 'get_league_projection_rows') return Response.json(projections)
    if (name === 'apply_pre_tipoff_lineup') { order.push('apply'); return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') return Response.json(true)
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(JSON.stringify(order) === '["context","apply"]', `A control league ran IR: ${JSON.stringify(order)}`)
    assert(result.optimized === 1 && result.failed === 0, 'The control member did not choose starters.')
  } finally { globalThis.fetch = original }
})

Deno.test('a connection reset on the IR request is retried and the member is marked done', async () => {
  const original = globalThis.fetch
  let irCalls = 0
  let marked = 0
  let recorded = 0
  const finishes: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
      return Response.json(excluded.includes('manual') || marked > 0
        ? []
        : [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      if (irCalls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
      return Response.json({ moves: [], skipped: [], notices: [] })
    }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') { finishes.push(body); return Response.json(true) }
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(irCalls === 2, 'A connection reset was not retried.')
    assert(marked === 1, 'The retried IR move was not marked done.')
    assert(recorded === 0, 'A connection reset wrote a durable member receipt.')
    assert(result.failed === 0 && !result.batchFailed, 'A recovered connection reset failed the dispatch.')
    assert(!('p_error' in finishes[0]), 'A recovered connection reset recorded a dispatch error.')
  } finally { globalThis.fetch = original }
})

Deno.test('an exhausted connection reset fails the batch without a member receipt', async () => {
  const original = globalThis.fetch
  let irCalls = 0
  let marked = 0
  let recorded = 0
  const finishes: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
      return Response.json(excluded.includes('manual') ? [] : [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
    }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'finish_lineup_tipoff_dispatch') { finishes.push(body); return Response.json(true) }
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(irCalls === 5, 'The exhausted connection reset was not retried five times.')
    assert(marked === 0, 'An exhausted connection reset marked the member done.')
    assert(recorded === 0, 'An exhausted connection reset wrote a durable member receipt.')
    assert(result.failed === 1 && result.batchFailed, 'An exhausted connection reset finished the dispatch as successful.')
    assert(typeof finishes[0].p_error === 'string', 'The failed dispatch did not record its error.')
  } finally { globalThis.fetch = original }
})

Deno.test('the installed client transport shapes classify as transient and a real error does not', async () => {
  const { isTransientError } = await import('../_shared/transientError.ts')
  const { supabase } = await import('../_shared/supabase.ts')
  const original = globalThis.fetch
  const shapes: [string, () => Response | never, boolean][] = [
    ['reset', () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }) }, true],
    ['timeout', () => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error }, true],
    ['abort', () => { const error = new Error('This operation was aborted'); error.name = 'AbortError'; throw error }, true],
    ['undici', () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }) }, true],
    ['real', () => Response.json({ message: 'permission denied', code: '42501' }, { status: 403 }), false],
    ['pgrst', () => Response.json({ message: 'Could not find the function', code: 'PGRST202' }, { status: 404 }), false],
    ['raise', () => Response.json({ message: 'Auto IR management exceeded the IR capacity.', code: 'P0001' }, { status: 400 }), false],
    ['terminated text', () => Response.json({ message: 'connection terminated unexpectedly', code: '08006' }, { status: 500 }), false],
  ]
  try {
    for (const [label, respond, expected] of shapes) {
      globalThis.fetch = async (input, init) => {
        const req = new Request(input, init)
        if (new URL(req.url).pathname.endsWith('/auto_manage_ir_tipoff_service')) return respond()
        return Response.json(null)
      }
      const { error } = await supabase.rpc('auto_manage_ir_tipoff_service', {
        p_tipoff_at: '2026-01-01T00:00:00Z', p_token: 'fixture',
        p_league_id: 'league', p_league_season_id: 'season', p_member_id: 'member',
      })
      assert(!!error, `${label} did not produce a client error`)
      assert(isTransientError(error) === expected, `${label} classified as ${!expected}`)
    }
  } finally { globalThis.fetch = original }
})

Deno.test('a fence refusal ends the dispatch without success and without retries', async () => {
  const original = globalThis.fetch
  let irCalls = 0
  let marked = 0
  let recorded = 0
  const finishes: Record<string, unknown>[] = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const name = new URL(req.url).pathname.split('/').at(-1)
    const body = await req.json()
    if (name === 'claim_lineup_tipoff_dispatch') return Response.json(context().date)
    if (name === 'get_pending_tipoff_members') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      const excluded = Array.isArray(body.p_excluded_members) ? body.p_excluded_members : []
      return Response.json(excluded.includes('manual') ? [] : [{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_tipoff_service') {
      irCalls++
      return Response.json({ code: 'PT410', message: 'Tipoff scope is no longer active.' }, { status: 400 })
    }
    if (name === 'mark_tipoff_ir_member_done') { marked++; return Response.json(true) }
    if (name === 'record_pre_tipoff_lineup_failure') { recorded++; return Response.json(null) }
    if (name === 'finish_lineup_tipoff_dispatch') { finishes.push(body); return Response.json(null) }
    throw new Error(`Unexpected RPC ${name}`)
  }
  try {
    const result = await processPreTipoff({ mode: 'pre_tipoff', tipoffAt: new Date(Date.now() + 60000).toISOString(), token: 'fixture' })
    assert(irCalls === 1, `A fence refusal was retried: ${irCalls}`)
    assert(marked === 0, 'A fence refusal wrote an IR receipt.')
    assert(recorded === 0, 'A fence refusal wrote a member failure receipt.')
    assert(result.failed === 1 && result.batchFailed, 'A fence refusal finished the dispatch as successful.')
    assert(typeof finishes[0].p_error === 'string', 'A fence refusal did not record its dispatch error.')
  } finally { globalThis.fetch = original }
})
