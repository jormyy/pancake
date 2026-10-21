import assert from 'node:assert/strict'

// Served-path season-boundary oracle: every boundary tick is an HTTP POST to the
// real `season-boundary` Edge function served by the local stack, never an
// in-process runSeasonBoundary call. Fixtures are SYNTHETIC; assertions read the
// HTTP report, the worker's sync_runs row and the persisted league state.
const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const target of [api, db]) assert.ok(['127.0.0.1', 'localhost'].includes(new URL(target).hostname))
assert.equal(new URL(api).port, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321')
assert.equal(new URL(db).port, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322')
const token = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(token)
const endpoint = `${api}/functions/v1/season-boundary`
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
const check = async (condition: string, label: string) => {
  assert.equal(await sql(`SELECT (${condition})::text`), 'true', label)
  console.log(`PASS ${label}`)
}
type Report = { leagueId: string; actions: string[]; error?: string }
const tick = async (state: string, league: string, at: string): Promise<Report> => {
  const runs = await sql(`SELECT count(*) FROM sync_runs WHERE function_name='season-boundary'`)
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-function-token': token },
    body: JSON.stringify({ leagueId: league, date: at }) })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const body = JSON.parse(text) as { ok: boolean; leagues: Report[] }
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', path: 'edge-http:season-boundary', state, at, leagues: body.leagues }))
  assert.equal(body.ok, true)
  assert.equal(Number(await sql(`SELECT count(*) FROM sync_runs WHERE function_name='season-boundary'`)), Number(runs) + 1, 'The served worker records one sync run per tick')
  assert.equal(body.leagues.length, 1, `${state}: the served worker must process the synthetic league at ${at}`)
  return body.leagues[0]
}
const insertUsers = (users: string[]) => users.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  VALUES(${q(user)},'authenticated','authenticated',${q(user+'@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')
const insertMembers = (league: string, users: string[], members: string[]) => members.map((member, i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name,joined_at)
  VALUES(${q(member)},${q(league)},${q(users[i])},'${i ? 'manager' : 'commissioner'}','Team ${i}',now()+interval '${i} seconds');`).join('\n')
const years = { 'skipped-fallback': 9761, 'drafting-cutoff': 9771, 'stale-rollover': 9781, 'expired-fallback': 9791 } as const
const cases = Object.keys(years) as (keyof typeof years)[]
const selected = Deno.env.get('POST_HTTP_CASE')
assert.ok(!selected || cases.includes(selected as keyof typeof years))
const failures: string[] = []

// A rookie class of 12 picks for 4 managers and 3 rounds in a 12-week synthetic calendar
// whose week one runs 2026-10-20..25 and week two starts 2026-10-26.
async function draftLeague(state: keyof typeof years, league: string, season: string, users: string[], members: string[], players: string[]) {
  const year = years[state]
  await sql(`BEGIN;
    ${insertUsers(users)}
    INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths,scoring_settings)
      VALUES(${q(league)},'Synthetic served boundary',${q(league)},${q(users[0])},'offseason',8,4,ARRAY[2,2],'{"points":1}');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    ${insertMembers(league, users, members)}
    INSERT INTO draft_picks(league_id,season_year,round,original_owner_id,current_owner_id)
      SELECT ${q(league)},${year},r,m,m FROM unnest(ARRAY[${members.map(q).join(',')}]::uuid[]) m CROSS JOIN generate_series(1,3) r;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
      SELECT ${year},w,date '2026-10-20'+CASE WHEN w=1 THEN 0 ELSE 6+(w-2)*7 END,date '2026-10-25'+(w-1)*7 FROM generate_series(1,12) w;
    ${players.map(player => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,nba_draft_number) VALUES(${q(player)},'Synthetic',${q(player)},'PG',ARRAY['PG'],0,1);`).join('\n')}
    COMMIT;`)
}
const filledPicks = (league: string) => `(SELECT count(*) FROM snake_draft_picks p JOIN drafts d ON d.id=p.draft_id WHERE d.league_id=${q(league)} AND p.player_id IS NOT NULL)`

async function skippedFallback(league: string, season: string, users: string[]) {
  // Unpublished opening night: the backstop falls back to the first non-skipped week.
  await sql(`BEGIN; SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.sub',${q(users[0])},true);
    SELECT update_league_settings_atomic(${q(league)},${q(JSON.stringify({ skipped_weeks: [1] }))}); COMMIT;`)
  await check(`(SELECT skipped_weeks=ARRAY[1] FROM league_seasons WHERE id=${q(season)}) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=${years['skipped-fallback']})`, 'skipped-fallback: week one skipped and opening night unpublished')
  for (const at of ['2026-10-20T16:00:00Z', '2026-10-26T03:59:59Z']) {
    const report = await tick('skipped-fallback', league, at)
    assert.equal(report.error, undefined)
    assert.ok(!report.actions.some(action => action.startsWith('rookie-draft')), `skipped-fallback: no rookie action before week two at ${at}`)
    await check(`NOT EXISTS(SELECT 1 FROM drafts WHERE league_id=${q(league)}) AND (SELECT status='offseason' FROM leagues WHERE id=${q(league)})`, `skipped-fallback: skipped week one does not start the rookie draft at ${at}`)
  }
  await check(`NOT EXISTS(SELECT 1 FROM matchups WHERE league_season_id=${q(season)} AND week_number=1 AND NOT is_voided)
    AND (SELECT min(week_number)=2 AND max(week_number)=7 FROM matchups WHERE league_season_id=${q(season)} AND NOT is_voided)`, 'skipped-fallback: served offseason backfill schedules weeks two to seven')
  const due = await tick('skipped-fallback', league, '2026-10-26T04:00:00Z')
  assert.equal(due.error, undefined, 'skipped-fallback: the missing-draft start must succeed')
  assert.deepEqual(due.actions, ['rookie-draft-started', 'rookie-draft-auto-completed'])
  await check(`(SELECT count(*)=1 AND bool_and(status='completed' AND pick_timer_seconds=60) FROM drafts WHERE league_id=${q(league)})
    AND ${filledPicks(league)}=12 AND (SELECT status='active' FROM leagues WHERE id=${q(league)})`, 'skipped-fallback: week-two start completes all 12 picks with the 60-second timer')
  const repeated = await tick('skipped-fallback', league, '2026-10-26T04:00:01Z')
  assert.equal(repeated.error, undefined)
  assert.ok(!repeated.actions.some(action => action.startsWith('rookie-draft')))
  await check(`(SELECT count(*)=1 FROM drafts WHERE league_id=${q(league)})`, 'skipped-fallback: a repeated tick creates no second draft')
}

async function draftingCutoff(league: string, users: string[]) {
  // Published opening night: 09:00 ET on the first 002 game date, 2026-10-20T13:00:00Z.
  const year = years['drafting-cutoff']
  await sql(`SELECT start_rookie_draft_atomic(${q(league)},3,false);
    SELECT pause_draft_atomic((SELECT id FROM drafts WHERE league_id=${q(league)}),${q(users[0])});
    INSERT INTO nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
      VALUES('002${String(year).padStart(7, '0')}',${year},1,'2026-10-20','2026-10-20T23:30:00Z','SYN','SYN','Scheduled');`)
  await check(`(SELECT status='drafting' FROM leagues WHERE id=${q(league)}) AND (SELECT status='paused' AND pause_reason='manual' FROM drafts WHERE league_id=${q(league)})`, 'drafting-cutoff: commissioner-paused real draft in a drafting league')
  const early = await tick('drafting-cutoff', league, '2026-10-20T12:59:59Z')
  assert.equal(early.error, undefined)
  assert.deepEqual(early.actions, [])
  await check(`(SELECT status='paused' FROM drafts WHERE league_id=${q(league)}) AND ${filledPicks(league)}=0`, 'drafting-cutoff: the draft stays paused one second before the cutoff')
  const due = await tick('drafting-cutoff', league, '2026-10-20T13:00:00Z')
  assert.equal(due.error, undefined)
  assert.deepEqual(due.actions, ['rookie-draft-auto-completed'])
  await check(`(SELECT status='completed' FROM drafts WHERE league_id=${q(league)}) AND ${filledPicks(league)}=12
    AND NOT EXISTS(SELECT 1 FROM snake_draft_picks p JOIN drafts d ON d.id=p.draft_id WHERE d.league_id=${q(league)} AND p.timer_expires_at IS NOT NULL)
    AND (SELECT status='active' FROM leagues WHERE id=${q(league)})`, 'drafting-cutoff: the served cutoff completes the paused draft and activates the league')
  const after = await tick('drafting-cutoff', league, '2026-10-20T13:00:01Z')
  assert.equal(after.error, undefined)
  assert.deepEqual(after.actions, ['matchups-generated'])
  await check(`(SELECT count(*)=1 FROM drafts WHERE league_id=${q(league)})`, 'drafting-cutoff: the next tick schedules the activated league without another draft')
}

async function expiredFallback(league: string, season: string) {
  // Unpublished opening night, no skipped week: the fallback is week one's start,
  // 2026-10-20T04:00:00Z. The real draft's first pick timer has already expired.
  const year = years['expired-fallback']
  await sql(`SELECT start_rookie_draft_atomic(${q(league)},3,false);
    UPDATE snake_draft_picks SET timer_expires_at=now()-interval '1 minute'
      WHERE draft_id=(SELECT id FROM drafts WHERE league_id=${q(league)}) AND overall_pick=1;`)
  await check(`(SELECT status='drafting' FROM leagues WHERE id=${q(league)}) AND (SELECT status='in_progress' FROM drafts WHERE league_id=${q(league)})
    AND (SELECT timer_expires_at<now() FROM snake_draft_picks p JOIN drafts d ON d.id=p.draft_id WHERE d.league_id=${q(league)} AND p.overall_pick=1)
    AND (SELECT skipped_weeks='{}' FROM league_seasons WHERE id=${q(season)}) AND NOT EXISTS(SELECT 1 FROM nba_games WHERE season_year=${year})`, 'expired-fallback: in-progress real draft with an expired pick timer and unpublished opening night')
  const early = await tick('expired-fallback', league, '2026-10-20T03:59:59Z')
  assert.equal(early.error, undefined)
  assert.deepEqual(early.actions, [])
  await check(`(SELECT status='in_progress' FROM drafts WHERE league_id=${q(league)}) AND ${filledPicks(league)}=0`, 'expired-fallback: the draft is untouched one second before week one')
  const due = await tick('expired-fallback', league, '2026-10-20T04:00:00Z')
  assert.equal(due.error, undefined, 'expired-fallback: the backstop must complete an expired pick')
  assert.deepEqual(due.actions, ['rookie-draft-auto-completed'])
  await check(`(SELECT count(*)=1 AND bool_and(status='completed') FROM drafts WHERE league_id=${q(league)}) AND ${filledPicks(league)}=12
    AND (SELECT status='active' FROM leagues WHERE id=${q(league)})`, 'expired-fallback: the week-one fallback completes all 12 picks and activates the league')
}

async function staleRollover(league: string, season: string, users: string[], members: string[], players: string[], games: string[]) {
  const year = years['stale-rollover']
  const { syncScores } = await import('../../functions/_shared/syncScores.ts')
  const stale = async () => Number(await sql(`SELECT count(*) FROM get_stale_score_weeks(${q(season)},3)`))
  const current = () => sql(`SELECT id FROM league_seasons WHERE league_id=${q(league)} AND is_current`)
  const decisions = () => sql(`SELECT jsonb_agg(jsonb_build_object('id',id,'winner',winner_member_id,'grace',finalized_at) ORDER BY id) FROM matchups WHERE league_season_id=${q(season)}`)
  await sql(`BEGIN;
    ${insertUsers(users)}
    INSERT INTO leagues(id,name,slug,commissioner_id,status,playoff_start_week,playoff_entrants,playoff_round_lengths,scoring_settings)
      VALUES(${q(league)},'Synthetic served stale boundary',${q(league)},${q(users[0])},'active',2,2,ARRAY[1],'{"points":1}');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${year},true);
    ${insertMembers(league, users, members)}
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${year},w,current_date-28+(w-1)*7,current_date-22+(w-1)*7 FROM generate_series(1,3) w;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) SELECT ${year + 1},w,current_date+365+(w-1)*7,current_date+371+(w-1)*7 FROM generate_series(1,3) w;
    ${members.map((member, i) => `INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,injury_status,nba_team) VALUES(${q(players[i])},'Synthetic',${q('Served stall '+i)},'PG',ARRAY['PG'],'Active','Out','XST');
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES(${q(league)},${q(season)},${q(member)},${q(players[i])},'draft',now()-interval '40 days');`).join('\n')}
    ${games.map((game, w) => `INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
      VALUES(${q(game)},${q('002-served-'+game)},${year},${w + 1},current_date-${27 - w * 7},now()-interval '${27 - w * 7} days','XST','XSU','Final',now());
      ${members.map((member, i) => `INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,game_date,points,did_not_play) VALUES(${q(players[i])},${q(game)},${year},${w + 1},current_date-${27 - w * 7},${40 - i * 10},false);
        INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type,is_auto_set) VALUES(${q(league)},${q(season)},${q(member)},${q(players[i])},${w + 1},current_date-${27 - w * 7},'PG',false);`).join('\n')}`).join('\n')}
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team) VALUES(${q(players[2])},'Synthetic','Served free agent','PG',ARRAY['PG'],'Active','XST');
    SELECT replace_regular_season_matchups_atomic(${q(league)},${q(season)},false,private.regular_season_matchup_payload(${q(league)},${q(season)},1));
    COMMIT;`)
  // Setup scores through the real scorer, then a real free-agent add makes the certificates stale.
  await syncScores(league, new Date(), { recoverStats: false })
  await sql(`SELECT generate_playoff_bracket_atomic(${q(league)}); UPDATE leagues SET status='playoffs' WHERE id=${q(league)}`)
  await syncScores(league, new Date(), { recoverStats: false })
  await sql(`UPDATE matchups SET finalized_at=now()-interval '73 hours' WHERE league_season_id=${q(season)}`)
  await syncScores(league, new Date(), { recoverStats: false })
  assert.equal(await stale(), 0, 'stale-rollover: the real scorer leaves current certificates')
  await check(`(SELECT count(*)=1 AND bool_and(is_finalized AND winner_member_id IS NOT NULL) FROM matchups WHERE league_season_id=${q(season)} AND matchup_type='playoff_final')`, 'stale-rollover: the final is decided')
  await sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(users[0])},true); SELECT add_free_agent_atomic(${q(members[0])},${q(league)},${q(players[2])}); COMMIT;`)
  const staleWeeks = await stale()
  assert.ok(staleWeeks > 0, 'stale-rollover: one real free-agent add invalidates the certificates')
  const decided = await decisions()
  const hours = (offset: number) => new Date(Date.now() + offset * 3_600_000).toISOString()
  const early = await tick('stale-rollover', league, hours(-27))
  assert.equal(early.error, undefined)
  assert.deepEqual(early.actions, [])
  assert.equal(await stale(), staleWeeks, 'stale-rollover: a final inside its 48-hour grace is not re-scored')
  assert.equal(await current(), season)
  const due = await tick('stale-rollover', league, hours(0))
  assert.equal(due.error, undefined)
  assert.deepEqual(due.actions, ['season-advanced', 'matchups-generated'], 'stale-rollover: same-run stale refresh must roll the season over')
  await check(`(SELECT season_year=${year + 1} FROM league_seasons WHERE league_id=${q(league)} AND is_current)
    AND (SELECT NOT is_current FROM league_seasons WHERE id=${q(season)}) AND (SELECT status='offseason' FROM leagues WHERE id=${q(league)})`, 'stale-rollover: the served worker advances the season')
  assert.equal(await stale(), 0, 'stale-rollover: the served refresh rewrote the stale certificates')
  assert.equal(await decisions(), decided, 'stale-rollover: unchanged decisions keep their original grace')
  const next = await tick('stale-rollover', league, hours(24))
  assert.equal(next.error, undefined)
  assert.ok(!next.actions.includes('season-advanced'))
  await check(`(SELECT count(*)=2 FROM league_seasons WHERE league_id=${q(league)})`, 'stale-rollover: the next daily tick does not roll over again')
}

for (const state of cases.filter(value => !selected || value === selected)) {
  const league = crypto.randomUUID(), season = crypto.randomUUID()
  const count = state === 'stale-rollover' ? 2 : 4
  const users = Array.from({ length: count }, () => crypto.randomUUID())
  const members = users.map(() => crypto.randomUUID())
  const players = Array.from({ length: state === 'stale-rollover' ? 3 : 12 }, () => crypto.randomUUID())
  const games = [crypto.randomUUID(), crypto.randomUUID()]
  const year = years[state]
  try {
    assert.equal(await sql(`SELECT count(*) FROM season_weeks WHERE season_year IN(${year},${year + 1})`), '0', `Synthetic years ${year}-${year + 1} are occupied`)
    if (state === 'stale-rollover') await staleRollover(league, season, users, members, players, games)
    else {
      await draftLeague(state, league, season, users, members, players)
      if (state === 'skipped-fallback') await skippedFallback(league, season, users)
      else if (state === 'expired-fallback') await expiredFallback(league, season)
      else await draftingCutoff(league, users)
    }
    console.log(`PASS ${state}: served season-boundary path`)
  } catch (error) {
    failures.push(`${state}: ${(error as Error).message}`)
  } finally {
    await sql(`BEGIN;
      DELETE FROM snake_draft_picks WHERE draft_id IN(SELECT id FROM drafts WHERE league_id=${q(league)});
      DELETE FROM draft_picks WHERE league_id=${q(league)}; DELETE FROM drafts WHERE league_id=${q(league)};
      DELETE FROM leagues WHERE id=${q(league)};
      DELETE FROM player_game_stats WHERE game_id IN(${games.map(q).join(',')});
      DELETE FROM nba_games WHERE id IN(${games.map(q).join(',')}) OR season_year IN(${year},${year + 1});
      DELETE FROM players WHERE id IN(${players.map(q).join(',')});
      DELETE FROM season_weeks WHERE season_year IN(${year},${year + 1});
      DELETE FROM auth.users WHERE id IN(${users.map(q).join(',')});
      COMMIT;`)
  }
}
assert.deepEqual(failures, [])
Deno.exit(0)
