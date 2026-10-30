import assert from 'node:assert/strict'
import { createECDH, createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const lane = path.join(homedir(), 'pancake-t_4ba51e0d/lanes/fable-a4')
assert.equal(process.cwd(), path.join(lane, 'repo'))
const evidence = path.join(lane, 'evidence')
mkdirSync(evidence, { recursive: true })
const direct=process.argv.includes('--direct')
const localConnection=()=>{
  for(let attempt=0;attempt<12;attempt++) {
    const status=spawnSync('supabase',['status','-o','json'],{encoding:'utf8',timeout:10000})
    if(status.status===0) {
      try { return new URL(JSON.parse(status.stdout).DB_URL) } catch { throw new Error('Private stack connection is unavailable') }
    }
    if(attempt===11) throw new Error('Private stack status is unavailable')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000)
  }
}
const connection=direct?localConnection():null
const password=connection?decodeURIComponent(connection.password):null
if(connection) {
  assert.ok(['localhost','127.0.0.1'].includes(connection.hostname))
  assert.equal(connection.port,'64622')
  connection.password=''
}
const sql = input => execFileSync(direct?'psql':'docker', direct?[connection.toString(),'-w','-XqAt','-v','ON_ERROR_STOP=1']:['exec', '-i', 'supabase_db_pt4bafablea4', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,...(direct?{env:{...process.env,PGPASSWORD:password}}:{}) })
const literal = value => `'${String(value).replaceAll("'", "''")}'`
const save = (name, data) => writeFileSync(path.join(evidence, name), `${JSON.stringify(data, null, 2)}\n`)
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const fixture = JSON.parse(sql(`SELECT jsonb_build_object('league',l.id,'season',s.id,'year',s.season_year,
'members',(SELECT jsonb_agg(to_jsonb(m)) FROM (SELECT id,user_id,role FROM public.league_members WHERE league_id=l.id ORDER BY role::text,id LIMIT 3)m),
'visiblePlayers',(SELECT jsonb_agg(id) FROM (SELECT id FROM public.players ORDER BY id LIMIT 50)p),
'players',(SELECT jsonb_agg(player_id) FROM (SELECT DISTINCT player_id FROM public.roster_players WHERE league_id=l.id ORDER BY player_id LIMIT 20)p),
'matchup',(SELECT id FROM public.matchups WHERE league_id=l.id ORDER BY EXISTS(SELECT 1 FROM public.matchup_forecasts f WHERE f.matchup_id=public.matchups.id) DESC,week_number DESC,id LIMIT 1),
'today',(now() AT TIME ZONE 'America/New_York')::date,
'date',(SELECT max(game_date) FROM public.player_game_stats WHERE season_year=s.season_year))
FROM public.leagues l JOIN public.league_seasons s ON s.league_id=l.id AND s.is_current
WHERE l.deleted_at IS NULL AND (SELECT count(*) FROM public.league_members WHERE league_id=l.id)>=3
ORDER BY (SELECT count(*) FROM public.roster_players WHERE league_id=l.id) DESC,l.id LIMIT 1;`))
assert.equal(fixture.members.length, 3)
assert.ok(fixture.players.length)
const league = literal(fixture.league)
const playerIds = `ARRAY[${fixture.players.map(id => `${literal(id)}::uuid`).join(',')}]`
const profileKey = createECDH('prime256v1')
profileKey.setPrivateKey(Buffer.alloc(32,1))
const profilePublicKey = literal(profileKey.getPublicKey().toString('base64url'))
const cases = []
for (const [index, member] of fixture.members.entries()) {
  const add = (name, expression, setup = '', role = 'authenticated') => cases.push({ name, manager: index + 1, user: member.user_id, expression, setup, role })
  const promote = `UPDATE public.league_members SET role='co_commissioner' WHERE id=${literal(member.id)};`
  add('get_league_projection_rows', `public.get_league_projection_rows(${league},${fixture.year},${literal(fixture.date)},'today',${playerIds},20,0)`)
  add('get_dynasty_forecast_inputs', `public.get_dynasty_forecast_inputs(${league},${literal(member.id)},${fixture.year},${playerIds},'',20,0)`)
  add('search_players', `public.search_players(p_league_id=>${league},p_season_year=>${fixture.year})`)
  add('get_visible_player_totals', `public.get_visible_player_totals(${league},${playerIds},${fixture.year})`)
  add('get_member_transaction_state', `public.get_member_transaction_state(${literal(member.id)},${league})`)
  add('get_league_activity_feed', `public.get_league_activity_feed(${league},50,0)`)
  add('notif_list_announcements', `public.notif_list_announcements(${league})`)
  add('view_team_timeline', `public.view_team_timeline(${league},${literal(member.id)})`)
  if (fixture.matchup) add('get_matchup_forecast', `public.get_matchup_forecast(${literal(fixture.matchup)})`)
  add('create_league', "public.create_league('Action measurement','Action team',200)")
  add('delete_league_atomic', `public.delete_league_atomic(${league})`, promote)
  add('update_league_configuration_atomic', `public.update_league_configuration_atomic(${league},'{"weekly_add_limit":9}'::jsonb)`, promote)
  add('save_client_settings_team', `public.save_client_settings_atomic('team',${literal(JSON.stringify({ memberId: member.id, teamName: 'Action team' }))}::jsonb)`)
  add('save_client_settings_notifications', `public.save_client_settings_atomic('notifications',${literal(JSON.stringify({ userId: member.user_id, tradeEnabled: true, waiverEnabled: true, draftEnabled: true, activityEnabled: true }))}::jsonb)`)
  add('save_client_settings_optimizer', `public.save_client_settings_atomic('lineup_optimizer',${literal(JSON.stringify({ memberId: member.id, leagueId: fixture.league, seasonId: fixture.season, enabled: true }))}::jsonb)`)
  add('notif_publish_announcement_atomic', `public.notif_publish_announcement_atomic(${league},'Action announcement','ab123400-0000-4000-8000-000000000001')`, promote)
  add('profile_subscribe', `public.register_web_push_atomic(${literal(member.user_id)},'https://fcm.googleapis.com/fcm/send/league-actions-local-only',${profilePublicKey},repeat('A',22),0,repeat('a',64),repeat('b',64))`, '', 'service_role')
  add('profile_test_lookup', `(SELECT user_id,endpoint,p256dh,auth,updated_at FROM public.web_push_subscriptions WHERE user_id=${literal(member.user_id)})`, '', 'service_role')
  add('profile_unsubscribe', `public.clear_web_push_for_user_atomic(${literal(member.user_id)},'https://fcm.googleapis.com/fcm/send/league-actions-local-only',repeat('b',64))`, '', 'service_role')
  const playoffSetup = `${promote}UPDATE public.matchups SET is_finalized=true WHERE league_id=${league} AND matchup_type='regular_season';`
  add('playoffs_advance', `public.advance_playoff_bracket_atomic(${league})`, `${playoffSetup}DO $bracket$ BEGIN PERFORM public.generate_playoff_bracket_atomic(${league}); END $bracket$;UPDATE public.matchups SET is_finalized=true,winner_member_id=home_member_id WHERE league_id=${league} AND matchup_type<>'regular_season';`, 'service_role')
  add('playoffs_generate', `public.generate_playoff_bracket_atomic(${league})`, playoffSetup, 'service_role')
  add('league_playoff_fit', `(SELECT jsonb_build_object('weeks',coalesce(jsonb_agg(week_number),'[]')) FROM public.season_weeks WHERE season_year=(SELECT (payload->>'season_year')::integer FROM action_preflight WHERE payload ? 'season_year'))`, promote, 'service_role')
  add('games_today', `(SELECT jsonb_build_object('games',coalesce(jsonb_agg(to_jsonb(g)-'game_time' ORDER BY g.game_time NULLS LAST,g.status,g.id),'[]')) FROM (SELECT id,nba_game_id,home_team,away_team,home_score,away_score,status,game_status_text,game_date,game_time FROM public.nba_games WHERE game_date=${literal(fixture.today)})g)` , '', 'service_role')
}
if (process.argv.includes('--variants') || process.argv.includes('--timer-locks')) for (const [index, member] of fixture.members.entries()) {
  const add = (name, variant, expression, setup = '') => cases.push({ name, variant, manager: index + 1, user: member.user_id, expression, setup, role: 'authenticated' })
  for (const [variant,status,mock,armed] of [['pending-board','pending',false,false],['live-board','in_progress',false,true],['mock-board','in_progress',true,true]]) {
    const setup=`UPDATE public.league_members SET role='co_commissioner' WHERE id=${literal(member.id)};
UPDATE public.drafts SET status='completed' WHERE league_id=${league} AND draft_type='snake' AND NOT is_mock AND status IN ('pending','in_progress','paused');
DO $board$ DECLARE draft uuid:='ab123400-0000-4000-8000-0000000000dd'; members uuid[]; seats int; BEGIN
SELECT array_agg(id ORDER BY id) INTO members FROM public.league_members WHERE league_id=${league}; seats:=cardinality(members);
INSERT INTO public.drafts(id,league_id,league_season_id,draft_type,status,is_mock,rounds) VALUES(draft,${league},${literal(fixture.season)},'snake',${literal(status)},${mock},3);
INSERT INTO public.snake_draft_picks(draft_id,overall_pick,round,pick_in_round,member_id,timer_expires_at)
SELECT draft,n,1+(n-1)/seats,1+(n-1)%seats,members[1+(n-1)%seats],CASE WHEN n=1 AND ${armed} THEN now()+interval '60 seconds' ELSE NULL END FROM generate_series(1,seats*3)n;
END $board$;`
    add('delete_league_atomic',variant,`public.delete_league_atomic(${league})`,setup)
  }
  add('get_league_projection_rows','player-route',`public.get_league_projection_rows(${league},${fixture.year},${literal(fixture.date)},'today',ARRAY[${literal(fixture.players[0])}::uuid],1,0)`)
  add('get_league_projection_rows','default-wide',`public.get_league_projection_rows(${league},${fixture.year},${literal(fixture.date)},'today',NULL,600,0)`)
  add('get_dynasty_forecast_inputs','default-wide',`public.get_dynasty_forecast_inputs(${league},${literal(member.id)},${fixture.year},NULL,'',600,0)`)
  add('search_players','bounded',`public.search_players(p_league_id=>${league},p_include_player_ids=>${playerIds},p_season_year=>${fixture.year})`)
  add('search_players','search',`public.search_players(p_league_id=>${league},p_query=>'a',p_season_year=>${fixture.year})`)
  for (const view of ['today','week_avg','week_total','invalid']) for (const [label, ids] of [['all','NULL'],['empty','ARRAY[]::uuid[]'],['one',`ARRAY[${literal(fixture.players[0])}::uuid]`]]) {
    add('get_league_projection_rows',`${view}-${label}`,`public.get_league_projection_rows(${league},${fixture.year},${literal(fixture.date)},${literal(view)},${ids},20,0)`)
  }
  for (const [label, year, ids, limit, offset] of [['historical',fixture.year-1,playerIds,20,0],['missing-season',0,playerIds,20,0],['clamped',fixture.year,playerIds,0,-1],['page',fixture.year,playerIds,3,1],['duplicates',fixture.year,`ARRAY[${literal(fixture.players[0])}::uuid,${literal(fixture.players[0])}::uuid]`,20,0]]) {
    add('get_league_projection_rows',label,`public.get_league_projection_rows(${league},${year},${literal(fixture.date)},'today',${ids},${limit},${offset})`)
  }
  add('get_visible_player_totals','fractional',`public.get_visible_player_totals(${league},${playerIds},${fixture.year})`,`UPDATE public.leagues SET status='setup',scoring_settings=scoring_settings||'{"points":1.337}'::jsonb WHERE id=${league};`)
  const visibleIds=`ARRAY[${fixture.visiblePlayers.map(id=>`${literal(id)}::uuid`).join(',')}]`
  for (const [variant,ids,year] of [['empty','ARRAY[]::uuid[]',fixture.year],['one',`ARRAY[${literal(fixture.players[0])}::uuid]`,fixture.year],['duplicates',`ARRAY[${literal(fixture.players[0])}::uuid,${literal(fixture.players[0])}::uuid]`,fixture.year],['historical',playerIds,fixture.year-1],['missing-season',playerIds,0],['maximum',visibleIds,fixture.year]]) {
    add('get_visible_player_totals',variant,`public.get_visible_player_totals(${league},${ids},${year})`)
  }
  const outsider = 'ab123400-0000-4000-8000-000000000099'
  for (const [variant,user,id,setup,code] of [
    ['anonymous','',fixture.league,'','42501'],
    ['outsider',outsider,fixture.league,'','42501'],
    ['ordinary-member',member.user_id,fixture.league,`UPDATE public.league_members SET role='manager' WHERE id=${literal(member.id)};`,'42501'],
    ['missing',member.user_id,outsider,'','P0002'],
    ['already-deleted',member.user_id,fixture.league,`UPDATE public.league_members SET role='co_commissioner' WHERE id=${literal(member.id)};UPDATE public.leagues SET deleted_at=now()-interval '1 day' WHERE id=${league};`,null]
  ]) {
    add('delete_league_atomic',variant,`public.delete_league_atomic(${literal(id)}::uuid)`,setup)
    cases.at(-1).user=user
    if (code) cases.at(-1).expectError=code
  }
  for (const [variant,ids,year,memberId] of [
    ['duplicates',`ARRAY[${literal(fixture.players[0])}::uuid,${literal(fixture.players[0])}::uuid]`,fixture.year,member.id],
    ['historical',playerIds,fixture.year-1,member.id],
    ['missing-season',playerIds,0,member.id],
    ['missing-member',playerIds,fixture.year,outsider]
  ]) add('get_dynasty_forecast_inputs',variant,`public.get_dynasty_forecast_inputs(${league},${literal(memberId)}::uuid,${year},${ids},'',20,0)`)
  add('get_league_projection_rows','outsider',`public.get_league_projection_rows(${league},${fixture.year},${literal(fixture.date)},'today',${playerIds},20,0)`)
  cases.at(-1).user = outsider
  add('get_dynasty_forecast_inputs','outsider',`public.get_dynasty_forecast_inputs(${league},${literal(member.id)},${fixture.year},${playerIds},'',20,0)`)
  cases.at(-1).user = outsider
  add('get_visible_player_totals','outsider',`public.get_visible_player_totals(${league},${playerIds},${fixture.year})`)
  cases.at(-1).user=outsider
  cases.at(-1).expectError='42501'
  for (const [variant,ids] of [['null','NULL'],['over-limit',`array_fill(${literal(fixture.players[0])}::uuid,ARRAY[51])`]]) {
    add('get_visible_player_totals',variant,`public.get_visible_player_totals(${league},${ids},${fixture.year})`)
    cases.at(-1).expectError='22023'
  }
  for (const [label, ids, query, limit, offset] of [['all','NULL','',20,0],['empty','ARRAY[]::uuid[]','',20,0],['search',playerIds,'a',3,1],['clamped',playerIds,'',0,-2]]) {
    add('get_dynasty_forecast_inputs',label,`public.get_dynasty_forecast_inputs(${league},${literal(member.id)},${fixture.year},${ids},${literal(query)},${limit},${offset})`)
  }
}
const selected = cases.filter(row => (!process.argv.includes('--capture') || !row.expectError) && (!option('only') || option('only').split(',').includes(row.name)) && (!option('variant') || option('variant').split(',').includes(row.variant ?? 'default')))
const files = option('candidate') ? option('candidate').split(',') : []
const candidateParts=files.map(file => readFileSync(file, 'utf8').replace(/^BEGIN;\s*/, '').replace(/\s*COMMIT;\s*$/, ''))
const candidate = candidateParts.join('\n')
const names = [...new Set([...candidate.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\(/g)].map(match => `${match[1]}/${match[2]}.sql`))]
const baselineParts=names.map(file => execFileSync('git', ['show', `952580ce:supabase/sql/functions/by-name/${file}`], { encoding: 'utf8' }))
const baseline = baselineParts.join('\n')
const versions = candidate ? { baseline, candidate } : { baseline: '' }
const scoped=process.argv.includes('--scoped')
if(scoped) {
  assert.ok(names.every(name=>['public/get_dynasty_forecast_inputs.sql','public/get_visible_player_totals.sql','public/delete_league_atomic.sql'].includes(name)))
  assert.equal(names.length,candidateParts.length)
  assert.ok(candidateParts.every(part=>[...part.matchAll(/CREATE OR REPLACE FUNCTION/g)].length===1))
}
const actionDefinition=(row,version)=>scoped?names.flatMap((name,index)=>{
  const signature=name.replace('/','.').replace('.sql','')+'('
  if(!row.expression.includes(signature)) return []
  return version==='baseline'?[baselineParts[index]]:candidateParts.filter(part=>part.includes(`CREATE OR REPLACE FUNCTION ${signature}`))
}).join('\n'):versions[version]
const context = row => `${row.setup}\nSET CONSTRAINTS ALL IMMEDIATE;SET CONSTRAINTS ALL DEFERRED;SET LOCAL request.jwt.claim.sub=${literal(row.user)};SET LOCAL request.jwt.claims=${literal(JSON.stringify({ sub: row.user || null, role: row.role }))};SET LOCAL request.headers='{"x-request-id":"ab123400-0000-4000-8000-000000000002"}';`
const scalars = new Set(['create_league','delete_league_atomic','update_league_configuration_atomic','save_client_settings_team','save_client_settings_notifications','save_client_settings_optimizer','notif_publish_announcement_atomic','view_team_timeline','get_matchup_forecast','games_today','playoffs_advance','playoffs_generate','league_playoff_fit'])
const invoke = row => `SET LOCAL ROLE ${row.role};${['playoffs_advance','playoffs_generate','league_playoff_fit'].includes(row.name)?`INSERT INTO action_preflight SELECT jsonb_build_object('role',role) FROM public.league_members WHERE league_id=${league} AND user_id=${literal(row.user)};`:''}${row.name==='league_playoff_fit'?`INSERT INTO action_preflight SELECT jsonb_build_object('season_year',season_year) FROM public.league_seasons WHERE league_id=${league} AND is_current;`:''}INSERT INTO action_result SELECT ${scalars.has(row.name) ? `COALESCE(to_jsonb(${row.expression})::text,'null')` : `COALESCE(jsonb_agg(to_jsonb(result)),'[]'::jsonb)::text FROM ${row.expression} result`};${row.name === 'profile_subscribe' ? `INSERT INTO action_quota_rows SELECT endpoint,user_id,updated_at FROM public.web_push_subscriptions WHERE user_id=${literal(row.user)} ORDER BY updated_at DESC,endpoint OFFSET 10 LIMIT 51;` : ''}RESET ROLE;SET CONSTRAINTS ALL IMMEDIATE;`
const prefix = `BEGIN;SET LOCAL statement_timeout='60s';CREATE TEMP TABLE action_result(response text);CREATE TEMP TABLE action_preflight(payload jsonb);CREATE TEMP TABLE action_quota_rows(endpoint text,user_id uuid,updated_at timestamptz);GRANT ALL ON action_result,action_preflight,action_quota_rows TO authenticated,service_role;`
const restoreSequences = `DO $reset$ DECLARE item record; BEGIN FOR item IN SELECT * FROM action_sequences LOOP PERFORM setval(item.name::regclass,item.value,item.called); END LOOP; END $reset$;`
const stats = `SELECT jsonb_build_object('statements',COALESCE(jsonb_agg(to_jsonb(s)),'[]')) FROM (SELECT query,toplevel,calls,total_plan_time,total_exec_time,shared_blks_hit,shared_blks_read,rows,wal_records,wal_bytes FROM extensions.pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query NOT LIKE '%pg_stat_statements%')s;`
if (process.argv.includes('--timer-locks')) {
  const definition=readFileSync('supabase/sql/functions/by-name/public/delete_league_atomic.sql','utf8')
  const statement=definition.slice(definition.indexOf('  WITH unfilled AS MATERIALIZED'),definition.indexOf('\n\n  UPDATE drafts')).replaceAll('p_league_id',`${league}::uuid`)
  assert.ok(statement.startsWith('  WITH unfilled AS MATERIALIZED'))
  const results=[]
  for (const row of selected.filter(row=>row.name==='delete_league_atomic' && ['pending-board','live-board','mock-board'].includes(row.variant))) {
    const output=sql(`${prefix}${context(row)}DO $plan$ DECLARE plan jsonb; expected integer; BEGIN SELECT count(*) INTO expected FROM public.snake_draft_picks pick JOIN public.drafts draft ON draft.id=pick.draft_id WHERE draft.league_id=${league} AND pick.player_id IS NULL; EXECUTE ${literal(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`)} INTO plan; INSERT INTO action_result VALUES(jsonb_build_object('plan',plan,'expected',expected)::text); END $plan$;SELECT response FROM action_result;ROLLBACK;`)
    const value=JSON.parse(output.trim().split('\n').find(line=>line.startsWith('{')))
    const plan=value.plan[0]
    const nodes=[]
    const visit=node=>{nodes.push(node);for(const child of node.Plans??[])visit(child)}
    visit(plan.Plan)
    const locked=nodes.filter(node=>node['Node Type']==='LockRows').reduce((sum,node)=>sum+node['Actual Rows']*node['Actual Loops'],0)
    assert.equal(locked,value.expected,`${row.variant}: all unfilled picks must retain their locks`)
    results.push({variant:row.variant,manager:row.manager,locked,expected:value.expected,plan})
  }
  assert.equal(results.length,9)
  save(`${option('label')??'delete'}-locks.json`,results)
  process.stdout.write(`PASS ${results.length} delete timer lock plans\n`)
} else if (process.argv.includes('--inventory')) {
  save('inventory.json', { fixture, cases })
  process.stdout.write(JSON.stringify({ managers: fixture.members.length, cases: cases.length, fixtureRows: JSON.parse(sql("SELECT jsonb_build_object('players',(SELECT count(*) FROM players),'stats',(SELECT count(*) FROM player_game_stats),'leagues',(SELECT count(*) FROM leagues));")) }) + '\n')
} else if (process.argv.includes('--capture')) {
  const label=option('label')??'baseline'
  const metadata={harness:createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),baseline,candidate,selected,fixture,scoped,direct}
  const journal=path.join(evidence,`${label}-samples.jsonl`)
  const resuming=process.argv.includes('--resume')&&existsSync(journal)
  if(resuming) assert.deepEqual(JSON.parse(readFileSync(path.join(evidence,`${label}-metadata.json`),'utf8')),metadata,'Resume requires identical code and fixtures')
  else save(`${label}-metadata.json`,metadata)
  const previous=[]
  const lines=resuming?readFileSync(journal,'utf8').trim().split('\n').filter(Boolean):[]
  for(const [index,line] of lines.entries()) {
    try { previous.push(JSON.parse(line)) } catch(error) { if(index!==lines.length-1) throw error }
  }
  const key=row=>`${row.round}/${row.name}/${row.variant}/${row.manager}/${row.state}`
  const samples=previous.filter(row=>Object.keys(versions).every(version=>previous.some(value=>key(value)===key(row)&&value.version===version&&value.window===row.window)))
  writeFileSync(journal,samples.map(row=>JSON.stringify(row)+'\n').join(''))
  const window=sql('SELECT pg_postmaster_start_time();').trim()
  for (let round = 0; round < Number(option('rounds') ?? 5); round++) for (const row of selected) {
    const priming = Array.from({ length: 5 }, () => `SAVEPOINT warm;${invoke(row)}ROLLBACK TO warm;`).join('\n')
    for (const state of ['fresh', 'warm']) for (const version of Object.keys(versions)) {
      if(samples.some(value=>key(value)===key({...row,round,state,variant:row.variant??'default'})&&value.version===version)) continue
      const output = sql(`${prefix}${actionDefinition(row,version)}${context(row)}${state === 'warm' ? priming : ''}
CREATE TEMP TABLE action_counts AS SELECT relid,n_tup_ins AS inserted,n_tup_upd AS updated,n_tup_del AS deleted FROM pg_stat_xact_user_tables;
SET LOCAL track_functions='all';SET LOCAL pg_stat_statements.track='all';SET LOCAL pg_stat_statements.track_planning=on;SELECT extensions.pg_stat_statements_reset();
DO $action$ BEGIN ${invoke(row)} END $action$;
${stats}SELECT jsonb_build_object('writes',COALESCE(jsonb_agg(to_jsonb(w)),'[]')) FROM (SELECT t.schemaname,t.relname,t.n_tup_ins-COALESCE(c.inserted,0) AS inserted,t.n_tup_upd-COALESCE(c.updated,0) AS updated,t.n_tup_del-COALESCE(c.deleted,0) AS deleted FROM pg_stat_xact_user_tables t LEFT JOIN action_counts c USING(relid) WHERE t.schemaname NOT LIKE 'pg_temp%' AND ROW(t.n_tup_ins,t.n_tup_upd,t.n_tup_del) IS DISTINCT FROM ROW(COALESCE(c.inserted,0),COALESCE(c.updated,0),COALESCE(c.deleted,0)))w;SELECT jsonb_build_object('functions',COALESCE(jsonb_agg(to_jsonb(f)),'[]')) FROM (SELECT f.schemaname,f.funcname,f.calls,f.total_time,f.self_time,p.prorettype='trigger'::regtype AS trigger FROM pg_stat_xact_user_functions f JOIN pg_proc p ON p.oid=f.funcid WHERE f.calls>0)f;SELECT jsonb_build_object('bytes',octet_length(response),'hash',md5(response)) FROM action_result;ROLLBACK;`)
      const values = output.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      const statements = values.find(value => value.statements).statements
      const top = statements.find(value => value.query.startsWith('DO $action$'))
      assert.ok(top, output)
      const result = { name: row.name, variant: row.variant ?? 'default', manager: row.manager, round, version, state, window, milliseconds: top.total_plan_time + top.total_exec_time, buffers: top.shared_blks_hit + top.shared_blks_read, wal: Number(top.wal_bytes), statements: statements.reduce((sum, s) => sum + (s.toplevel ? 0 : s.calls), 0), written: values.find(value => value.writes).writes.reduce((sum, table) => sum + table.inserted + table.updated + table.deleted, 0), writes: values.find(value => value.writes).writes, ...values.find(value => 'bytes' in value), detail: statements, functions: values.find(value => value.functions).functions }
      samples.push(result)
      appendFileSync(journal,JSON.stringify(result)+'\n')
      process.stdout.write(`${round + 1} ${version} ${row.name} m${row.manager} ${state}: ${result.milliseconds.toFixed(2)} ms ${result.buffers} buffers ${result.wal} WAL\n`)
    }
  }
  save(`${label}-samples.json`,samples)
} else if (process.argv.includes('--parity')) {
  const results = []
  for (const row of selected) {
    const freeze = definition => definition.replaceAll(/(?:(?:pg_catalog|extensions)\.)?gen_random_uuid\(/g,'pg_temp.action_uuid(').replaceAll(/(?:extensions\.)?gen_random_bytes\(/g,'pg_temp.action_bytes(').replaceAll(/(?:pg_catalog\.)?clock_timestamp\(/g,'pg_temp.action_clock(')
    const capture = (definition, control = '') => `SAVEPOINT action_case;${freeze(definition)}${restoreSequences}${context(row)}
DO $oracle$ BEGIN ${invoke(row)} EXCEPTION WHEN OTHERS THEN RESET ROLE; INSERT INTO action_result VALUES(jsonb_build_object('code',SQLSTATE,'error',SQLERRM)::text); END $oracle$;${control}SELECT jsonb_build_object('response',response,'state',pg_temp.action_snapshot()) FROM action_result;
ROLLBACK TO action_case;`
    const output = sql(`${prefix}${readFileSync('tests/db/league-actions-oracle.sql', 'utf8')}${capture(baseline)}${capture(candidate)}${capture(candidate,"UPDATE action_result SET response=response||' ';")}${capture(candidate,`UPDATE public.leagues SET name=name||' [oracle-control]' WHERE id=${league};SET CONSTRAINTS ALL IMMEDIATE;`)}${restoreSequences}ROLLBACK;`)
    const values = output.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    assert.equal(values.length, 4)
    assert.deepEqual(values[0], values[1], `${row.name}/${row.variant ?? 'default'} manager ${row.manager}: response or table row diff`)
    assert.throws(() => assert.deepEqual(values[0], values[2]))
    assert.throws(() => assert.deepEqual(values[0], values[3]))
    assert.ok(row.expectError || !values[0].response.startsWith('{"code":'), `${row.name}: success scenario returned an error: ${values[0].response}`)
    if (row.expectError) assert.equal(JSON.parse(values[0].response).code,row.expectError)
    results.push({ name: row.name, variant: row.variant ?? 'default', manager: row.manager, bytes: Buffer.byteLength(values[0].response), touched: Object.keys(values[0].state), equal: true, responseControl: 'rejected', rowControl: 'rejected' })
    save(`${option('label') ?? 'baseline'}-parity.json`, results)
    process.stdout.write(`PASS ${row.name} m${row.manager}; ${Object.keys(values[0].state).length} tables; both corruption controls rejected\n`)
  }
} else if (process.argv.includes('--recipes')) {
  execFileSync('docker', ['cp','tests/db','supabase_db_pt4bafablea4:/tmp/league-actions-tests'])
  const recipes = ['idempotency-leagues','idempotency-announcements','notif-announcement-history','server-deleted-league-notifications','league-timezone-setting','rules-scoring-settings','zero-lineup-slots','future-pick-settings','player-search-cache-refresh','view-player-search-parity','dynasty-decision-inputs','forecast-inputs-bound-regression','timeline-read','playoff-transitions','playoff-boundary-guards','server-transaction-faab','visible-player-totals','draft-goal-behavior']
  const results = []
  for (const name of recipes.filter(name=>!option('only') || option('only').split(',').includes(name))) {
    const output = execFileSync('docker', ['exec','supabase_db_pt4bafablea4','psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-f',`/tmp/league-actions-tests/${name}.sql`], { encoding:'utf8',maxBuffer:32*1024*1024 })
    results.push({name,output})
    save(`${option('label') ?? 'recipes'}-recipes.json`,results)
    process.stdout.write(`PASS ${name}\n`)
  }
} else if (process.argv.includes('--probe')) {
  for (const row of selected) {
    try { const output = sql(`${prefix}${context(row)}${invoke(row)}SELECT jsonb_build_object('name',${literal(row.name)},'bytes',octet_length(response),'hash',md5(response)) FROM action_result;ROLLBACK;`); process.stdout.write(output) }
    catch (error) { process.stdout.write(`${row.name} m${row.manager}: ${error.message}\n`) }
  }
} else throw new Error('Choose --inventory, --probe, or --capture')
