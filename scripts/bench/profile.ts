import { connect } from './request-driver.ts'
import { loadProfileHandlers } from './profile-handlers.ts'
import { readWorkloads } from './profile-workloads.ts'

export function guardTarget(value: string, port: string) {
  const url = new URL(value)
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== port) {
    throw Error(`Profile requires loopback port ${port}`)
  }
  return url
}

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], min: sorted[0], max: sorted.at(-1), count: sorted.length }
}

type Statement = { query: string; calls: number; rows: number; total_exec_time: number; mean_exec_time: number; shared_blks_hit: number; shared_blks_read: number; toplevel: boolean; role: string }
type Table = { schemaname: string; relname: string; reads: number; writes: number }
type Snapshot = { statements: Statement[]; tables: Table[] }

async function main() {
  const flags = new Map<string, string>()
  for (let i = 0; i < Deno.args.length; i += 2) {
    if (!['--label', '--rounds', '--out', '--jobs', '--phase', '--only', '--reuse-fixture', '--prime', '--single-sample'].includes(Deno.args[i]) || !Deno.args[i + 1]) throw Error('Use --label NAME --rounds N --out DIR [--jobs all|sql|none]')
    flags.set(Deno.args[i], Deno.args[i + 1])
  }
  const only = flags.get('--only')?.split(',')
  const phase = flags.get('--phase') ?? 'all'
  if (!['all','reads','jobs'].includes(phase)) throw Error('Use --phase all|reads|jobs')
  const label = flags.get('--label') ?? 'baseline'
  const rounds = Number(flags.get('--rounds') ?? 5)
  const singleSample = flags.get('--single-sample') === 'true'
  const reuseFixture = flags.get('--reuse-fixture') === 'true'
  const prime = flags.get('--prime') !== 'false'
  const out = flags.get('--out')
  if (!out || !/^[a-z0-9_-]+$/i.test(label) || !Number.isInteger(rounds) || (singleSample ? rounds !== 1 : rounds < 5)) throw Error('Require output directory, safe label, and at least five rounds')
  const root = await Deno.realPath(new URL('../../', import.meta.url).pathname)
  await Deno.mkdir(out, { recursive: true })
  const outputRoot = await Deno.realPath(out)
  if (outputRoot === root || outputRoot.startsWith(root + '/')) throw Error('Evidence must stay outside the repository')
  const destination = `${outputRoot}/${label}.json`
  try { await Deno.stat(destination); throw Error('Refusing to replace existing evidence') } catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error }
  const api = Deno.env.get('SUPABASE_URL') ?? 'http://127.0.0.1:56321'
  const db = Deno.env.get('SUPABASE_DB_URL') ?? ''
  guardTarget(api, '56321')
  guardTarget(db, '56322')
  const secret = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  const internal = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')
  if (!secret || !anon || !internal) throw Error('Require locally generated Supabase and internal keys')
  const sql = connect(db)
  const observer = connect(db)
  const report: Record<string, unknown> = { label, rounds, generatedAt: new Date().toISOString(), command: ['deno run --no-lock --node-modules-dir=none -A scripts/bench/profile.ts', ...Deno.args].join(' '),
    method: { seed: 6172026, data: 'Synthetic deterministic one-season generator; no real player identities or stats', date: '2026-03-14', season: 2026,
      transport: 'Authenticated PostgREST HTTP; bytes count uncompressed response bodies; cold first sample retained',
      dbTime: 'Sum top-level pg_stat_statements execution time; nested statements retained separately and never added to top-level totals',
      rows: 'Statement rows count outputs or writes, not scanned tuples; table tuple counters estimate logical rows read; warm shared buffers; sequential requests',
      jobs: 'SQL jobs use rollback; unchanged native handlers use fixed clocks and pinned provider responses; idle or failed jobs do not establish active-season capacity',
      concurrency: 'Measured sequential peak 1; production peak is unmeasured; cron schedules retained for cadence analysis' } }
  let resetRequests: (()=>void) | undefined
  let requestStats: (()=>Record<string,number>) | undefined
  const measurements: Record<string, unknown>[] = []
  report.measurements = measurements
  const save = () => Deno.writeTextFile(destination, JSON.stringify(report, null, 2) + '\n')
  const http = async (path: string, body: unknown, token: string, extra: Record<string, string> = {}) => {
    const response = await fetch(`${api}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { apikey: anon, authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const text = new TextDecoder().decode(bytes)
    let data: unknown
    try { data = JSON.parse(text) } catch { data = text }
    return { status: response.status, bytes: bytes.byteLength, data, rows: Array.isArray(data) ? data.length : data === null ? 0 : 1 }
  }
  const snapshot = async (role: string): Promise<Snapshot> => {
    await observer`SELECT pg_stat_clear_snapshot()`
    const statements = await observer.unsafe<Statement[]>(`SELECT query,calls::float8,rows::float8,total_exec_time,mean_exec_time,shared_blks_hit::float8,shared_blks_read::float8,toplevel,(SELECT rolname FROM pg_roles WHERE oid=userid) role
      FROM extensions.pg_stat_statements WHERE ((userid=(SELECT oid FROM pg_roles WHERE rolname='${role}') AND toplevel) OR (NOT toplevel AND userid IN (SELECT oid FROM pg_roles WHERE rolname IN ('postgres','authenticated','service_role','supabase_admin')))) AND dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%' ORDER BY total_exec_time DESC`)
    const tables = await observer.unsafe<Table[]>(`SELECT schemaname,relname,(seq_tup_read+idx_tup_fetch)::float8 reads,(n_tup_ins+n_tup_upd+n_tup_del)::float8 writes
      FROM pg_stat_user_tables WHERE schemaname IN ('public','analytics')`)
    return { statements, tables }
  }
  const measure = async (name: string, kind: string, run: () => Promise<unknown>, count = rounds) => {
    if (only && !only.includes(name)) return
    const role = kind === 'read' ? 'authenticated' : kind === 'edge-job' ? 'service_role' : 'postgres'
    const samples: Record<string, unknown>[] = []
    const entry: Record<string, unknown> = { name, kind, samples }
    measurements.push(entry)
    await observer`SELECT extensions.pg_stat_statements_reset()`
    await observer`SELECT pg_stat_reset()`
    for (let round = 0; round < count; round++) {
      const before = await snapshot(role)
      resetRequests?.()
      const start = performance.now()
      let result: unknown
      let error: string | undefined
      try { result = await run() } catch (failure) { error = String(failure) }
      const ms = performance.now() - start
      await sql`SELECT pg_stat_force_next_flush()`
      await new Promise(resolve => setTimeout(resolve, 1050))
      const after = await snapshot(role)
      const top = (s: Snapshot) => s.statements.filter(row => row.toplevel)
      const sum = (s: Statement[], key: 'total_exec_time' | 'rows') => s.reduce((n, row) => n + Number(row[key]), 0)
      samples.push({ round, ms, result, error, requests:requestStats?.(), dbMs: sum(top(after), 'total_exec_time') - sum(top(before), 'total_exec_time'),
        statementRows: sum(top(after), 'rows') - sum(top(before), 'rows'),
        tableRowsRead: after.tables.reduce((n, row) => n + row.reads, 0) - before.tables.reduce((n, row) => n + row.reads, 0),
        tableRowsWritten: after.tables.reduce((n, row) => n + row.writes, 0) - before.tables.reduce((n, row) => n + row.writes, 0) })
    }
    entry.latencyMs = summarize(samples.map(s => Number(s.ms)))
    entry.dbMs = summarize(samples.map(s => Number(s.dbMs)))
    entry.rowsRead = summarize(samples.map(s => Number(s.tableRowsRead)))
    entry.rowsWritten = summarize(samples.map(s => Number(s.tableRowsWritten)))
    entry.snapshot = await snapshot(role)
    entry.top30Total = (entry.snapshot as Snapshot).statements.slice(0, 30)
    entry.top30Mean = [...(entry.snapshot as Snapshot).statements].sort((a,b) => b.mean_exec_time-a.mean_exec_time).slice(0,30)
    await save()
    console.log(JSON.stringify({ name, latencyMs: entry.latencyMs, dbMs: entry.dbMs, failures: samples.filter(s => s.error || (s.result as {status?:number})?.status! >= 400).length }))
  }
  let restoreHandlers: (() => void) | undefined
  let clockInstalled = false
  const clock = async (mode: string) => {
    const process = await new Deno.Command('node', { args: ['scripts/bench/profile-env.mjs',mode,outputRoot],stdout:'piped',stderr:'piped' }).output()
    if (!process.success) throw Error(new TextDecoder().decode(process.stderr))
  }
  try {
    if (reuseFixture) {
      const [{ safe }] = await observer`SELECT count(*)=30 AND bool_and(slug LIKE 'perf-6172026-%') safe FROM public.leagues`
      if (!safe) throw Error('Reuse requires the thirty isolated profile leagues')
    }
    report.database = (await observer`SELECT version(),current_setting('shared_buffers') shared_buffers,current_setting('max_connections') max_connections`)[0]
    report.cron = await observer`SELECT jobname,schedule,command,active FROM cron.job ORDER BY jobname`
    await observer`UPDATE cron.job SET active=false`
    await observer.unsafe("ALTER DATABASE postgres SET pg_stat_statements.track='all'")
    await sql.unsafe("SET pg_stat_statements.track='all'")
    await observer.unsafe("SET pg_stat_statements.track='none'")
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS bench; CREATE OR REPLACE FUNCTION bench.profile_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('pancake-perf-6172026:' || n)::uuid $$`)
    const password = 'PerfLocal6172026!'
    for (let n = 1; n <= 12; n++) {
      const [{ id }] = await observer`SELECT bench.profile_id(${100+n}) id`
      const existing = await observer`SELECT id FROM auth.users WHERE id=${id}`
      if (!existing.length) {
        const created = await http('/auth/v1/admin/users', { id, email: `perf-6172026-${n}@example.test`, password, email_confirm: true }, secret)
        if (created.status >= 400) throw Error(`Local user creation failed: ${JSON.stringify(created.data)}`)
      }
    }
    const seedAt = performance.now()
    await sql`SELECT set_config('app.bench_profile_target','http://127.0.0.1:56321',false)`
    if (!reuseFixture) await sql.unsafe(await Deno.readTextFile(new URL('./profile-seed.sql', import.meta.url)))
    report.reusedFixture = reuseFixture
    report.seedMs = performance.now() - seedAt
    const ids = await observer`SELECT bench.profile_id(1) league,bench.profile_id(100001) season,bench.profile_id(200101) member,bench.profile_id(200107) opponent,bench.profile_id(1001) player,bench.profile_id(500011) auction,bench.profile_id(500012) snake,bench.profile_id(101) owner`
    const context = ids[0] as Record<string, string>
    context.roster = (await observer`SELECT player_id FROM public.roster_players WHERE member_id=${context.member} ORDER BY player_id`).map(row => row.player_id).join(',')
    report.dataset = await observer.unsafe(`SELECT relname,n_live_tup::float8 rows,pg_total_relation_size(relid)::float8 bytes FROM pg_stat_user_tables WHERE schemaname IN ('public','analytics') ORDER BY relname`)
    const tables = ['players','nba_games','player_game_stats','leagues','league_members','roster_players','weekly_lineups','matchups','standings','waiver_claims','trades','league_activity','dynasty_news','dynasty_rankings','drafts','draft_picks','sync_runs','edge_invocations']
    const counts: Record<string, number> = {}
    for (const table of tables) counts[table] = Number((await observer.unsafe(`SELECT count(*) n FROM public.${table}`))[0].n)
    report.counts = counts
    const [{badGames,badStats}] = await observer.unsafe(`SELECT
      (SELECT count(*)::int FROM public.nba_games g LEFT JOIN public.season_weeks w ON w.season_year=g.season_year AND g.game_date BETWEEN w.week_start AND w.week_end WHERE w.week_number IS NULL OR w.week_number<>g.week_number) AS "badGames",
      (SELECT count(*)::int FROM public.player_game_stats s JOIN public.nba_games g ON g.id=s.game_id WHERE s.week_number<>g.week_number OR s.season_year<>g.season_year) AS "badStats"`)
    report.seedValidation={badGames,badStats}
    if (badGames || badStats) throw Error('Fixture calendar does not match game and stat weeks')
    const auth = await http('/auth/v1/token?grant_type=password', { email: 'perf-6172026-1@example.test', password }, anon)
    if (auth.status >= 400) throw Error(`Local login failed: ${JSON.stringify(auth.data)}`)
    const token = (auth.data as { access_token: string }).access_token
    let ready = false
    for (let attempt = 0; attempt < 60; attempt++) {
      const check = await http('/rest/v1/players?select=id&limit=1',undefined,token)
      if (check.status === 200 && check.rows === 1) { ready = true; break }
      await new Promise(resolve => setTimeout(resolve,500))
    }
    if (!ready) throw Error('PostgREST schema cache never became ready')
    await sql`SELECT pg_stat_force_next_flush()`
    await new Promise(resolve => setTimeout(resolve,1100))
    for (const workload of phase === 'jobs' ? [] : readWorkloads(context)) {
      await measure(workload.name, 'read', async () => {
        const result = await http('/rest/v1/' + workload.path, workload.body, token)
        if (result.status < 400 && result.rows < (workload.minRows ?? 1)) throw Error(`${workload.name}: fixture returns no rows`)
        return { ...result, data: result.status >= 400 ? result.data : undefined }
      })
    }
    const plans = [
      `SELECT * FROM public.search_players(p_league_id=>'${context.league}',p_season_year=>2026,p_limit=>50)`,
      `SELECT * FROM public.get_league_projection_rows('${context.league}',2026,'2026-03-14','today',NULL,600,0)`,
      `SELECT * FROM public.get_dynasty_forecast_inputs('${context.league}','${context.member}',2026,NULL,'',600,0)`,
      `SELECT * FROM public.player_game_stats WHERE player_id='${context.player}' AND season_year=2026 ORDER BY game_date DESC LIMIT 16`,
      `SELECT * FROM public.league_activity WHERE league_id='${context.league}' ORDER BY created_at DESC LIMIT 50`,
    ]
    report.plans = []
    for (const statement of plans) {
      await sql.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE authenticated')
        await tx`SELECT set_config('request.jwt.claim.sub',${context.owner},true)`
        const plan = await tx.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`)
        ;(report.plans as unknown[]).push({ statement, role: 'authenticated', plan })
      })
    }
    for (const name of ['get_league_projection_rows','get_dynasty_forecast_inputs']) {
      const [{body}] = await observer`SELECT prosrc body FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=${name}`
      const replacements: Record<string,string> = { p_league_id:`'${context.league}'::uuid`,p_member_id:`'${context.member}'::uuid`,p_season_year:'2026',p_game_date:"'2026-03-14'::date",p_view:"'today'::text",p_player_ids:'NULL::uuid[]',p_query:"''::text",p_limit:'600',p_offset:'0' }
      let statement = String(body).trim().replace(/;\s*$/,'')
      for (const [key,value] of Object.entries(replacements)) statement = statement.replaceAll(new RegExp('\\b'+key+'\\b','g'),value)
      await sql.begin(async tx => {
        await tx.unsafe('SET LOCAL ROLE authenticated')
        await tx`SELECT set_config('request.jwt.claim.sub',${context.owner},true)`
        const plan=await tx.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`)
        ;(report.plans as unknown[]).push({functionBody:name,statement,role:'authenticated',plan})
      })
    }
    const jobs = phase === 'reads' ? 'none' : flags.get('--jobs') ?? 'all'
    if (!['none','sql','all'].includes(jobs)) throw Error('Unknown job mode')
    let handlers: Map<string,(request: Request) => Promise<Response>> | undefined
    const edgeNames = ['live-poll','sync-scores','process-waivers','process-trades','lineup-optimizer','season-boundary','sync-stats','sync-schedule','sync-players','sync-player-injuries','close-expired-nominations','sync-projections','sync-rankings','sync-draft-order']
    if (jobs !== 'none') {
      await clock('--clock')
      clockInstalled = true
      await sql.unsafe('DISCARD PLANS')
      const [{at,wall}] = await sql`SELECT now()::text at,clock_timestamp()::text wall`
      if (!String(at).startsWith('2026-03-14 12:00:00') || !String(wall).startsWith('2026-03-14 12:00:00')) throw Error('Database clock override failed')
      await sql.unsafe(`UPDATE public.nba_games SET status='Scheduled',game_time='2026-03-14T23:00:00Z' WHERE game_date='2026-03-14';
        INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled,enabled_at)
        SELECT league_id,bench.profile_id(100000+l),id,true,now() FROM public.league_members JOIN generate_series(1,30)l ON league_id=bench.profile_id(l)
        ON CONFLICT (league_id,league_season_id,member_id) DO UPDATE SET enabled=true;`)
      if (jobs === 'all') {
        const loaded = await loadProfileHandlers(outputRoot,edgeNames)
        handlers = loaded.handlers
        restoreHandlers = loaded.restore
        resetRequests = loaded.resetRequests
        requestStats = loaded.requestStats
      }
      report.activeJobMethod = `Native handlers loaded in Deno with fixed JavaScript and database clocks. Actual local PostgREST transport. Provider reads pinned under providers/. ${prime ? 'One unmeasured prime per job.' : 'No per-job prime; reuse the prepared fixture.'} ${rounds} measured round(s). Edge isolate startup excluded.`
    }
    if (jobs !== 'none') {
      const sqlJobs = [
        ['stale-score-weeks', `SELECT * FROM public.get_stale_score_weeks('${context.season}'::uuid,21)`],
        ['live-poll-work', 'SELECT * FROM public.get_live_poll_work()'],
        ['live-poll-dispatch', 'SELECT public.invoke_live_poll_if_due()'],
        ['stats-dispatch', 'SELECT public.invoke_stats_sync_dispatch_if_due()'],
        ['process-trades-dispatch', 'SELECT public.invoke_process_trades_if_due()'],
        ['pre-tipoff-dispatch', 'SELECT public.invoke_pre_tipoff_optimizer_if_due()'],
        ['live-poll-work-active-predicate', "SELECT * FROM public.get_live_poll_work('2026-03-14T23:00:00Z')"],
        ['cache-refresh-unchanged', 'SELECT public.refresh_player_search_caches()'],
        ['cache-refresh-dirty', "UPDATE analytics.search_cache_refresh_state SET refreshed_at=now()-interval '8 days'; SELECT public.refresh_player_search_caches()"],
        ['season-averages-refresh', 'REFRESH MATERIALIZED VIEW analytics.mv_player_season_averages'],
        ['retention-prune', 'SELECT public.prune_unbounded_history()'],
        ['invocation-reconcile-idle','SELECT private.reconcile_edge_invocations()'],
        ['inventory-hint-drain','SELECT private.flush_league_inventory_hints(1000)'],
        ['mock-room-expiry-idle','SELECT public.expire_mock_draft_rooms()'],
        ['nomination-dispatch-idle','SELECT public.invoke_close_expired_nominations_if_due()'],
        ['net-response-vacuum','VACUUM (ANALYZE,INDEX_CLEANUP ON) net._http_response'],
        ['waivers-active-30-including-preparation', `UPDATE public.waiver_claims SET status='pending',drop_player_id=(SELECT rp.player_id FROM public.roster_players rp WHERE rp.member_id=public.waiver_claims.member_id ORDER BY rp.player_id LIMIT 1) WHERE id IN (SELECT DISTINCT ON (league_id) id FROM public.waiver_claims ORDER BY league_id,id); UPDATE public.waiver_wire_log SET clears_at=now()-interval '1 day'; SELECT * FROM public.process_due_waiver_claims_atomic('2026-03-14',100)`],
        ['trades-active-30-including-preparation', `UPDATE public.trades SET status='accepted',accepted_at=now()-interval '2 days',veto_window_expires_at=now()-interval '1 day' WHERE id IN (SELECT DISTINCT ON (league_id) id FROM public.trades ORDER BY league_id,id); SELECT * FROM public.process_due_accepted_trades_atomic(50)`],
      ]
      for (const [name, statement] of sqlJobs) await measure(name, 'sql-job', async () => {
        if (name==='net-response-vacuum') { const data=await sql.unsafe(statement); return {data} }
        await sql.unsafe('BEGIN')
        try { const data = await sql.unsafe(statement); return { rows: data.length, data } }
        finally { await sql.unsafe('ROLLBACK') }
      })
    }
    if (jobs === 'all' && (!only || only.includes('sync-scores-engine-no-provider'))) {
      const {syncScores}=await import(new URL('../../supabase/functions/_shared/syncScores.ts',import.meta.url).href)
      report.primes ??= []
      try { if (prime) await syncScores(undefined,new Date('2026-03-14T12:00:00Z'),{recoverStats:false}) } catch (error) { (report.primes as unknown[]).push({name:'sync-scores-engine-no-provider',error:String(error)}) }
      await measure('sync-scores-engine-no-provider','edge-job',async () => {
        await syncScores(undefined,new Date('2026-03-14T12:00:00Z'),{recoverStats:false})
        return {status:200,data:{ok:true,providerRecovery:false}}
      })
    }
    const runTipoffProfile = async () => {
      if (jobs !== 'all') return
      await measure('lineup-pre-tipoff-360-including-preparation','edge-job',async () => {
        await sql.unsafe(`UPDATE public.nba_games SET game_time='2026-03-14T12:01:00Z',status='Scheduled',started_at=NULL WHERE game_date='2026-03-14';
          DELETE FROM public.lineup_tipoff_members WHERE tipoff_at='2026-03-14T12:01:00Z';
          INSERT INTO public.lineup_tipoff_dispatches(tipoff_at,game_date,status,token,input_revision,lease_until)
          VALUES('2026-03-14T12:01:00Z','2026-03-14','queued',bench.profile_id(600001),1,now()+interval '45 seconds')
          ON CONFLICT(tipoff_at) DO UPDATE SET status='queued',token=excluded.token,input_revision=excluded.input_revision,lease_until=excluded.lease_until,error=NULL;`)
        const [{token}] = await observer`SELECT bench.profile_id(600001) token`
        const response = await handlers!.get('lineup-optimizer')!(new Request(`${api}/functions/v1/lineup-optimizer`,{method:'POST',headers:{'content-type':'application/json','x-internal-function-token':internal},body:JSON.stringify({mode:'pre_tipoff',tipoffAt:'2026-03-14T12:01:00Z',token})}))
        const text = await response.text()
        const data = JSON.parse(text)
        const [{completed}] = await observer`SELECT count(*)::int completed FROM public.lineup_tipoff_members WHERE tipoff_at='2026-03-14T12:01:00Z'`
        return {status:response.status,bytes:new TextEncoder().encode(text).byteLength,data,completed}
      })
    }
    if (jobs === 'all') for (const [name, body] of [
      ['live-poll', {}], ['sync-scores', { date: '2026-03-14T12:00:00Z' }], ['process-waivers', {}], ['process-trades', {}],
      ['lineup-optimizer', { date: '2026-03-14' }], ['season-boundary', { date: '2026-03-14T12:00:00Z' }],
      ['sync-stats', { date: '2026-03-14' }], ['sync-schedule', {}], ['sync-players', {}], ['sync-player-injuries', {}],
      ['close-expired-nominations',{}],['sync-projections',{}],['sync-rankings-POINT_3',{view:'POINT_3'}],
      ['sync-rankings-ROOKIE',{view:'ROOKIE'}],['sync-rankings-POINT_5',{view:'POINT_5'}],['sync-draft-order',{seasonYear:2025}],
      ['sync-stats-published-day-including-preparation',{date:'2026-03-12'}],
    ] as const) {
      if (name === 'sync-stats') await runTipoffProfile()
      if (name==='sync-stats-published-day-including-preparation' && !only?.includes(name)) continue
      if (only && !only.includes(name)) continue
      const run = async () => {
        if (name==='sync-stats-published-day-including-preparation') await sql.unsafe("DELETE FROM public.player_game_stats s USING public.players p,public.nba_games g WHERE s.player_id=p.id AND s.game_id=g.id AND g.game_date='2026-03-12' AND p.sportsdata_id LIKE 'perf-6172026-%'; UPDATE public.nba_games SET stats_synced_at=NULL WHERE game_date='2026-03-12'")
        const functionName=name.startsWith('sync-rankings-') ? 'sync-rankings' : name.startsWith('sync-stats-published-') ? 'sync-stats' : name
        const response = await handlers!.get(functionName)!(new Request(`${api}/functions/v1/${functionName}`,{ method:'POST',headers:{'content-type':'application/json','x-internal-function-token':internal},body:JSON.stringify(body) }))
        const text = await response.text()
        let data: unknown
        try { data=JSON.parse(text) } catch { data=text }
        return {status:response.status,bytes:new TextEncoder().encode(text).byteLength,rows:Array.isArray(data) ? data.length : 1,data}
      }
      report.primes ??= []
      try { if (prime) (report.primes as unknown[]).push({name,result:await run()}) } catch (error) { (report.primes as unknown[]).push({name,error:String(error)}) }
      await measure(name,'edge-job',run)
    }
    const [{body:staleBody}] = await observer`SELECT prosrc body FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='get_stale_score_weeks'`
    const staleStatement = String(staleBody).trim().replace(/;\s*$/,'').replaceAll('p_league_season_id',`'${context.season}'::uuid`).replaceAll('p_through_week','21')
    const stalePrototype = `WITH eligible_weeks AS MATERIALIZED (
      SELECT DISTINCT matchup.week_number FROM public.matchups matchup
      WHERE matchup.league_season_id='${context.season}'::uuid AND matchup.week_number<=21
        AND matchup.is_finalized IS TRUE AND NOT matchup.is_voided
        AND NOT EXISTS(SELECT 1 FROM private.retired_score_inputs WHERE league_season_id='${context.season}'::uuid)
        AND NOT private.playoff_matchup_is_consumed(matchup.id)
    ) SELECT eligible.week_number FROM eligible_weeks eligible
      LEFT JOIN private.score_week_certificates certificate ON certificate.league_season_id='${context.season}'::uuid AND certificate.week_number=eligible.week_number
      WHERE certificate.input_token IS NULL OR certificate.input_token IS DISTINCT FROM private.score_input_token('${context.season}'::uuid,eligible.week_number)
      ORDER BY eligible.week_number`
    for (const [name,statement] of [['stale-score-weeks-body',staleStatement],['stale-score-weeks-distinct-first-prototype',stalePrototype],['score-identity',`SELECT private.assert_score_game_identity('${context.season}',21)`]]) {
      const plan=await sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`)
      ;(report.plans as unknown[]).push({name,statement,role:'postgres',prototype:name.includes('prototype'),plan})
    }
    const originalWeeks=await sql.unsafe(staleStatement)
    const prototypeWeeks=await sql.unsafe(stalePrototype)
    report.prototypeRowsMatch=JSON.stringify(originalWeeks)===JSON.stringify(prototypeWeeks)
    if (!report.prototypeRowsMatch) throw Error('Distinct-first prototype changes the fixture result')
    for (const relation of ['analytics.mv_player_avg_fantasy_points','analytics.mv_player_season_averages']) {
      const [{definition}] = await observer`SELECT pg_get_viewdef(${relation}::regclass,true) definition`
      const statement = String(definition).replace(/;\s*$/,'')
      const plan = await sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}`)
      ;(report.plans as unknown[]).push({relation,role:'postgres',statement,plan})
    }
    if (!measurements.length) throw Error('No workloads match --only')
    await save()
  } finally {
    restoreHandlers?.()
    if (clockInstalled) await clock('--restore-clock')
    await sql.end()
    await observer.end()
  }
}

if (import.meta.main) await main()
