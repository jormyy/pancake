import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { cache, command, root, summary, sensitivity, note } from './common.mjs'

export const port = 58000 + parseInt((await import('./common.mjs')).digest(root).slice(0, 4), 16) % 500 * 10
export async function startDatabase() {
  const project = `pancake-perf-${process.pid}-${randomUUID().slice(0, 8)}`
  const work = path.join(cache, 'stack')
  await mkdir(path.join(work, 'supabase'), { recursive: true })
  const config = `project_id = "${project}"
[api]
port = ${port + 1}
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000
[db]
port = ${port + 2}
shadow_port = ${port + 3}
major_version = 17
[db.migrations]
enabled = false
[db.seed]
enabled = false
[studio]
enabled = false
[inbucket]
enabled = false
[storage]
enabled = true
[auth]
enabled = true
site_url = "http://127.0.0.1:${port}"
jwt_issuer = "http://127.0.0.1:${port}/auth/v1"
[auth.rate_limit]
sign_in_sign_ups = 1000
token_refresh = 1000
[auth.email]
enable_confirmations = false
[analytics]
enabled = false
[edge_runtime]
enabled = false
`
  await writeFile(path.join(work, 'supabase/config.toml'), config)
  const stop = () => command('supabase', ['stop', '--workdir', work, '--project-id', project, '--no-backup'])
  const sql = (input) => command('docker', ['exec', '-i', `supabase_db_${project}`, 'psql', '-U', 'supabase_admin', '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input })
  try {
    note('Starting private local database.')
    await command('supabase', ['start', '--workdir', work, '-x', 'studio,imgproxy,vector,logflare,supavisor,edge-runtime,postgres-meta,mailpit'])
    await sql("ALTER SYSTEM SET cron.launch_active_jobs = 'off'; SELECT pg_reload_conf(); CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions; CREATE SCHEMA IF NOT EXISTS perf_guard; CREATE FUNCTION perf_guard.deny_network() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Perf database blocks network requests'; END $$; CREATE TRIGGER perf_deny_network BEFORE INSERT ON net.http_request_queue FOR EACH ROW EXECUTE FUNCTION perf_guard.deny_network();")
    await cp(path.join(root, 'supabase/migrations'), path.join(work, 'supabase/migrations'), { recursive: true, force: true })
    await writeFile(path.join(work, 'supabase/config.toml'), config.replace('[db.migrations]\nenabled = false', '[db.migrations]\nenabled = true'))
    note('Applying local schema.')
    await command('supabase', ['migration', 'up', '--local', '--include-all', '--workdir', work])
    const values = Object.fromEntries((await command('supabase', ['status', '-o', 'env', '--workdir', work])).split('\n').flatMap(line => {
      const match = /^([A-Z_]+)="(.*)"$/.exec(line)
      return match ? [[match[1], match[2]]] : []
    }))
    assert.equal(new URL(values.API_URL).hostname, '127.0.0.1')
    assert.equal(Number(new URL(values.API_URL).port), port + 1)
    assert.ok(values.ANON_KEY && values.SERVICE_ROLE_KEY)
    return { project, sql, stop, values }
  } catch (error) {
    await stop().catch(cleanup => { error.message += ` Cleanup failed: ${cleanup.message}` })
    throw error
  }
}

export async function seedDatabase(db) {
  note('Seeding full-season rows.')
  await db.sql(`SET session_replication_role = replica;
    CREATE SCHEMA IF NOT EXISTS bench;
    CREATE OR REPLACE FUNCTION bench.profile_id(n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('pancake-perf-6172026:' || n)::uuid $$;
    INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new)
    SELECT bench.profile_id(100+n), 'authenticated','authenticated','perf-'||n||'@example.test',extensions.crypt('LocalPerfFixtureOnly2026',extensions.gen_salt('bf')),now(),'{"provider":"email","providers":["email"]}','{}',now(),now(),'','','','' FROM generate_series(1,12)n ON CONFLICT DO NOTHING;
    UPDATE auth.users SET instance_id='00000000-0000-0000-0000-000000000000';
    INSERT INTO public.profiles(id,display_name,username) SELECT bench.profile_id(100+n),'Perf User '||n,'perf_user_'||n FROM generate_series(1,12)n ON CONFLICT DO NOTHING;
    SET app.bench_profile_target = 'http://127.0.0.1:56321';
    ${(await readFile(path.join(root, 'scripts/bench/profile-seed.sql'), 'utf8')).replace(/\b2026\b/g, '2027').replace(/\b2025\b/g, '2026').replace(', public.cron_dispatch_state', '').replace('trade_participants(trade_id,member_id,sort_order,is_initiator,accepted_at)', 'trade_participants(league_id,proposed_at,trade_id,member_id,sort_order,is_initiator,accepted_at)').replace('SELECT bench.profile_id(400000+l*100+n),bench.profile_id(200000+l*100+m),m-1', 'SELECT bench.profile_id(l),now(),bench.profile_id(400000+l*100+n),bench.profile_id(200000+l*100+m),m-1').replace('trade_items(trade_id,side,player_id,from_member_id,to_member_id)', 'trade_items(league_id,trade_id,side,player_id,from_member_id,to_member_id)').replace("SELECT bench.profile_id(400000+l*100+n),'proposer'", "SELECT bench.profile_id(l),bench.profile_id(400000+l*100+n),'proposer'")}`)
  await db.sql(await readFile(path.join(root, 'tools/perf/seed.sql'), 'utf8'))
  const totalsSource = await readFile(path.join(root, 'supabase/sql/functions/by-name/private/rebuild_game_player_totals.sql'), 'utf8')
  const totalsSql = totalsSource.match(/INSERT INTO analytics\.player_season_totals[\s\S]*?GROUP BY s\.player_id,s\.season_year;/)[0]
    .replace('s.player_id=v_player AND s.season_year IN (OLD.season_year,NEW.season_year)\n      AND ', '')
  await db.sql(`SET session_replication_role=replica; TRUNCATE analytics.player_season_totals; ${totalsSql}
    INSERT INTO public.league_versions(league_id,version,reader_ids) SELECT l.id,1,array_agg(m.user_id) FROM public.leagues l JOIN public.league_members m ON m.league_id=l.id GROUP BY l.id ON CONFLICT(league_id) DO UPDATE SET reader_ids=excluded.reader_ids;
    INSERT INTO private.screen_refresh_queue(league_id,league_season_id) SELECT league_id,id FROM public.league_seasons ON CONFLICT DO NOTHING;
    SELECT private.refresh_player_averages(league_id,league_season_id,version) FROM private.screen_refresh_queue;
    SELECT private.refresh_standings(league_id,league_season_id,version) FROM private.screen_refresh_queue;
    SELECT private.refresh_matchup_totals(league_id,league_season_id,version) FROM private.screen_refresh_queue;
    UPDATE private.screen_refresh_queue SET dirty=false,standings_dirty=false,last_refreshed_at=now();
    ANALYZE;`)
  const result = JSON.parse(await db.sql(`SELECT jsonb_build_object('leagueId',bench.profile_id(1),'memberId',bench.profile_id(200101),'userId',bench.profile_id(101),'seasonId',bench.profile_id(100001),'playerId',bench.profile_id(1001),'date',current_date,'seasonYear',2027);`))
  result.tables = JSON.parse(await db.sql(`SELECT jsonb_object_agg(name,n) FROM (SELECT 'players' name,count(*) n FROM public.players UNION ALL SELECT 'nba_games',count(*) FROM public.nba_games UNION ALL SELECT 'player_game_stats',count(*) FROM public.player_game_stats UNION ALL SELECT 'player_projections',count(*) FROM public.player_projections UNION ALL SELECT 'daily_projections',count(*) FROM public.fantasypros_projection_rows UNION ALL SELECT 'leagues',count(*) FROM public.leagues UNION ALL SELECT 'roster_players',count(*) FROM public.roster_players UNION ALL SELECT 'weekly_lineups',count(*) FROM public.weekly_lineups UNION ALL SELECT 'matchups',count(*) FROM public.matchups) t;`))
  result.databaseBytes = Number(await db.sql('SELECT pg_database_size(current_database());'))
  assert.ok(result.tables.player_game_stats >= 49000 && result.tables.player_projections >= 15600 && result.tables.daily_projections >= 49000)
  const login = await fetch(`${db.values.API_URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: db.values.ANON_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ email: 'perf-1@example.test', password: 'LocalPerfFixtureOnly2026' }) })
  assert.equal(login.status, 200, `Local login failed: ${await login.clone().text()}`)
  return { ...result, session: await login.json() }
}

function screenCases(seed) {
  const params = { seasonId: seed.seasonId, seasonYear: seed.seasonYear, date: seed.date, weekNumber: 3 }
  return [
    ['Home', 'view_home', { ...params, compact: true }, body => body.matchup && body.myLineup],
    ['Roster', 'view_roster', params, body => body.roster?.length >= 15],
    ['Lineup', 'view_lineup', params, body => body.starters?.length >= 8],
    ['Players/Waivers', 'view_players', { ...params, availability: 'available' }, body => body.players?.length >= 20],
    ['Trades', 'view_trades', params, body => body.trades?.length >= 1],
    ['League', 'view_league', params, body => body.standings?.length >= 12],
    ['Player', 'view_player', { ...params, playerId: seed.playerId, section: 'overview' }, body => body.player?.id === seed.playerId],
  ].map(([screen, rpc, params, valid]) => ({ screen, rpc, params, valid }))
}

export async function measureData(db, seed, n) {
  await command('docker', ['update', '--memory=512m', '--memory-swap=512m', `supabase_db_${db.project}`])
  await db.sql("ALTER SYSTEM SET pg_stat_statements.track='none'; SELECT pg_reload_conf();")
  const errors = [], metrics = []
  let workDone = 0
  const request = async (item, delay = false) => {
    const begin = performance.now()
    const response = await fetch(`${db.values.API_URL}/rest/v1/rpc/${item.rpc}`, { method: 'POST', headers: { apikey: db.values.ANON_KEY, Authorization: `Bearer ${seed.session.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_league_id: seed.leagueId, p_member_id: seed.memberId, p_params: item.params }), signal: AbortSignal.timeout(30000) })
    const bytes = Buffer.from(await response.arrayBuffer())
    if (delay) await new Promise(resolve => setTimeout(resolve, 1000))
    const ms = performance.now() - begin
    assert.equal(response.status, 200, `${item.rpc}: ${bytes.toString().slice(0, 1000)}`)
    const value = JSON.parse(bytes)
    assert.ok(item.valid(value), `${item.rpc} did not return expected rows: ${JSON.stringify(value).slice(0, 1000)}`)
    workDone++
    return { ms, bytes: bytes.length }
  }
  for (const item of screenCases(seed)) {
    note(`Measuring ${item.screen} RPC.`)
    const samples = [], bytes = []
    try {
      for (let i = 0; i < 3; i++) await request(item)
      for (let i = 0; i < n; i++) { const row = await request(item); samples.push(row.ms); bytes.push(row.bytes) }
      metrics.push({ screen: item.screen, rpc: item.rpc, latencyMs: summary(samples), responseBytes: summary(bytes), samples })
    } catch (error) { errors.push(error.message) }
  }
  const control = [], slow = []
  try {
    for (let i = 0; i < 5; i++) {
      const item = screenCases(seed)[1]
      await request(item)
      control.push((await request(item)).ms)
      await request(item)
      slow.push((await request(item, true)).ms)
    }
  } catch (error) { errors.push(error.message) }
  const proof = control.length === 5 && slow.length === 5 ? sensitivity(control, slow) : null
  if (!proof?.detected) errors.push('RPC sensitivity failed')
  await db.sql("ALTER SYSTEM SET pg_stat_statements.track='all'; SELECT pg_reload_conf(); SELECT extensions.pg_stat_statements_reset();")
  for (const item of screenCases(seed)) await request(item)
  const statements = JSON.parse(await db.sql("SELECT coalesce(jsonb_agg(s),'[]') FROM (SELECT query,calls,rows,total_exec_time,shared_blks_hit,shared_blks_read,temp_blks_written FROM extensions.pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE '%set_config%' ORDER BY total_exec_time DESC LIMIT 15) s;"))
  await db.sql("ALTER SYSTEM SET pg_stat_statements.track='none'; SELECT pg_reload_conf();")
  return { profileRequests: 7, databaseMemoryLimitBytes: 536870912, statements, errorCount: errors.length, errors, workDone, metrics, sensitivity: proof, transport: 'Authenticated PostgREST RPC; response body consumed; 3 warmups; sequential requests', concurrency: 1 }
}
