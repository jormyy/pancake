import assert from 'node:assert/strict'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const target of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
assert.equal(new URL(api).port, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321')
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
const { generateMatchups } = await import('../../functions/_shared/matchupGeneration.ts')
const sql = async (statement: string): Promise<string> => {
  const child = new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
const check = async (condition: string, label: string) => {
  assert.equal(await sql(`SELECT (${condition})::text`), 'true', label)
  console.log(`PASS ${label}`)
}
const selected = Deno.env.get('POST_SKIP_PHASE')
assert.ok(!selected || ['timing', 'schedule'].includes(selected))
const calendar = await sql(`SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY season_year,week_number),'[]') FROM season_weeks w WHERE season_year IN(2027,2028)`)
const failures: string[] = []
try {
  await sql(`INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    SELECT y,w,make_date(y-1,10,20)+CASE WHEN w=1 THEN 0 ELSE 6+(w-2)*7 END,
      make_date(y-1,10,25)+(w-1)*7 FROM generate_series(2027,2028) y CROSS JOIN generate_series(1,12) w
    ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end`)
  for (const mode of ['paused', 'offseason', 'before', 'after'].filter(mode => !selected || (selected === 'timing') === ['paused', 'offseason'].includes(mode))) {
    const league = crypto.randomUUID(), season = crypto.randomUUID()
    const users = Array.from({ length: 4 }, () => crypto.randomUUID())
    const members = users.map(() => crypto.randomUUID())
    const players = Array.from({ length: 12 }, () => crypto.randomUUID())
    const settings = (value: unknown) => sql(`BEGIN; SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub',${quote(users[0])},true);
      SELECT update_league_settings_atomic(${quote(league)},${quote(JSON.stringify(value))}); COMMIT;`)
    const seedScores = (type: string) => sql(`
      INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
        SELECT DISTINCT ${quote('002-skip-'+league+'-')}||m.week_number,2027,m.week_number,w.week_start,w.week_start::timestamp AT TIME ZONE 'America/New_York','XSK','XSL','Final',now()
        FROM matchups m JOIN season_weeks w ON w.season_year=2027 AND w.week_number=m.week_number
        WHERE m.league_season_id=${quote(season)} AND NOT m.is_voided AND m.matchup_type=${quote(type)};
      INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play)
        SELECT r.player_id,g.id,2027,m.week_number,g.game_date,CASE WHEN r.member_id=m.home_member_id THEN 10 ELSE 5 END,false
        FROM matchups m JOIN roster_players r ON r.league_season_id=m.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id)
        JOIN nba_games g ON g.nba_game_id=${quote('002-skip-'+league+'-')}||m.week_number
        WHERE m.league_season_id=${quote(season)} AND NOT m.is_voided AND m.matchup_type=${quote(type)};
      INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set)
        SELECT ${quote(league)},${quote(season)},r.member_id,r.player_id,m.week_number,g.game_date,'PG',false
        FROM matchups m JOIN roster_players r ON r.league_season_id=m.league_season_id AND r.member_id IN(m.home_member_id,m.away_member_id)
        JOIN nba_games g ON g.nba_game_id=${quote('002-skip-'+league+'-')}||m.week_number
        WHERE m.league_season_id=${quote(season)} AND NOT m.is_voided AND m.matchup_type=${quote(type)};`)
    const tick = async (at: string) => {
      const report = await runSeasonBoundary(new Date(at), league)
      console.log(JSON.stringify({ provenance: 'SYNTHETIC', mode, at, report }))
      assert.equal(report.length, 1)
      assert.equal(report[0].error, undefined)
      return report[0].actions
    }
    try {
      await sql(`BEGIN;
        ${users.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES(${quote(user)},'authenticated','authenticated',${quote(user+'@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')}
        INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths,scoring_settings)
          VALUES(${quote(league)},'Synthetic skipped opening week',${quote(league)},${quote(users[0])},'${['paused','offseason'].includes(mode)?'offseason':'setup'}',8,4,ARRAY[2,2],'{"points":1}');
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},2027,true);
        ${members.map((member, i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at) VALUES(${quote(member)},${quote(league)},${quote(users[i])},'${i?'manager':'commissioner'}','Team ${i}',now()+interval '${i} seconds');`).join('\n')}
        INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
          SELECT ${quote(league)},2027,r,m,m FROM unnest(ARRAY[${members.map(quote).join(',')}]::uuid[]) m CROSS JOIN generate_series(1,3) r;
        ${players.map(player => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${quote(player)},'Synthetic',${quote(player)},'PG',ARRAY['PG'],0,1);`).join('\n')}
        COMMIT;`)
      if (mode === 'after') {
        await generateMatchups(league, season, 7)
        await sql(`UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=99999,away_points=0,finalized_at=now()
          WHERE league_season_id=${quote(season)} AND week_number=1;
          SELECT private.rebuild_regular_standings(${quote(league)},${quote(season)});`)
        await check(`(SELECT sum(points_for)=199998 FROM standings WHERE league_season_id=${quote(season)} AND week_number=1)`, 'existing week-one results enter standings before the settings change')
      }
      for (const invalid of [[0], [8], [13], [1.5], ['1']]) {
        const result = await sql(`DO $test$ DECLARE message text; BEGIN
          PERFORM set_config('request.jwt.claim.sub',${quote(users[0])},true);
          BEGIN PERFORM update_league_settings_atomic(${quote(league)},${quote(JSON.stringify({ skipped_weeks: invalid }))});
          EXCEPTION WHEN OTHERS THEN message:=SQLERRM; END;
          IF message IS NULL THEN RAISE EXCEPTION 'Invalid skip accepted: ${JSON.stringify(invalid)}'; END IF;
        END $test$;`)
        assert.equal(result, '')
      }
      await settings({ skipped_weeks: [1, 1] })
      await check(`(SELECT skipped_weeks=ARRAY[1] FROM league_seasons WHERE id=${quote(season)})`, `${mode}: settings deduplicate week one`)
      if (mode === 'after') await check(`NOT EXISTS(SELECT 1 FROM standings WHERE league_season_id=${quote(season)} AND (wins<>0 OR points_for<>0))`, 'settings remove existing week-one wins and points')
      if (['paused', 'offseason'].includes(mode)) {
        if (mode === 'paused') await sql(`SELECT start_rookie_draft_atomic(${quote(league)},3,false);
          SELECT pause_draft_atomic((SELECT id FROM drafts WHERE league_id=${quote(league)}),${quote(users[0])});`)
        for (const at of ['2026-10-20T04:00:00Z', '2026-10-23T16:00:00Z', '2026-10-26T03:59:59Z']) {
          await tick(at)
          await check(`(SELECT status='${mode === 'paused'?'drafting':'offseason'}' FROM leagues WHERE id=${quote(league)})
            AND NOT EXISTS(SELECT 1 FROM snake_draft_picks p JOIN drafts d ON d.id=p.draft_id WHERE d.league_id=${quote(league)} AND p.player_id IS NOT NULL)
            AND (SELECT count(*)=${mode === 'paused'?1:0} FROM drafts WHERE league_id=${quote(league)})
            ${mode === 'paused'?`AND (SELECT bool_and(status='paused' AND pause_reason='manual') FROM drafts WHERE league_id=${quote(league)})`:''}`, `${mode}: skipped week does not force rookie completion at ${at}`)
        }
        const actions = await tick('2026-10-26T04:00:00Z')
        assert.ok(actions.includes('rookie-draft-auto-completed'))
        await check(`(SELECT status='active' FROM leagues WHERE id=${quote(league)}) AND
          (SELECT count(*)=12 FROM snake_draft_picks p JOIN drafts d ON d.id=p.draft_id WHERE d.league_id=${quote(league)} AND p.player_id IS NOT NULL)`, `${mode}: backstop completes at first eligible week two`)
        continue
      }
      await sql(`UPDATE leagues SET status='active' WHERE id=${quote(league)}`)
      await tick('2026-10-20T04:00:00Z')
      await check(`NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=${quote(season)} AND week_number=1 AND NOT is_voided)
        AND (SELECT min(week_number)=2 AND max(week_number)=7 AND count(*)=12 FROM matchups WHERE league_season_id=${quote(season)} AND NOT is_voided)`, `${mode}: six eligible weeks start at week two`)
      await check(`(SELECT count(*)=6 AND bool_and(n=2) FROM (SELECT count(*) n FROM matchups WHERE league_season_id=${quote(season)} AND NOT is_voided
        GROUP BY LEAST(home_member_id::text,away_member_id::text),GREATEST(home_member_id::text,away_member_id::text)) pairs)
        AND NOT EXISTS(SELECT 1 FROM (SELECT week_number,m,count(*) n FROM matchups CROSS JOIN LATERAL unnest(ARRAY[home_member_id,away_member_id]) m
          WHERE league_season_id=${quote(season)} AND NOT is_voided GROUP BY week_number,m) appearances WHERE n<>1)`, `${mode}: each pair plays twice and every manager plays once per eligible week`)
      await sql(`INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,is_finalized,winner_member_id,home_points,away_points,finalized_at)
        VALUES(${quote(league)},${quote(season)},1,${quote(members[0])},${quote(members[1])},'regular_season',true,${quote(members[0])},99999,0,now()) ON CONFLICT DO NOTHING;
        UPDATE matchups SET is_voided=false,is_finalized=true,winner_member_id=home_member_id,home_points=99999,away_points=0,finalized_at=now() WHERE league_season_id=${quote(season)} AND week_number=1;`)
      await check(`(SELECT bool_and(is_voided AND NOT is_finalized AND winner_member_id IS NULL AND home_points=0 AND away_points=0 AND finalized_at IS NULL)
        FROM matchups WHERE league_season_id=${quote(season)} AND week_number=1)`, `${mode}: trigger clears attempts to revive skipped results`)
      await sql(`${members.map((member,i) => `INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES(${quote(league)},${quote(season)},${quote(member)},${quote(players[i])},'draft','2026-10-01T00:00:00Z');`).join('\n')}`)
      await seedScores('regular_season')
      await sql(`UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=10,away_points=5,home_max_possible_points=10,away_max_possible_points=5,finalized_at=now()-interval '49 hours'
        WHERE league_season_id=${quote(season)} AND NOT is_voided;
        SELECT private.rebuild_regular_standings(${quote(league)},${quote(season)});
        DO $test$ DECLARE w int; token jsonb; payload jsonb; BEGIN
          FOR w IN 2..7 LOOP
            token:=capture_score_inputs(${quote(season)},w);
            SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('input_token',token)) INTO payload FROM matchups m WHERE league_season_id=${quote(season)} AND week_number=w AND NOT is_voided;
            PERFORM finalize_score_week_atomic(${quote(league)},${quote(season)},w,payload,'[]');
          END LOOP;
        END $test$;`)
      await check(`NOT EXISTS(SELECT 1 FROM standings WHERE league_season_id=${quote(season)} AND week_number=1 AND (wins<>0 OR losses<>0 OR ties<>0 OR points_for<>0 OR points_against<>0))
        AND (SELECT sum(wins)=12 AND sum(points_for)=180 FROM standings WHERE league_season_id=${quote(season)} AND week_number=7)
        AND (SELECT sum(wins)=12 AND sum(points_for)=180 FROM private.playoff_seed_rankings(${quote(league)},${quote(season)},8))`, `${mode}: standings and seeds exclude week one`)
      assert.deepEqual(await tick(new Date(Date.now()-2*3600000).toISOString()), [])
      assert.ok((await tick('2026-12-09T17:00:00Z')).includes('bracket-generated'))
      await check(`(SELECT bool_and(week_number=8 AND end_week_number=9) AND count(*)=2 FROM matchups WHERE league_season_id=${quote(season)} AND matchup_type='playoff_semifinal')`, `${mode}: fixed semifinal weeks eight and nine`)
      for (const [type, week] of [['playoff_semifinal',8],['playoff_final',10]] as const) {
        await seedScores(type)
        await sql(`UPDATE matchups SET is_finalized=true,winner_member_id=home_member_id,home_points=10,away_points=5,home_max_possible_points=10,away_max_possible_points=5,finalized_at=now()-interval '49 hours'
          WHERE league_season_id=${quote(season)} AND matchup_type=${quote(type)};
          DO $test$ DECLARE token jsonb; payload jsonb; BEGIN
            token:=capture_score_inputs(${quote(season)},${week});
            SELECT jsonb_agg(to_jsonb(m)||jsonb_build_object('input_token',token)) INTO payload FROM matchups m WHERE league_season_id=${quote(season)} AND matchup_type=${quote(type)};
            PERFORM finalize_score_week_atomic(${quote(league)},${quote(season)},${week},payload,'[]');
          END $test$;`)
        const actions = await tick(type === 'playoff_final' ? '2027-01-07T17:00:00Z' : '2026-12-23T17:00:00Z')
        assert.ok(actions.includes(type === 'playoff_final'?'season-advanced':'final-created'))
        if (type === 'playoff_semifinal') await check(`(SELECT week_number=10 AND end_week_number=11 FROM matchups WHERE league_season_id=${quote(season)} AND matchup_type='playoff_final')`, `${mode}: fixed final weeks ten and eleven`)
      }
      await check(`(SELECT NOT is_current AND skipped_weeks=ARRAY[1] FROM league_seasons WHERE id=${quote(season)})
        AND (SELECT count(*)=1 FROM matchups WHERE league_season_id=${quote(season)} AND matchup_type='playoff_final' AND is_finalized AND winner_member_id IS NOT NULL)
        AND (SELECT season_year=2028 AND skipped_weeks='{}'::int[] FROM league_seasons WHERE league_id=${quote(league)} AND is_current)
        AND EXISTS(SELECT 1 FROM matchups m JOIN league_seasons s ON s.id=m.league_season_id WHERE s.league_id=${quote(league)} AND s.is_current AND m.week_number=1 AND NOT m.is_voided)
        AND (SELECT status='offseason' FROM leagues WHERE id=${quote(league)})`, `${mode}: champion stays in history and next season restores week one`)
    } catch (error) {
      failures.push(`${mode}: ${(error as Error).message}`)
    } finally {
      await sql(`BEGIN; DELETE FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${quote(league)});
        DELETE FROM draft_picks WHERE league_id=${quote(league)}; DELETE FROM drafts WHERE league_id=${quote(league)};
        DELETE FROM leagues WHERE id=${quote(league)};
        DELETE FROM player_game_stats WHERE game_id IN(SELECT id FROM nba_games WHERE nba_game_id LIKE ${quote('002-skip-'+league+'-%')});
        DELETE FROM nba_games WHERE nba_game_id LIKE ${quote('002-skip-'+league+'-%')};
        DELETE FROM players WHERE id IN(${players.map(quote).join(',')});
        DELETE FROM auth.users WHERE id IN(${users.map(quote).join(',')}); COMMIT;`)
    }
  }
} finally {
  await sql(`DELETE FROM season_weeks WHERE season_year IN(2027,2028) AND NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(${quote(calendar)}::jsonb) old(season_year int,week_number int) WHERE old.season_year=season_weeks.season_year AND old.week_number=season_weeks.week_number);
    INSERT INTO season_weeks SELECT * FROM jsonb_populate_recordset(NULL::season_weeks,${quote(calendar)}::jsonb)
      ON CONFLICT(season_year,week_number) DO UPDATE SET week_start=EXCLUDED.week_start,week_end=EXCLUDED.week_end;`)
}
assert.deepEqual(failures, [])
