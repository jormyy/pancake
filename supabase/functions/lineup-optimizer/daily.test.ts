Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:9')
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'sb_secret_test')
const { processDaily } = await import('./daily.ts')

const assert = (condition: boolean, message: string) => { if (!condition) throw new Error(message) }
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })

Deno.test('daily resolves league auto IR for Auto Lineup off members without choosing starters', async () => {
  const original = globalThis.fetch
  const irCalls: string[] = []
  let applies = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_service') {
      irCalls.push((await req.json()).p_member_id)
      return Response.json({ moves: [{ kind: 'designate', designatePlayerId: 'injured' }], skipped: [], notices: [] })
    }
    if (name === 'apply_daily_lineup') { applies++; return Response.json(true) }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(JSON.stringify(irCalls) === '["manual"]', 'The Auto Lineup off member did not get exactly one IR resolution.')
    assert(applies === 0, 'An Auto Lineup off member had starters chosen.')
    assert(result.optimized === 0 && result.failed === 0, 'IR-only work changes the daily result.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily leaves leagues without the policy untouched', async () => {
  const original = globalThis.fetch
  let irCalls = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([])
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'auto_manage_ir_service') { irCalls++; return Response.json({ moves: [], skipped: [], notices: [] }) }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(irCalls === 0, 'A league without the policy ran auto IR.')
    assert(result.optimized === 0 && result.failed === 0, 'A control league changes the daily result.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily keeps an unrelated league transient failure counted and does not fail the run', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') {
      return Response.json([{ league_id: 'other', league_season_id: 'other-season', member_id: 'other-member', enabled: true }])
    }
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'get_pre_tipoff_lineup_context') {
      return Response.json({
        date: today, seasonYear: 2027, weekNumber: 1,
        players: [{ playerId: 'p1', locked: false, hasGame: true, gameTime: null, lineupPin: null, injuryStatus: null, eligiblePositions: ['PG'] }],
        templates: [{ slotType: 'PG', count: 1 }], stored: [],
      })
    }
    if (name === 'get_league_projection_rows') {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(result.failed === 1, 'An unrelated league transient failure is not counted.')
    assert(result.errors.length === 1, 'An unrelated league transient failure is not reported.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily fails the run for a policy league transient failure', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_service') {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) })
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    let failed = false
    try { await processDaily({ date: today }) } catch (error) { failed = error instanceof AggregateError }
    assert(failed, 'A policy league transient failure did not fail the run.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily reports a failed league auto IR resolution', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([])
    if (name === 'get_pending_auto_ir_members') {
      return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    }
    if (name === 'auto_manage_ir_service') {
      return Response.json({ code: 'P0001', message: 'Auto IR management exceeded the IR capacity.' }, { status: 400 })
    }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(result.failed === 1 && result.errors[0].startsWith('manual: '), 'A failed IR resolution is hidden.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily runs strict IR for both Auto Lineup settings in the enabled league', async () => {
  const original = globalThis.fetch
  const irCalls: string[] = []
  let applies = 0
  let assignments: unknown = null
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'auto' }])
    if (name === 'get_pending_auto_ir_members') return Response.json([
      { league_id: 'league', league_season_id: 'season', member_id: 'manual' },
      { league_id: 'league', league_season_id: 'season', member_id: 'auto' },
    ])
    if (name === 'auto_manage_ir_service') { irCalls.push((await req.json()).p_member_id); return Response.json({ moves: [], skipped: [], notices: [] }) }
    if (name === 'get_pre_tipoff_lineup_context') return Response.json({ date: today, seasonYear: 2027, weekNumber: 1, players: [], templates: [], stored: [] })
    if (name === 'apply_daily_lineup') { applies++; assignments = (await req.json()).p_assignments; return Response.json(true) }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(JSON.stringify(irCalls.sort()) === '["auto","manual"]', 'Both settings did not get strict IR.')
    assert(applies === 1, 'The Auto Lineup on member did not get starters.')
    assert(JSON.stringify(assignments) === '[]', 'Manual starters changed.')
    assert(result.failed === 0, 'The daily run failed.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily runs strict IR for a member toggled on between the two loads', async () => {
  const original = globalThis.fetch
  const irCalls: string[] = []
  let applies = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'auto' }])
    if (name === 'get_pending_auto_ir_members') return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'manual' }])
    if (name === 'auto_manage_ir_service') {
      const body = await req.json()
      irCalls.push(body.p_member_id)
      if (body.p_member_id === 'auto') return Response.json({ code: 'P0001', message: 'IR failed' }, { status: 400 })
      return Response.json({ moves: [], skipped: [], notices: [] })
    }
    if (name === 'get_pre_tipoff_lineup_context') return Response.json({ date: today, seasonYear: 2027, weekNumber: 1, players: [], templates: [], stored: [] })
    if (name === 'apply_daily_lineup') { applies++; return Response.json(true) }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(JSON.stringify(irCalls.sort()) === '["auto","manual"]', 'The toggled-on member did not get strict IR.')
    assert(applies === 0, 'The toggled-on member got starters after a strict IR failure.')
    assert(result.failed === 1, 'The toggled-on member did not get strict IR.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily skips starters after a strict IR failure in the enabled league', async () => {
  const original = globalThis.fetch
  let applies = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'auto' }])
    if (name === 'get_pending_auto_ir_members') return Response.json([{ league_id: 'league', league_season_id: 'season', member_id: 'auto' }])
    if (name === 'auto_manage_ir_service') return Response.json({ code: 'P0001', message: 'IR failed' }, { status: 400 })
    if (name === 'get_pre_tipoff_lineup_context') return Response.json({ date: today, seasonYear: 2027, weekNumber: 1, players: [], templates: [], stored: [] })
    if (name === 'apply_daily_lineup') { applies++; return Response.json(true) }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(applies === 0, 'Starters were chosen after a strict IR failure.')
    assert(result.failed === 1, 'The strict IR failure was not reported.')
  } finally { globalThis.fetch = original }
})

Deno.test('daily keeps the best-effort path outside the enabled league', async () => {
  const original = globalThis.fetch
  let applies = 0
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const name = url.pathname.split('/').at(-1)
    if (url.pathname === '/rest/v1/nba_games') return Response.json([{ season_year: 2027 }])
    if (url.pathname === '/rest/v1/lineup_optimizer_settings') return Response.json([{ league_id: 'other', league_season_id: 'other-season', member_id: 'other-member' }])
    if (name === 'get_pending_auto_ir_members') return Response.json([])
    if (name === 'auto_manage_ir_service') return Response.json({ code: 'P0001', message: 'IR failed' }, { status: 400 })
    if (name === 'get_pre_tipoff_lineup_context') return Response.json({ date: today, seasonYear: 2027, weekNumber: 1, players: [], templates: [], stored: [] })
    if (name === 'apply_daily_lineup') { applies++; return Response.json(true) }
    throw new Error(`Unexpected request ${url.pathname}`)
  }
  try {
    const result = await processDaily({ date: today })
    assert(applies === 1, 'The best-effort league did not get starters.')
    assert(result.failed === 0, `The best-effort IR failure was reported as a failure: ${result.errors.join('; ')}`)
  } finally { globalThis.fetch = original }
})
