import { createClient } from '@supabase/supabase-js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const api = process.env.SUPABASE_URL
const db = process.env.SUPABASE_DB_URL
const output = process.argv[2]
if (!api || !db || !output || ![api, db].every(value => ['127.0.0.1', 'localhost'].includes(new URL(value).hostname))) throw Error('Use an isolated local database and output directory')
mkdirSync(output, { recursive: true })
const sql = source => execFileSync('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: source, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const admin = createClient(api, process.env.PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false } })
const client = createClient(api, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } })
const q = async query => { const { data, error } = await query; if (error) throw error; return data }
const tag = randomUUID()
const password = randomUUID() + 'Ab1!'
const email = `${tag}@example.test`
const owner = (await q(admin.auth.admin.createUser({ email, password, email_confirm: true }))).user.id
const league = randomUUID(), member = randomUUID(), seasonId = randomUUID()
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const year = Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) >= 10 ? 1 : 0)
const teams = ['ATL','BOS','BKN','CHA','CHI','CLE','DAL','DEN','DET','GSW','HOU','IND','LAC','LAL','MEM','MIA','MIL','MIN','NOP','NYK','OKC','ORL','PHI','PHX','POR','SAC','SAS','TOR','UTA','WAS']
const teamArray = `ARRAY[${teams.map(team => `'${team}'`).join(',')}]`
const settings = '{"points":1,"rebounds":1.2,"assists":1.5,"steals":3,"blocks":3,"turnovers":-1,"three_pointers_made":0.5}'
const report = { fixture: { players: 600, stats: 240360, historicalSeasons: 6 }, method: 'One first request and ten warm authenticated PostgREST repeats, including HTTP and JSON parsing. Isolated 2 CPU / 4 GiB VM. No hosted latency claim.', queries: [], refreshes: [] }
let ownsCalendar = false
try {
  if (Number(sql(`SELECT count(*) FROM public.season_weeks WHERE season_year=${year}`)) !== 0) throw Error('Benchmark requires an unused current-season calendar')
  const started = performance.now()
  sql(`BEGIN;
SET LOCAL statement_timeout='180s';
INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings) VALUES('${league}','Server benchmark ${tag}','${league}','${owner}','active','${settings}');
INSERT INTO public.league_members(id,league_id,user_id,role) VALUES('${member}','${league}','${owner}','commissioner');
INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES('${seasonId}','${league}',${year},true);
INSERT INTO public.leagues(name,slug,commissioner_id,status,scoring_settings)
SELECT 'Server benchmark ${tag}',gen_random_uuid()::text,'${owner}','active','${settings}' FROM generate_series(1,2);
INSERT INTO public.league_members(league_id,user_id,role)
SELECT id,'${owner}','commissioner' FROM public.leagues WHERE name='Server benchmark ${tag}' AND id<>'${league}';
INSERT INTO public.players(sportsdata_id,nba_id,first_name,last_name,nba_team,position,eligible_positions,status,years_exp)
SELECT '${tag}-'||lpad(n::text,3,'0'),'bench-${tag}-'||n,'E2E','Player'||lpad(n::text,3,'0'),(${teamArray})[1+((n-1)/20)],
(ARRAY['PG','SG','SF','PF','C','G','F'])[1+((n-1)%7)]::public.nba_position,
ARRAY[(ARRAY['PG','SG','SF','PF','C','G','F'])[1+((n-1)%7)]],'Active',3 FROM generate_series(1,600)n;
CREATE TEMP TABLE bench_players AS SELECT id,nba_team,row_number() OVER(ORDER BY sportsdata_id)::int n FROM public.players WHERE sportsdata_id LIKE '${tag}-%';
INSERT INTO public.dynasty_rankings(source,source_rank,source_player_id,source_player_name,source_positions,source_team,scoring_format,player_id,rank_change,fetched_at)
SELECT 'hashtagbasketball.com',(SELECT coalesce(max(source_rank),9000) FROM public.dynasty_rankings WHERE source='hashtagbasketball.com')+n,
'${tag}-'||n,'E2E Player'||n,ARRAY['PG'],nba_team,'overall',id,0,now() FROM bench_players;
INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
SELECT ${year},w,'${today}'::date-6+(w-1)*7,'${today}'::date+(w-1)*7 FROM generate_series(1,26)w;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
SELECT '002${tag}-'||y||'-'||r||'-'||slot,y,1+(r-1)/4,
make_date(y-1,10,20)+(r-1)*2,(make_date(y-1,10,20)+(r-1)*2)::timestamp AT TIME ZONE 'UTC',
(${teamArray})[1+((slot+r)%30)],(${teamArray})[1+((29-slot+r)%30)],'Final',now()
FROM generate_series(${year-6},${year-1})y CROSS JOIN generate_series(1,82)r CROSS JOIN generate_series(0,14)slot;
INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
SELECT '002${tag}-current-'||d||'-'||slot,${year},1,'${today}'::date-6+d,('${today}'::date-6+d)::timestamp AT TIME ZONE 'UTC',
(${teamArray})[slot+1],(${teamArray})[slot+16],'Final',now()
FROM generate_series(0,6)d CROSS JOIN generate_series(0,14)slot;
INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,minutes_played,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made,field_goals_made,field_goals_attempted,free_throws_made,free_throws_attempted,did_not_play)
SELECT p.id,g.id,g.season_year,g.week_number,30,12+p.n%20,3+p.n%8,2+p.n%7,1,1,2,2,6,14,3,4,false
FROM public.nba_games g JOIN bench_players p ON p.nba_team IN(g.home_team,g.away_team)
WHERE g.nba_game_id LIKE '002${tag}-%' AND (g.season_year=${year} OR ((p.n-1)%20)<16);
COMMIT;
ANALYZE public.player_game_stats;
ANALYZE public.nba_games;
ANALYZE public.players;
`)
  report.seedMs = performance.now() - started
  ownsCalendar = true
  const refresh = label => {
    const at = performance.now()
    sql("UPDATE analytics.search_cache_refresh_state SET refreshed_at=now()-interval '8 days'; SELECT public.refresh_player_search_caches();")
    const metadata = JSON.parse(sql("SELECT jsonb_build_object('leagues',(SELECT count(*) FROM public.leagues),'cacheRows',(SELECT count(*) FROM analytics.mv_player_avg_fantasy_points),'cacheBytes',pg_total_relation_size('analytics.mv_player_avg_fantasy_points'),'statsRows',(SELECT count(*) FROM public.player_game_stats),'statsBytes',pg_total_relation_size('public.player_game_stats'));"))
    report.refreshes.push({ label, ms: performance.now() - at, ...metadata })
  }
  refresh('three leagues, one scoring rule')
  const players = await q(admin.from('players').select('id').like('sportsdata_id', `${tag}-%`).order('sportsdata_id'))
  const player = players[0].id
  await q(client.auth.signInWithPassword({ email, password }))
  const searches = { p_query: '', p_position: 'ALL', p_teams: [], p_league_id: league, p_rookies_only: false, p_health: 'all', p_sort_by: 'fpts', p_sort_dir: 'desc', p_season_year: year, p_limit: 50, p_offset: 0 }
  const specs = [
    ['search-50', () => client.rpc('search_players', searches)],
    ['search-name', () => client.rpc('search_players', { ...searches, p_query: 'Player' })],
    ['player-detail', () => client.from('players').select('*').eq('id', player).single()],
    ['player-game-log', () => client.from('player_game_stats').select('*').eq('player_id', player).eq('season_year', year).order('game_date', { ascending: false }).limit(82)],
    ['projection-player', () => client.rpc('get_league_projection_rows', { p_league_id: league, p_season_year: year, p_game_date: today, p_view: 'today', p_player_ids: [player], p_limit: 1, p_offset: 0 })],
    ['projection-600', () => client.rpc('get_league_projection_rows', { p_league_id: league, p_season_year: year, p_game_date: today, p_view: 'today', p_limit: 600, p_offset: 0 })],
    ['dynasty-inputs-600', () => client.rpc('get_dynasty_forecast_inputs', { p_league_id: league, p_member_id: member, p_season_year: year, p_query: '', p_limit: 600, p_offset: 0 })],
    ['averages-season', () => client.from('mv_player_season_averages').select('*').eq('season_year', year)],
  ]
  for (const [name, request] of specs) {
    const samples = []
    for (let i = 0; i < 11; i++) {
      const at = performance.now(), data = await q(request())
      const minimum = name.endsWith('-600') ? 600 : name.startsWith('search-') ? 50 : 1
      if ((Array.isArray(data) ? data.length : data ? 1 : 0) < minimum) throw Error(`${name} lacks representative rows`)
      samples.push({ ms: performance.now() - at, rows: Array.isArray(data) ? data.length : 1, decodedBytes: Buffer.byteLength(JSON.stringify(data)) })
    }
    const sorted = samples.slice(1).map(sample => sample.ms).sort((a, b) => a - b)
    report.queries.push({ name, firstRequest: samples[0], hotMedianMs: (sorted[4] + sorted[5]) / 2, hotP95Ms: sorted[9], samples })
    writeFileSync(path.join(output, 'server-queries.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report.queries.at(-1)))
  }
  const statements = [
    `SELECT * FROM public.search_players(p_league_id=>'${league}',p_season_year=>${year},p_limit=>50)`,
    `SELECT * FROM public.get_league_projection_rows('${league}',${year},'${today}','today',NULL,600,0)`,
    `SELECT * FROM public.get_dynasty_forecast_inputs('${league}','${member}',${year},NULL,'',600,0)`,
    `SELECT * FROM public.player_game_stats WHERE player_id='${player}' AND season_year=${year} ORDER BY game_date DESC LIMIT 82`,
    `SELECT * FROM public.player_game_stats WHERE game_date='${today}' AND player_id='${player}'`,
  ]
  for (const [index, statement] of statements.entries()) {
    const plan = sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',true); EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${statement}; ROLLBACK;`)
    writeFileSync(path.join(output, `query-plan-${index}.txt`), plan)
  }
  writeFileSync(path.join(output, 'cache-watermark-plans.txt'), sql('EXPLAIN (ANALYZE,BUFFERS) SELECT max(greatest(created_at,updated_at)) FROM public.player_game_stats; EXPLAIN (ANALYZE,BUFFERS) SELECT revision FROM analytics.search_cache_source_state WHERE id;'))
  const oldRefresh = readFileSync(process.argv[3], 'utf8')
  const timing = body => sql(`BEGIN; ${body} CREATE TEMP TABLE timings(ms numeric); DO $$ DECLARE t timestamptz; BEGIN FOR i IN 1..11 LOOP t:=clock_timestamp(); PERFORM public.refresh_player_search_caches(); INSERT INTO timings VALUES(extract(epoch FROM clock_timestamp()-t)*1000); END LOOP; END $$; SELECT jsonb_agg(ms) FROM timings; ROLLBACK;`)
  report.unchangedRefreshBefore = timing(`${oldRefresh} UPDATE analytics.search_cache_refresh_state SET refreshed_at=now(),source_watermark=(SELECT max(greatest(created_at,updated_at)) FROM public.player_game_stats);`)
  report.unchangedRefreshAfter = timing('')
  sql(`INSERT INTO public.leagues(name,slug,commissioner_id,status,scoring_settings) SELECT 'Server benchmark ${tag}',gen_random_uuid()::text,'${owner}','active','${settings}' FROM generate_series(1,27);`)
  refresh('thirty leagues, one scoring rule')
  sql(`UPDATE public.leagues l SET scoring_settings=jsonb_set(l.scoring_settings,'{points}',to_jsonb(1+n::numeric/100)) FROM (SELECT id,row_number() OVER(ORDER BY id)n FROM public.leagues WHERE name='Server benchmark ${tag}' LIMIT 10) s WHERE l.id=s.id;`)
  refresh('thirty leagues, eleven scoring rules')
  report.seasonSizes = JSON.parse(sql(`SELECT jsonb_agg(s) FROM (SELECT season_year,count(*) rows,sum(pg_column_size(pgs)) row_bytes FROM public.player_game_stats pgs WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id LIKE '002${tag}-%') GROUP BY season_year ORDER BY season_year)s;`))
  writeFileSync(path.join(output, 'server-queries.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ refreshes: report.refreshes, unchangedRefreshBefore: report.unchangedRefreshBefore, unchangedRefreshAfter: report.unchangedRefreshAfter }))
} finally {
  await client.auth.signOut()
  sql(`BEGIN;
DELETE FROM public.leagues WHERE name='Server benchmark ${tag}';
DELETE FROM public.player_game_stats WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id LIKE '002${tag}-%');
DELETE FROM public.nba_games WHERE nba_game_id LIKE '002${tag}-%';
DELETE FROM public.dynasty_rankings WHERE source_player_id LIKE '${tag}-%';
DELETE FROM public.players WHERE sportsdata_id LIKE '${tag}-%';
${ownsCalendar ? `DELETE FROM public.season_weeks WHERE season_year=${year};` : ''}
DELETE FROM auth.users WHERE id='${owner}' AND email='${email}';
COMMIT;
SELECT public.refresh_player_search_caches();`)
  console.log('Synthetic benchmark fixtures removed')
}
