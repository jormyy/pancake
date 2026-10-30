import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { assertEquivalent, comparePairs } from './pipeline-night-gates.mjs'

const literal = value => `'${String(value).replaceAll("'", "''")}'`
const local = process.env.PIPELINE_LOCAL === '1'
const lane = local ? '/tmp/fable-l7' : path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-l7')
const freeze = source => (process.env.PIPELINE_NATIVE_CLOCK === '1' ? source : source.replace(/\b(?:now|transaction_timestamp|clock_timestamp)\(\)/g, 'pg_temp.pipeline_now()')).replace(/\bgen_random_uuid\(\)/g, 'pg_temp.pipeline_uuid()')

export class Database {
  constructor() {
    this.pending = null
    this.stderr = ''
    this.process = spawn('psql', ['postgresql://supabase_admin:postgres@127.0.0.1:64822/postgres', '-XqAtv', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
    createInterface({ input: this.process.stdout }).on('line', line => {
      if (!this.pending) return
      if (line === this.pending.marker) {
        const { resolve, lines } = this.pending
        this.pending = null
        resolve(lines.join('\n'))
      } else this.pending.lines.push(line)
    })
    this.process.stderr.on('data', chunk => { this.stderr += chunk })
    this.process.stdin.on('error', error => this.pending?.reject(new Error(`${error.message}: ${this.stderr.slice(-4000)}`)))
    this.process.on('exit', code => this.pending?.reject(new Error(`psql exited ${code}: ${this.stderr.slice(-8000)}`)))
  }
  async query(statement) {
    assert.equal(this.pending, null)
    return await new Promise((resolve, reject) => {
      const marker = randomUUID()
      this.pending = { marker, resolve, reject, lines: [] }
      this.process.stdin.write(`${statement}\n\\echo ${marker}\n`)
    })
  }
  async json(statement) { return JSON.parse(await this.query(statement)) }
  async close() {
    if (this.process.exitCode !== null) return
    await new Promise(resolve => { this.process.once('exit', resolve); this.process.stdin.end() })
  }
}

const setup = `BEGIN;
SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'; SET LOCAL pg_stat_statements.track='none';
SET LOCAL app.supabase_url='http://127.0.0.1:64821'; SET LOCAL app.edge_internal_token='private-pipeline-night';
SET LOCAL pipeline.clock='2026-10-29T23:00:00Z'; SET LOCAL pipeline.uuid='0';
CREATE FUNCTION pg_temp.pipeline_now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT current_setting('pipeline.clock')::timestamptz $$;
CREATE FUNCTION pg_temp.pipeline_uuid() RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE n bigint; BEGIN
  n:=current_setting('pipeline.uuid')::bigint+1; PERFORM set_config('pipeline.uuid',n::text,true);
  RETURN ('fabe1700-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; END $$;
CREATE TEMP TABLE pipeline_result(value jsonb);
CREATE TEMP TABLE pipeline_changes(table_name text,value jsonb,delta integer);
CREATE FUNCTION pg_temp.pipeline_audit() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN
  IF TG_OP<>'INSERT' THEN INSERT INTO pipeline_changes VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,to_jsonb(OLD),-1); END IF;
  IF TG_OP<>'DELETE' THEN INSERT INTO pipeline_changes VALUES(TG_TABLE_SCHEMA||'.'||TG_TABLE_NAME,to_jsonb(NEW),1); END IF;
  RETURN NULL; END $$;
CREATE FUNCTION pg_temp.pipeline_reset_sequences() RETURNS void LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind='S' AND n.nspname IN('public','private','analytics','net') LOOP
    EXECUTE format('ALTER SEQUENCE %s RESTART WITH 900000000',r.name);
  END LOOP;
  PERFORM set_config('pipeline.uuid','0',true);
END $$;
CREATE FUNCTION pg_temp.pipeline_install_audit() RETURNS void LANGUAGE plpgsql AS $$ DECLARE r record; BEGIN
  FOR r IN SELECT c.oid::regclass AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE c.relkind IN('r','p') AND NOT c.relispartition AND n.nspname IN('public','private','analytics','net') LOOP
    EXECUTE format('CREATE TRIGGER pipeline_night_audit AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION pg_temp.pipeline_audit()',r.name);
  END LOOP;
END $$;
`

export async function initialize(db) {
  await db.query('CREATE EXTENSION IF NOT EXISTS pg_buffercache WITH SCHEMA extensions;')
  await db.query(setup)
  const definitions = await db.json(`SELECT jsonb_agg(pg_get_functiondef(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN('public','private','analytics') AND p.prokind='f' AND p.prolang IN(SELECT oid FROM pg_language WHERE lanname IN('sql','plpgsql'))
      AND pg_get_functiondef(p.oid) ~ '(now|transaction_timestamp|clock_timestamp|gen_random_uuid)[(][)]';`)
  for (let offset = 0; offset < definitions.length; offset += 100) await db.query(definitions.slice(offset, offset + 100).map(definition => `${freeze(definition)};`).join('\n'))
  const defaults = await db.json(`SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT a.attrelid::regclass::text AS name,a.attname,pg_get_expr(d.adbin,d.adrelid) AS expression
      FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN('public','private','analytics','net') AND pg_get_expr(d.adbin,d.adrelid) ~ '(gen_random_uuid|now|clock_timestamp|transaction_timestamp)[(][)]') r;`)
  for (const row of defaults) await db.query(`ALTER TABLE ${row.name} ALTER COLUMN "${row.attname}" SET DEFAULT ${freeze(row.expression)};`)
  const context = await db.json(`SELECT to_jsonb(m)||jsonb_build_object('user_id',member.user_id,'season_year',s.season_year) FROM public.matchups m
    JOIN public.league_seasons s ON s.id=m.league_season_id AND s.is_current
    JOIN public.season_weeks w ON w.season_year=s.season_year AND w.week_number=m.week_number
    JOIN public.league_members member ON member.id=m.home_member_id
    WHERE DATE '2026-10-29' BETWEEN w.week_start AND w.week_end AND NOT m.is_voided ORDER BY m.id LIMIT 1;`)
  assert.ok(context?.id)
  const game = await db.json(`SELECT to_jsonb(g) FROM public.nba_games g WHERE game_date='2026-10-29' AND season_year=${context.season_year} ORDER BY id LIMIT 1;`)
  assert.ok(game?.id)
  await db.query(`UPDATE public.nba_games SET status='InProgress',started_at='2026-10-29T22:30:00Z',game_time='2026-10-29T22:30:00Z',live_stats_elapsed_seconds=NULL,live_scoreboard_elapsed_seconds=NULL WHERE id=${literal(game.id)};
    DELETE FROM private.live_feed_state WHERE game_id=${literal(game.id)};
    DELETE FROM private.game_stat_revisions WHERE game_id=${literal(game.id)};
    SELECT set_config('request.jwt.claim.sub',${literal(context.user_id)},true);`)
  const stats = await db.json(`SELECT jsonb_agg(jsonb_build_object('player_id',id,'game_id',${literal(game.id)},'is_home',nba_team=${literal(game.home_team)},
    'minutes_played',12,'points',10,'rebounds',4,'assists',3,'steals',1,'blocks',0,'turnovers',1,'personal_fouls',1,
    'offensive_rebounds',1,'defensive_rebounds',3,'field_goals_made',4,'field_goals_attempted',8,'three_pointers_made',1,
    'three_pointers_attempted',3,'free_throws_made',1,'free_throws_attempted',2,'plus_minus',2,'double_double',false,'triple_double',false,'did_not_play',false) ORDER BY id)
    FROM (SELECT id,nba_team FROM public.players WHERE nba_team IN(${literal(game.home_team)},${literal(game.away_team)}) ORDER BY id LIMIT 30) p;`)
  assert.ok(stats.length >= 10)
  const trade = await db.json(`SELECT to_jsonb(t)||jsonb_build_object('user_id',m.user_id) FROM public.trades t JOIN public.league_members m ON m.id=t.proposer_member_id WHERE t.status='pending' ORDER BY t.id LIMIT 1;`)
  const records = await db.json(`SELECT jsonb_agg(jsonb_build_object('provider_id',nba_id,'display_name',display_name,'nba_team',nba_team) ORDER BY id)
    FROM (SELECT * FROM public.players WHERE nba_id IS NOT NULL AND nba_team IS NOT NULL AND private.player_identity_team(nba_team) IS NOT NULL ORDER BY id LIMIT 30) p;`)
  const imports = records.map(row => ({ provider_id: row.provider_id, display_name: row.display_name, metadata: {} }))
  await db.query(`SAVEPOINT forecast_payload; SELECT public.prepare_matchup_forecast_inputs(${literal(context.id)});`)
  const forecastContext = await db.json(`SELECT public.get_prepared_matchup_forecast_context(${literal(context.id)});`)
  const { computeForecast } = await import('../../supabase/functions/matchup-forecast/compute.ts')
  const forecast = computeForecast(forecastContext)
  await db.query('ROLLBACK TO forecast_payload; RELEASE forecast_payload;')
  const contexts = await db.json(`SELECT jsonb_agg(to_jsonb(m)) FROM (SELECT DISTINCT ON(m.week_number) m.id,m.week_number
    FROM public.matchups m WHERE m.league_season_id=${literal(context.league_season_id)} AND m.week_number IN(3,4) AND NOT m.is_voided ORDER BY m.week_number,m.id) m;`)
  return { context, game, stats, trade, records, imports, forecast, contexts }
}

function scenarios(fixture) {
  const { context: c, game, stats, trade, records, imports, forecast } = fixture
  const id = literal(c.id), season = literal(c.league_season_id), league = literal(c.league_id)
  const snapshot = (source, elapsed, extra = {}) => literal(JSON.stringify({ source, source_updated_at: '2026-10-29T22:59:00Z', elapsed_seconds: elapsed, status: 'InProgress', home_score: 45, away_score: 43, status_text: 'Q2', stats, ...extra })) + '::jsonb'
  const ingest = `public.save_live_feed_snapshot_atomic(${literal(game.id)},${literal(game.nba_game_id)},${snapshot('nba', 1200)})`
  const prepare = `SELECT public.prepare_matchup_forecast_inputs(${id});`
  const payload = `(SELECT jsonb_agg(jsonb_build_object('id',m.id,'home_points',COALESCE(m.home_points,0)+1,'away_points',COALESCE(m.away_points,0))) FROM public.matchups m WHERE league_season_id=${season} AND week_number=${c.week_number})`
  const write = `public.update_score_points_atomic(${league},${season},${c.week_number},${payload})`
  const queue = `DELETE FROM private.work_items;
    SELECT private.work_enqueue((ARRAY['stats-sync','matchup-forecasts','refresh-views','live-poll','sync-scores','process-trades','player-injuries','trade-revaluation'])[1+(n-1)%8],
      'pipeline-'||n,pg_temp.pipeline_now()-interval '1 minute',jsonb_build_object('fixture',n,'leagueId',${league},'matchupId',${id})) FROM generate_series(1,24) n;`
  const cycle = `SET LOCAL pipeline.frame='0'; CREATE OR REPLACE FUNCTION pg_temp.pipeline_cycle() RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE frame integer:=current_setting('pipeline.frame')::integer+1; snapshot jsonb; saved integer; updated integer; dispatched integer; token jsonb; context jsonb;
    BEGIN
      PERFORM set_config('pipeline.frame',frame::text,true);
      snapshot:=${snapshot('nba', 1200)};
      snapshot:=snapshot||jsonb_build_object('source_updated_at',pg_temp.pipeline_now()-interval '30 seconds'+frame*interval '1 second',
        'elapsed_seconds',1200+frame*20,'home_score',45+frame,'stats',(SELECT jsonb_agg(row||jsonb_build_object('points',(row->>'points')::integer+frame)) FROM jsonb_array_elements(snapshot->'stats') row));
      saved:=public.save_live_feed_snapshot_atomic(${literal(game.id)},${literal(game.nba_game_id)},snapshot);
      token:=public.capture_score_inputs(${season},${c.week_number});
      updated:=${write};
      dispatched:=public.dispatch_work();
      context:=public.get_matchup_forecast_context(${id});
      RETURN jsonb_build_object('saved',saved,'updated',updated,'dispatched',dispatched,'token',token,'context',context,
        'visible',(SELECT jsonb_agg(to_jsonb(t) ORDER BY matchup_id) FROM public.matchup_totals t WHERE league_season_id=${season}));
    END $$;`
  return [
    ...['normal', 'shed', 'paused'].map(level => ({ name: `dispatch-${level}`, fn: 'dispatch_work', before: `${queue}
      UPDATE private.worker_controls SET paused=false,scheduler_level=${literal(level)},scheduler_last_dispatch_at=NULL,scheduler_checked_at=NULL WHERE id;
      ${level === 'normal' ? '' : "UPDATE private.work_items SET status='running',lease_token=pg_temp.pipeline_uuid(),lease_until=pg_temp.pipeline_now()+interval '5 minutes' WHERE id IN(SELECT id FROM private.work_items ORDER BY id LIMIT 4);"}`,
      expression: 'public.dispatch_work()' })),
    { name: 'trade-pending', fn: 'get_trade_revaluation_inputs', expression: `public.get_trade_revaluation_inputs(${literal(trade.user_id)},${literal(trade.proposer_member_id)},${literal(trade.id)})` },
    { name: 'live-new', fn: 'save_live_feed_snapshot_atomic', expression: ingest },
    { name: 'live-duplicate', fn: 'save_live_feed_snapshot_atomic', before: `SELECT ${ingest};`, expression: ingest },
    { name: 'live-fallback', fn: 'save_live_feed_snapshot_atomic', before: `SELECT ${ingest};`, expression: `public.save_live_feed_snapshot_atomic(${literal(game.id)},${literal(game.nba_game_id)},${snapshot('espn', 1260, { source_updated_at: '2026-10-29T22:59:30Z', home_score: 46, stats: stats.map(row => ({ ...row, points: 11 })) })})` },
    { name: 'live-cycle', fn: 'get_matchup_forecast_context', before: `${cycle} ${queue}
      UPDATE private.worker_controls SET paused=false,scheduler_level='shed',scheduler_last_dispatch_at=NULL,scheduler_checked_at=NULL WHERE id;
      UPDATE private.work_items SET status='running',lease_token=pg_temp.pipeline_uuid(),lease_until=pg_temp.pipeline_now()+interval '5 minutes' WHERE id IN(SELECT id FROM private.work_items ORDER BY id LIMIT 4);`, expression: 'pg_temp.pipeline_cycle()' },
    { name: 'context-unprepared', fn: 'get_matchup_forecast_context', before: `DELETE FROM private.forecast_player_history; DELETE FROM private.forecast_projection_inputs;`, expression: `public.get_matchup_forecast_context(${id})` },
    { name: 'context-prepared', fn: 'get_prepared_matchup_forecast_context', before: prepare, expression: `public.get_prepared_matchup_forecast_context(${id})` },
    { name: 'context-compatible', fn: 'get_matchup_forecast_context', before: prepare, expression: `public.get_matchup_forecast_context(${id})` },
    ...fixture.contexts.flatMap(row => [
      { name: `context-unprepared-week-${row.week_number}`, fn: 'get_matchup_forecast_context', before: `DELETE FROM private.forecast_player_history; DELETE FROM private.forecast_projection_inputs;`, expression: `public.get_matchup_forecast_context(${literal(row.id)})` },
      { name: `context-compatible-week-${row.week_number}`, fn: 'get_matchup_forecast_context', before: `SELECT public.prepare_matchup_forecast_inputs(${literal(row.id)});`, expression: `public.get_matchup_forecast_context(${literal(row.id)})` },
    ]),
    { name: 'forecast-read', fn: 'get_matchup_forecast', before: `INSERT INTO public.matchup_forecasts(matchup_id,league_id,input_revision,forecast,calculated_at,valid_until)
      VALUES(${id},${league},900,${literal(JSON.stringify(forecast))}::jsonb,pg_temp.pipeline_now(),'2026-10-30T00:00:00Z')
      ON CONFLICT(matchup_id) DO UPDATE SET forecast=EXCLUDED.forecast,valid_until=EXCLUDED.valid_until;`, expression: `public.get_matchup_forecast(${id})` },
    { name: 'matchup-write', fn: 'update_score_points_atomic', before: `SELECT ${ingest};`, expression: write },
    { name: 'prepare-fresh', fn: 'prepare_matchup_forecast_inputs', before: `DELETE FROM private.forecast_player_history; DELETE FROM private.forecast_projection_inputs; DELETE FROM private.forecast_season_points;`, expression: `public.prepare_matchup_forecast_inputs(${id})` },
    { name: 'prepare-reuse', fn: 'prepare_matchup_forecast_inputs', before: prepare, expression: `public.prepare_matchup_forecast_inputs(${id})` },
    { name: 'forecast-write', fn: 'complete_matchup_forecast', before: `${prepare}
      DELETE FROM private.forecast_refresh_requests;
      INSERT INTO private.matchup_forecast_queue(matchup_id,revision,dirty,claim_token,claimed_revision,claimed_at,claimed_fingerprint)
      VALUES(${id},900,true,'fabe1700-ffff-4000-8000-000000000001',900,pg_temp.pipeline_now(),'{"validUntil":"2026-10-30T00:00:00Z"}')
      ON CONFLICT(matchup_id) DO UPDATE SET revision=900,dirty=true,claim_token=EXCLUDED.claim_token,claimed_revision=900,claimed_at=EXCLUDED.claimed_at,claimed_fingerprint=EXCLUDED.claimed_fingerprint;`,
      expression: `public.complete_matchup_forecast(${id},900,'fabe1700-ffff-4000-8000-000000000001',${literal(JSON.stringify(forecast))}::jsonb,'2026-10-30T00:00:00Z')` },
    { name: 'link-players', fn: 'link_player_sources_atomic', expression: `public.link_player_sources_atomic('nba',${literal(JSON.stringify(records))}::jsonb,false)` },
    { name: 'resolve-players', fn: 'resolve_player_imports_atomic', expression: `public.resolve_player_imports_atomic('nba_cdn',${literal(JSON.stringify(imports))}::jsonb)` },
    { name: 'capture-score', fn: 'capture_score_inputs', expression: `public.capture_score_inputs(${season},${c.week_number})` },
    ...['empty','due','throttled'].map(state => ({ name: `hints-${state}`, fn: 'flush_player_stats_hints', schema: 'private',
      before: `DELETE FROM private.player_stats_hint_pending;
        ${state === 'empty' ? '' : `INSERT INTO public.league_change_hints(league_id,topic,revision,updated_at) VALUES(${league},'score',1,pg_temp.pipeline_now()${state === 'due' ? "-interval '2 minutes'" : ''})
          ON CONFLICT(league_id,topic) DO UPDATE SET updated_at=EXCLUDED.updated_at;
          INSERT INTO private.player_stats_hint_pending(league_id) VALUES(${league});`}`,
      expression: 'private.flush_player_stats_hints()' })),
    { name: 'poll-work', fn: 'get_live_poll_work', expression: `(SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM public.get_live_poll_work('2026-10-29T23:00:00Z') w)` },
  ]
}

async function counters(db) {
  return await db.json(`SELECT COALESCE(jsonb_agg(to_jsonb(s)),'[]') FROM (SELECT queryid::text,userid::text,toplevel,calls,rows,total_exec_time
    FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database())) s;`)
}

async function measure(db, expression) {
  const batchSize = Number(process.env.PIPELINE_BATCH_SIZE ?? 1)
  assert.ok(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 20)
  const writeSql = `SELECT COALESCE(jsonb_object_agg(relid::text,jsonb_build_object('table',schemaname||'.'||relname,'insert',n_tup_ins,'update',n_tup_upd,'delete',n_tup_del)),'{}') FROM pg_stat_xact_user_tables WHERE schemaname IN('public','private','analytics','net');`
  const writesBefore = await db.json(writeSql)
  const before = await counters(db)
  await db.query("SET LOCAL pg_stat_statements.track='all';")
  const plan = (await db.json(`EXPLAIN (ANALYZE,BUFFERS,WAL,TIMING OFF,FORMAT JSON) INSERT INTO pipeline_result SELECT COALESCE(to_jsonb(${expression}),'null'::jsonb) FROM generate_series(1,${batchSize});`))[0]
  await db.query("SET LOCAL pg_stat_statements.track='none';")
  const after = await counters(db)
  const key = row => `${row.queryid}/${row.userid}/${row.toplevel}`
  const old = new Map(before.map(row => [key(row), row]))
  const deltas = after.map(row => {
    const previous = old.get(key(row)) ?? {}
    return { queryid: row.queryid, userid: row.userid, toplevel: row.toplevel, calls: row.calls - (previous.calls ?? 0), ms: row.total_exec_time - (previous.total_exec_time ?? 0), rows: row.rows - (previous.rows ?? 0) }
  }).filter(row => row.calls > 0)
  const texts = await db.json(`SELECT COALESCE(jsonb_object_agg(queryid::text||'/'||userid::text||'/'||toplevel::text,query),'{}') FROM extensions.pg_stat_statements
    WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND queryid::text=ANY(ARRAY[${[...new Set(deltas.map(row => literal(row.queryid)))].join(',')}]::text[]);`)
  const statements = deltas.map(row => ({ ...row, query: texts[key(row)] ?? '' })).filter(row => !(row.toplevel && row.query.startsWith('EXPLAIN ')))
  const value = await db.json(`WITH removed AS(DELETE FROM pipeline_result RETURNING value) SELECT ${batchSize === 1 ? '(jsonb_agg(value))->0' : 'jsonb_agg(value)'} FROM removed;`)
  const writesAfter = await db.json(writeSql)
  const written = Object.fromEntries(Object.entries(writesAfter).flatMap(([id, row]) => {
    const count = ['insert', 'update', 'delete'].reduce((sum, key) => sum + row[key] - (writesBefore[id]?.[key] ?? 0), 0)
    return count ? [[row.table, count / batchSize]] : []
  }))
  const followup = await db.json(`SELECT jsonb_build_object('work',(SELECT count(*) FROM private.work_items WHERE status IN('pending','running','failed')),
    'forecast',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'live',(SELECT count(*) FROM private.live_matchup_refresh_queue),
    'requests',(SELECT count(*) FROM net.http_request_queue));`)
  return { batchSize, ms: plan['Execution Time'] / batchSize, hit: (plan.Plan['Shared Hit Blocks'] ?? 0) / batchSize, read: (plan.Plan['Shared Read Blocks'] ?? 0) / batchSize,
    wal: (plan.Plan['WAL Bytes'] ?? 0) / batchSize, statements: statements.reduce((sum, row) => sum + row.calls, 0) / batchSize, nested: statements, value,
    rowsWritten: Object.values(written).reduce((sum, count) => sum + count, 0), written, followup }
}

async function quality(db, scenario, control, install = true) {
  await db.query(`${install ? 'SELECT pg_temp.pipeline_install_audit();' : ''} TRUNCATE pipeline_changes;`)
  const values = []
  for (let step = 0; step < 2; step++) values.push(await db.json(`SELECT COALESCE(to_jsonb(${scenario.expression}),'null'::jsonb);`))
  if (control === 'control-rows') await db.query("UPDATE public.nba_games SET home_score=COALESCE(home_score,0)+1 WHERE id='48acf097-32ca-416f-a1ca-c850735f5443';")
  const rows = await db.json(`SELECT COALESCE(jsonb_object_agg(table_name,changes),'{}') FROM (
    SELECT table_name,jsonb_agg(jsonb_build_object('row',value,'delta',delta) ORDER BY value::text) AS changes FROM (
      SELECT table_name,value,sum(delta) AS delta FROM pipeline_changes GROUP BY table_name,value HAVING sum(delta)<>0
    ) diff GROUP BY table_name) tables;`)
  const followup = await db.json(`SELECT jsonb_build_object('work',(SELECT COALESCE(jsonb_agg(jsonb_build_array(kind,status,key,payload) ORDER BY kind,status,key),'[]') FROM private.work_items),
    'forecast',(SELECT count(*) FROM private.matchup_forecast_queue WHERE dirty),'live',(SELECT count(*) FROM private.live_matchup_refresh_queue),
    'requests',(SELECT count(*) FROM net.http_request_queue));`)
  const freshness = await db.json(`SELECT COALESCE(max(live_stats_elapsed_seconds),0) FROM public.nba_games WHERE game_date='2026-10-29';`)
  return { values, rows, followup, freshness }
}

async function run() {
  assert.equal(process.cwd(), local ? path.join(homedir(), 'Worktrees/pancake-l7') : path.join(lane, 'repo'))
  if (local) assert.equal(process.env.DOCKER_CONTEXT, 'desktop-linux')
  assert.equal(process.versions.node.split('.')[0], '22')
  const limits = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .HostConfig}}', 'supabase_db_pt4bafablel7'], { encoding: 'utf8' }))
  assert.equal(limits.NanoCpus, 2e9)
  assert.equal(limits.Memory, 1024 ** 3)
  let db = new Database()
  const mode = process.argv[2] ?? 'baseline'
  const selected = process.argv[3]
  const output = process.argv[4] ?? `${mode}${selected ? `-${selected}` : ''}`
  const extraWarmup = Number(process.env.PIPELINE_WARMUP_CALLS ?? 0)
  const evictShared = process.env.PIPELINE_EVICT_SHARED === '1'
  const nativeClock = process.env.PIPELINE_NATIVE_CLOCK === '1'
  assert.ok(Number.isSafeInteger(extraWarmup) && extraWarmup >= 0 && extraWarmup <= 50)
  const reportFile = path.join(lane, 'evidence', `${output}.json`)
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const resume = process.env.PIPELINE_RESUME === '1' && existsSync(reportFile)
  const report = resume ? JSON.parse(readFileSync(reportFile, 'utf8')) : { mode, selected, extraWarmup, evictShared, nativeClock, baseline: '952580ce3204598d1fd120b3f121d166c7626028', source, concurrent: true, started: new Date().toISOString(), samples: [], quality: [] }
  assert.equal(report.mode, mode)
  assert.equal(report.evictShared, evictShared)
  assert.equal(report.nativeClock, nativeClock)
  const completed = new Set(report.quality.filter(row => report.samples.filter(sample => sample.name === row.name).length === 20).map(row => row.name))
  report.samples = report.samples.filter(row => completed.has(row.name))
  report.quality = report.quality.filter(row => completed.has(row.name))
  report.attemptSources = [...new Set([...(report.attemptSources ?? [report.source]), source])]
  delete report.finished
  try {
    const fixture = await initialize(db)
    report.fixture = { context: fixture.context.id, game: fixture.game.id, players: fixture.stats.length, trade: fixture.trade.id, queue: 24 }
    let cases = scenarios(fixture)
    if (selected) cases = cases.filter(row => row.fn === selected || row.name === selected)
    cases = cases.filter(row => !completed.has(row.name))
    if (resume && !cases.length) return
    assert.ok(cases.length)
    const files = [...new Set(cases.map(row => row.fn))]
    const baseline = {}, candidate = {}
    for (const fn of files) {
      baseline[fn] = freeze(execFileSync('git', ['show', `${report.baseline}:supabase/sql/functions/by-name/${cases.find(row => row.fn === fn).schema ?? 'public'}/${fn}.sql`], { encoding: 'utf8' }))
      candidate[fn] = freeze(readFileSync(`supabase/sql/functions/by-name/${cases.find(row => row.fn === fn).schema ?? 'public'}/${fn}.sql`, 'utf8'))
      if (mode === 'generic') candidate[fn] = candidate[fn].replace(/AS \$\$/, () => 'SET plan_cache_mode = force_generic_plan AS $$')
      if (mode === 'control-values') candidate[fn] = candidate[fn].replace('RETURN v_changed;', 'RETURN v_changed + 1;')
    }
    const variants = (process.env.PIPELINE_VARIANTS ?? '').split(',').filter(Boolean)
    const variantSql = Object.fromEntries(['baseline', 'candidate'].map(phase => [phase, variants.map(file => freeze(phase === 'baseline' ? execFileSync('git', ['show', `${report.baseline}:supabase/sql/functions/by-name/${file}.sql`], { encoding: 'utf8' }) : readFileSync(`supabase/sql/functions/by-name/${file}.sql`, 'utf8'))).join('\n')]))
    const reset = async (scenario, phase) => {
      await db.query(`ROLLBACK TO scenario_base; ${phase === 'baseline' ? baseline[scenario.fn] : candidate[scenario.fn]} ${variantSql[phase]}
        SELECT pg_temp.pipeline_reset_sequences(); ${scenario.before ?? ''}`)
      if (scenario.name.startsWith('dispatch-') || scenario.name === 'live-cycle') {
        const queue = await db.json("SELECT jsonb_build_object('depth',count(*),'busy',count(*) FILTER(WHERE status='running' AND lease_until>pg_temp.pipeline_now())) FROM private.work_items WHERE key LIKE 'pipeline-%';")
        assert.equal(queue.depth, 24, 'The dispatcher fixture must contain 24 distinct jobs')
        assert.equal(queue.busy, scenario.name === 'dispatch-normal' ? 0 : 4, 'The shed fixture must have four unexpired leases')
      }
    }
    for (const [index, scenario] of cases.entries()) {
      if (index) {
        await db.query('ROLLBACK;')
        await db.close()
        db = new Database()
        await initialize(db)
      }
      await db.query('SAVEPOINT scenario_base;')
      await reset(scenario, 'baseline')
      const before = await quality(db, scenario)
      if (scenario.name === 'live-cycle') {
        await db.query(`DO $undo$ DECLARE r record; predicate text; BEGIN
          PERFORM set_config('session_replication_role','replica',true);
          FOR r IN SELECT table_name,value,sum(delta) AS delta FROM pipeline_changes GROUP BY table_name,value HAVING sum(delta)>0 LOOP
            SELECT string_agg(format('%I IS NOT DISTINCT FROM ($1->>%L)::%s',a.attname,a.attname,format_type(a.atttypid,a.atttypmod)),' AND ') INTO predicate
              FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) k(attnum)
              JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
              WHERE i.indrelid=r.table_name::regclass AND i.indisprimary;
            EXECUTE format('DELETE FROM %s stored WHERE %s',r.table_name,coalesce(predicate,'to_jsonb(stored)=$1')) USING r.value;
          END LOOP;
          FOR r IN SELECT table_name,value,sum(delta) AS delta FROM pipeline_changes GROUP BY table_name,value HAVING sum(delta)<0 LOOP
            EXECUTE format('INSERT INTO %s OVERRIDING SYSTEM VALUE SELECT (jsonb_populate_record(NULL::%s,$1)).*',r.table_name,r.table_name) USING r.value;
          END LOOP;
          PERFORM set_config('session_replication_role','origin',true);
        END; $undo$;
        ${candidate[scenario.fn]} ${variantSql.candidate}
        SELECT pg_temp.pipeline_reset_sequences(); ${scenario.before ?? ''}`)
      } else await reset(scenario, 'candidate')
      const after = await quality(db, scenario, mode, scenario.name !== 'live-cycle')
      try { assertEquivalent(before, after) } catch (error) {
        writeFileSync(path.join(lane, 'evidence', `${output}-failed-quality.json`), JSON.stringify({ scenario: scenario.name, before, after }, null, 2))
        throw new Error(`${scenario.name}: ${error.message.split('\n')[0]}`)
      }
      report.quality.push({ name: scenario.name, pass: true, touched: Object.keys(before.rows), rowDiff: before.rows, values: before.values,
        hash: createHash('sha256').update(JSON.stringify(before)).digest('hex') })
      process.stdout.write(`Quality ${scenario.name}: pass (${Object.keys(before.rows).length} tables)\n`)
      if (process.env.PIPELINE_QUALITY_ONLY === '1') continue
      for (let round = 0; round < 5; round++) {
        await db.query('ROLLBACK;')
        await db.close()
        db = new Database()
        await initialize(db)
        await db.query('SAVEPOINT scenario_base;')
        for (const phase of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          await reset(scenario, phase)
          await db.query('DISCARD PLANS;')
          let evicted = 0
          if (evictShared) {
            await db.query('CHECKPOINT;')
            evicted = await db.json('SELECT count(*) FROM extensions.pg_buffercache WHERE relfilenode IS NOT NULL AND extensions.pg_buffercache_evict(bufferid);')
          }
          for (const cache of ['fresh', 'warm']) {
            if (cache === 'warm' && extraWarmup) for (let call = 0; call < extraWarmup; call++) await db.query(`SELECT ${scenario.expression};`)
            const measured = await measure(db, scenario.expression)
            report.samples.push({ name: scenario.name, fn: scenario.fn, phase, round, cache, evicted: cache === 'fresh' ? evicted : 0, ...measured })
          }
        }
      }
      const comparisons = Object.fromEntries(['fresh', 'warm'].map(cache => [cache, comparePairs(report.samples.filter(row => row.name === scenario.name && row.cache === cache))]))
      process.stdout.write(`${scenario.name}: ${JSON.stringify(comparisons)}\n`)
      writeFileSync(path.join(lane, 'evidence', `${output}.json`), JSON.stringify(report, null, 2))
    }
    await db.query('ROLLBACK;')
  } finally {
    await db.close()
    report.finished = new Date().toISOString()
    mkdirSync(path.join(lane, 'evidence'), { recursive: true })
    writeFileSync(path.join(lane, 'evidence', `${output}.json`), JSON.stringify(report, null, 2))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run()
