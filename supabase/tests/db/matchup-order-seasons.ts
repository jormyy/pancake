import assert from 'node:assert/strict'
import { buildScheduleSyncPlan, buildSeasonWeekRows, playoffFit } from '../../functions/_shared/schedule.ts'
const db = Deno.env.get('SUPABASE_DB_URL')!
assert.ok(['127.0.0.1','localhost'].includes(new URL(db).hostname))
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const orders: string[] = []
for (const year of [2025,2026]) {
  const fixture = JSON.parse(await Deno.readTextFile(new URL(`../../../tests/fixtures/calendar/espn-${year-1}-${year}.json`, import.meta.url)))
  const plan = buildScheduleSyncPlan(fixture.games, new Date(`${year-1}-10-01T00:00:00Z`))
  const weeks = buildSeasonWeekRows(plan.rows,year)
  assert.equal(weeks.length,24)
  assert.deepEqual(playoffFit(weeks.map(week=>week.week_number),20,[1,2,2]),{status:'fit',lastAvailableWeek:24,requiredWeeks:5,endWeek:24})
  assert.equal(playoffFit(weeks.map(week=>week.week_number),21,[1,2,2]).status,'does-not-fit')
  assert.equal(playoffFit([],20,[1,2,2]).status,'calendar-unpublished')
  assert.equal(weeks.at(-1)!.week_end,year===2025?'2025-04-13':'2026-04-12')
  const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`
  const statement=`BEGIN;
  SET LOCAL statement_timeout='60s';
  CREATE TEMP TABLE feature_evidence(value jsonb) ON COMMIT DROP;
  SELECT publish_nba_schedule_atomic(${year},${quote(plan.rows)},${quote(weeks)});
  DO $$
  DECLARE league uuid:=md5('post-real-league')::uuid; season uuid:=md5('post-real-season:${year}')::uuid; users uuid[]:='{}'; members uuid[]:='{}'; i int; r int; saved jsonb; seeds uuid[]; bracket jsonb;
  BEGIN
    IF (SELECT jsonb_agg(jsonb_build_object('season_year',season_year,'week_number',week_number,'week_start',week_start,'week_end',week_end) ORDER BY week_number) FROM season_weeks WHERE season_year=${year}) IS DISTINCT FROM ${quote(weeks)} THEN RAISE EXCEPTION 'The real-season oracle requires a fresh or matching merged calendar; published legacy calendars remain protected'; END IF;
    FOR i IN 1..10 LOOP
      users:=array_append(users,gen_random_uuid()); members:=array_append(members,md5('post-real-member:'||i::text)::uuid);
      INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) VALUES(users[i],'authenticated','authenticated',users[i]||'@example.test','{}','{}');
      IF i=1 THEN
        INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths) VALUES(league,'Synthetic real-calendar schedule',league::text,users[1],'setup',20,6,ARRAY[1,2,2]);
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(season,league,${year},true);
      END IF;
      INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at) VALUES(members[i],league,users[i],CASE WHEN i=1 THEN 'commissioner' ELSE 'manager' END::league_member_role,'Team '||i,now()+i*interval '1 second');
    END LOOP;
    IF ${year}=2026 THEN INSERT INTO league_seasons(id,league_id,season_year,is_current,skipped_weeks) VALUES(md5('post-real-season:2025')::uuid,league,2025,false,ARRAY[1]); END IF;
    PERFORM set_config('request.jwt.claim.sub',users[1]::text,true);
    PERFORM update_league_settings_atomic(league,'{"skipped_weeks":[1]}'::jsonb);
    PERFORM replace_regular_season_matchups_atomic(league,season);
    SELECT jsonb_agg(to_jsonb(m) ORDER BY week_number,home_member_id) INTO saved FROM matchups m WHERE league_season_id=season;
    PERFORM replace_regular_season_matchups_atomic(league,season,true);
    PERFORM replace_regular_season_matchups_atomic(league,season);
    IF saved IS DISTINCT FROM (SELECT jsonb_agg(to_jsonb(m) ORDER BY week_number,home_member_id) FROM matchups m WHERE league_season_id=season) THEN RAISE EXCEPTION 'Stored schedule changed on retry or force'; END IF;
    IF (SELECT count(*)<>90 OR min(week_number)<>2 OR max(week_number)<>19 FROM matchups WHERE league_season_id=season) THEN RAISE EXCEPTION 'Wrong delayed matchup range'; END IF;
    UPDATE matchups SET home_points=100-array_position(members,home_member_id),away_points=100-array_position(members,away_member_id),home_max_possible_points=100-array_position(members,home_member_id),away_max_possible_points=100-array_position(members,away_member_id),winner_member_id=CASE WHEN array_position(members,home_member_id)<array_position(members,away_member_id) THEN home_member_id ELSE away_member_id END,is_finalized=true,finalized_at=now()-interval '73 hours' WHERE league_season_id=season;
    PERFORM private.rebuild_regular_standings(league,season);
    PERFORM generate_playoff_bracket_atomic(league);
    SELECT playoff_bracket_seed_ids INTO seeds FROM league_seasons WHERE id=season;
    IF seeds<>members[1:6] THEN RAISE EXCEPTION 'Seeds differ from independent unbeaten-to-last standings'; END IF;
    IF (SELECT count(*)<>2 FROM matchups WHERE league_season_id=season AND playoff_round=1) OR EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND playoff_round=1 AND (home_member_id=ANY(members[1:2]) OR away_member_id=ANY(members[1:2]))) THEN RAISE EXCEPTION 'Top seeds lost byes'; END IF;
    FOR r IN 1..3 LOOP
      UPDATE matchups SET home_points=100,away_points=50,winner_member_id=home_member_id,is_finalized=true,finalized_at=now()-interval '73 hours' WHERE league_season_id=season AND playoff_round=r;
      IF r<3 THEN PERFORM advance_playoff_bracket_atomic(league); END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM matchups m JOIN matchups lost ON lost.league_season_id=m.league_season_id AND lost.playoff_round<m.playoff_round AND lost.is_finalized AND lost.winner_member_id<>lost.away_member_id WHERE m.league_season_id=season AND (m.home_member_id=lost.away_member_id OR m.away_member_id=lost.away_member_id)) THEN RAISE EXCEPTION 'Eliminated team returns'; END IF;
    IF NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=season AND matchup_type='playoff_final' AND week_number=23 AND end_week_number=24 AND is_finalized AND winner_member_id=members[1]) THEN RAISE EXCEPTION 'Champion or playoff fit differs'; END IF;
    SELECT jsonb_agg(jsonb_build_object('round',m.playoff_round,'start',m.week_number,'end',m.end_week_number,'home',array_position(members,m.home_member_id),'away',array_position(members,m.away_member_id),'winner',array_position(members,m.winner_member_id)) ORDER BY m.playoff_round,m.playoff_position) INTO bracket FROM matchups m WHERE league_season_id=season AND playoff_round IS NOT NULL;
    INSERT INTO feature_evidence SELECT jsonb_build_object('year',${year},'provenance','REAL-DERIVED calendar; SYNTHETIC league, members, scores','weeks',(SELECT jsonb_agg(jsonb_build_object('season_year',season_year,'week_number',week_number,'week_start',week_start,'week_end',week_end) ORDER BY week_number) FROM season_weeks WHERE season_year=${year}),'seeds',ARRAY[1,2,3,4,5,6],'bracket',bracket,'champion',1,'matchups',(SELECT jsonb_agg(jsonb_build_object('week',m.week_number,'home',array_position(members,m.home_member_id),'away',array_position(members,m.away_member_id)) ORDER BY m.week_number,m.home_member_id) FROM matchups m WHERE m.league_season_id=season AND m.matchup_type='regular_season'));
  END; $$;
  SELECT 'FEATURE_EVIDENCE '||value::text FROM feature_evidence;
  ROLLBACK;`
  const child = new Deno.Command('psql',{args:[db,'-XqAtv','ON_ERROR_STOP=1'],stdin:'piped',stdout:'piped',stderr:'piped'}).spawn()
  const writer=child.stdin.getWriter(); await writer.write(new TextEncoder().encode(statement)); await writer.close()
  const result=await child.output()
  assert.equal(result.code,0,new TextDecoder().decode(result.stderr))
  const output = new TextDecoder().decode(result.stdout)
  const evidence = JSON.parse(output.split('\n').find(line=>line.startsWith('FEATURE_EVIDENCE '))!.slice('FEATURE_EVIDENCE '.length))
  orders.push(JSON.stringify(evidence.matchups))
  console.log(output)
}
assert.notEqual(orders[0],orders[1],'The same stable league and members need a new season order')
Deno.exit(0)
