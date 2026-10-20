import assert from 'node:assert/strict'

const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const target of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
assert.equal(new URL(api).port, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '57421')
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '57422')
const nativeFetch = globalThis.fetch.bind(globalThis)
let scoreCalls = 0
let failScoreRead = false
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input)
  assert.equal(url.origin, new URL(api).origin, 'Boundary recovery must never fetch provider data')
  if (url.pathname.endsWith('/league_seasons') && url.searchParams.get('select')?.includes('scoring_settings')) scoreCalls++
  if (failScoreRead && url.pathname.endsWith('/capture_score_inputs')) return Promise.resolve(Response.json({ code: 'XX000', message: 'Synthetic score read unavailable' }, { status: 500 }))
  return nativeFetch(input, init)
}
const { runSeasonBoundary } = await import('../../functions/_shared/seasonBoundary.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
const sql = async (statement: string): Promise<string> => {
  const child = new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const q = (value: string) => `'${value.replaceAll("'", "''")}'`
const cases = ['rollover', 'bracket', 'advance', 'current', 'refresh_failure', 'correction', 'refresh_error']
const selected = Deno.env.get('POST_STALE_CASE')
assert.ok(!selected || cases.includes(selected))
const failures: string[] = []
try {
  for (const state of cases.filter(value => !selected || selected === value)) {
    const league = crypto.randomUUID(), season = crypto.randomUUID()
    const count = state === 'advance' ? 4 : 2
    const users = Array.from({ length: count }, () => crypto.randomUUID())
    const members = users.map(() => crypto.randomUUID())
    const players = Array.from({ length: count + 1 }, () => crypto.randomUUID())
    const games = [crypto.randomUUID(), crypto.randomUUID()]
    const year = 9130 + cases.indexOf(state) * 2
    const expected = state === 'bracket' ? 'bracket-generated' : state === 'advance' ? 'final-created' : 'season-advanced'
    const stale = () => sql(`SELECT count(*) FROM get_stale_score_weeks(${q(season)},3)`)
    const tick = async (offset = 0) => {
      const report = await runSeasonBoundary(new Date(Date.now()+offset*3600000), league)
      console.log(JSON.stringify({ provenance: 'SYNTHETIC', state, offsetHours: offset, scoreCalls, report, stale: await stale(), current: await sql(`SELECT id FROM league_seasons WHERE league_id=${q(league)} AND is_current`) }))
      assert.equal(report.length, 1)
      return report[0]
    }
    try {
      await sql(`BEGIN;
        ${users.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES(${q(user)},'authenticated','authenticated',${q(user+'@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')}
        INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths,scoring_settings)
          VALUES(${q(league)},'Synthetic stale boundary',${q(league)},${q(users[0])},'active',2,${count},ARRAY[${count===4?'1,1':'1'}],'{"points":1}');
        INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
        ${members.map((member,i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(users[i])},'${i?'manager':'commissioner'}','Team ${i}');`).join('\n')}
        INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
          SELECT ${year},w,current_date-28+(w-1)*7,current_date-22+(w-1)*7 FROM generate_series(1,3) w;
        INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
          SELECT ${year+1},w,current_date+365+(w-1)*7,current_date+371+(w-1)*7 FROM generate_series(1,3) w;
        ${players.slice(0,count).map((player,i) => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,injury_status,nba_team) VALUES(${q(player)},'Synthetic',${q('Stall '+i)},'PG',ARRAY['PG'],'Active','Out','XST');
          INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES(${q(league)},${q(season)},${q(members[i])},${q(player)},'draft',now()-interval '40 days');`).join('\n')}
        ${games.map((game,w) => `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
          VALUES(${q(game)},${q('002-stall-'+game)},${year},${w+1},current_date-${27-w*7},now()-interval '${27-w*7} days','XST','XSU','Final',now());
          ${players.slice(0,count).map((player,i) => `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play) VALUES(${q(player)},${q(game)},${year},${w+1},current_date-${27-w*7},${40-i*10},false);
            INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set) VALUES(${q(league)},${q(season)},${q(members[i])},${q(player)},${w+1},current_date-${27-w*7},'PG',false);`).join('\n')}`).join('\n')}
        INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team) VALUES(${q(players[count])},'Synthetic','No game free agent','PG',ARRAY['PG'],'Active','XST');
        SELECT replace_regular_season_matchups_atomic(${q(league)},${q(season)},false,private.regular_season_matchup_payload(${q(league)},${q(season)},1));
        COMMIT;`)
      await syncScores(league, new Date(), { recoverStats: false })
      if (state !== 'bracket') await sql(`SELECT generate_playoff_bracket_atomic(${q(league)}); UPDATE leagues SET status='playoffs' WHERE id=${q(league)}`)
      await syncScores(league, new Date(), { recoverStats: false })
      await sql(`UPDATE matchups SET finalized_at=now()-interval '73 hours' WHERE league_season_id=${q(season)}`)
      await syncScores(league, new Date(), { recoverStats: false })
      assert.equal(await stale(), '0', 'Initial real score certificates are current')
      const decision = await sql(`SELECT jsonb_agg(jsonb_build_object('id',id,'winner',winner_member_id,'grace',finalized_at) ORDER BY id) FROM matchups WHERE league_season_id=${q(season)}`)
      assert.equal(await sql(`SELECT count(*) FROM nba_games WHERE season_year=${year} AND nba_game_id LIKE '002%' AND (status<>'Final' OR stats_synced_at IS NULL)`), '0', 'No NBA ingestion work remains')
      if (state !== 'current') {
        await sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(users[0])},true); SELECT add_free_agent_atomic(${q(members[0])},${q(league)},${q(players[count])}); COMMIT;`)
        assert.ok(Number(await stale()) > 0, 'One real free-agent add invalidates the certificates')
      }
      scoreCalls = 0
      const early = await tick(-27)
      assert.equal(early.error, undefined)
      assert.deepEqual(early.actions, [])
      assert.equal(scoreCalls, 0, 'A league within the 48-hour grace must not be re-scored')
      if (state === 'refresh_failure') {
        await sql(`UPDATE nba_games SET stats_synced_at=NULL WHERE id=${q(games[1])}`)
        const blocked = await tick()
        assert.match(blocked.error ?? '', /certificates remain stale/)
        assert.deepEqual(blocked.actions, [])
        assert.equal(scoreCalls, 1, 'A failed refresh makes exactly one scorer call')
        assert.equal(await sql(`SELECT id FROM league_seasons WHERE league_id=${q(league)} AND is_current`), season)
        await sql(`UPDATE nba_games SET stats_synced_at=now() WHERE id=${q(games[1])}`)
        scoreCalls = 0
      }
      if (state === 'refresh_error') {
        failScoreRead = true
        const blocked = await tick()
        failScoreRead = false
        assert.match(blocked.error ?? '', /Score sync failed/)
        assert.deepEqual(blocked.actions, [])
        assert.equal(scoreCalls, 1)
        assert.equal(await sql(`SELECT id FROM league_seasons WHERE league_id=${q(league)} AND is_current`), season)
        scoreCalls = 0
      }
      if (state === 'correction') await sql(`UPDATE player_game_stats SET points=100 WHERE game_id=${q(games[1])} AND player_id=${q(players[1])}`)
      const reports = [await tick(), await tick(24)]
      assert.ok(reports.every(report => !report.error), JSON.stringify(reports))
      if (state === 'correction') {
        assert.ok(reports.every(report => report.actions.length === 0), 'A changed decision starts a new 48-hour grace')
        assert.equal(await sql(`SELECT id FROM league_seasons WHERE league_id=${q(league)} AND is_current`), season)
        assert.equal(scoreCalls, 1)
        console.log('PASS corrected winner waits for a new grace without a second score refresh')
        continue
      }
      assert.ok(reports[0].actions.includes(expected), `Same-run ${expected} must follow stale recovery`)
      assert.deepEqual(reports[1].actions, [], 'The next daily period does nothing')
      assert.equal(scoreCalls, state === 'current' ? 0 : 1, 'Only a due stale league calls the actual scorer once')
      assert.equal(await sql(`SELECT jsonb_agg(jsonb_build_object('id',id,'winner',winner_member_id,'grace',finalized_at) ORDER BY id) FROM matchups WHERE league_season_id=${q(season)} ${state==='bracket'?"AND matchup_type='regular_season'":state==='advance'?"AND matchup_type<>'playoff_final'":''}`), decision, 'Unchanged decisions preserve the original 48-hour grace')
      console.log(`PASS ${state}: same-run recovery, current-certificate skip, preserved grace, and daily idempotence`)
    } catch (error) {
      failures.push(`${state}: ${(error as Error).message}`)
    } finally {
      failScoreRead = false
      await sql(`DELETE FROM leagues WHERE id=${q(league)};
        DELETE FROM player_game_stats WHERE game_id IN(${games.map(q).join(',')}); DELETE FROM nba_games WHERE id IN(${games.map(q).join(',')});
        DELETE FROM players WHERE id IN(${players.map(q).join(',')}); DELETE FROM auth.users WHERE id IN(${users.map(q).join(',')});
        DELETE FROM season_weeks WHERE season_year IN(${year},${year+1});`)
    }
  }
} finally { globalThis.fetch = nativeFetch }
assert.deepEqual(failures, [])
