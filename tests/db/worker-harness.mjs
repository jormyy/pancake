import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const database = databaseTarget().href
export const quote = (value) => `'${String(value).replaceAll("'", "''")}'`

export function sql(query, { timeout = 60000 } = {}) {
  const started = performance.now()
  const result = spawnSync('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: query, encoding: 'utf8', timeout, maxBuffer: 1 << 26 })
  return { ok: result.status === 0, out: result.stdout.trim(), err: (result.stderr || result.error?.message || '').trim(), ms: performance.now() - started }
}

export function must(query) {
  const result = sql(query)
  if (!result.ok) throw new Error(result.err)
  return result.out
}

export async function hold(statement) {
  const child = spawn('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''
  child.stderr.on('data', (bytes) => { errors += bytes })
  const done = new Promise((resolve) => child.on('exit', resolve))
  await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (bytes) => { output += bytes; if (output.includes('HOLD_READY')) resolve() })
    child.on('error', reject)
    done.then(() => reject(new Error(`The held transaction failed: ${errors.trim()}`)))
    child.stdin.write(`BEGIN;\n${statement};\n\\echo HOLD_READY\n`)
  })
  return async () => {
    if (child.exitCode === null) child.stdin.end('ROLLBACK;\n')
    await done
  }
}

export function liveFixture() {
  const tag = randomUUID().replaceAll('-', '')
  const ids = Object.fromEntries(['game', 'league', 'season', 'matchup', 'user0', 'user1', 'member0', 'member1']
    .map((name) => [name, randomUUID()]))
  const players = [randomUUID(), randomUUID()].sort()
  const provider = `002-matrix-${tag}`
  const year = Number(must('SELECT coalesce(max(season_year),2026)+1 FROM public.season_weeks'))
  const users = [ids.user0, ids.user1]
  const members = [ids.member0, ids.member1]
  const stats = (points) => quote(JSON.stringify(players.map((player_id) => ({ player_id, game_id: ids.game, points, minutes_played: 6, did_not_play: false }))))
  must(`BEGIN;
    INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(${year},1,current_date,current_date+6);
    INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES ${users.map((id, index) =>
      `(${quote(id)},${quote(`${id}@example.invalid`)},jsonb_build_object('username',${quote(tag + index)}))`).join(',')};
    INSERT INTO public.leagues(id,name,slug,commissioner_id,status,roster_size,auction_budget,scoring_settings)
      VALUES(${quote(ids.league)},'Matrix fixture',${quote(ids.league)},${quote(users[0])},'active',12,200,'{"points":1}');
    INSERT INTO public.league_members(id,league_id,user_id,role,team_name) VALUES ${members.map((id, index) =>
      `(${quote(id)},${quote(ids.league)},${quote(users[index])},${quote(index ? 'manager' : 'commissioner')},${quote(`Matrix ${index}`)})`).join(',')};
    INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(${quote(ids.season)},${quote(ids.league)},${year},true);
    INSERT INTO public.players(id,first_name,last_name,nba_team,nba_id,espn_id,position,eligible_positions,career_games_base,career_games_base_season,career_games_base_source,career_games_base_checked_at)
      VALUES ${players.map((id, index) => `(${quote(id)},'Lock',${quote(id)},'BOS',${quote(99000000 + index)},${quote(88000000 + index)},NULL,'{}',0,${year - 1},'rookie',now())`).join(',')};
    INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at) VALUES ${players.map((id, index) =>
      `(${quote(ids.league)},${quote(ids.season)},${quote(members[index])},${quote(id)},'draft',now()-interval '1 hour')`).join(',')};
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,home_score,away_score,game_status_text,game_time)
      VALUES(${quote(ids.game)},${quote(provider)},${year},1,current_date,'BOS','NYK','InProgress',10,10,'Q1',now()-interval '6 minutes');
    INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type,is_finalized)
      VALUES(${quote(ids.matchup)},${quote(ids.league)},${quote(ids.season)},1,${quote(members[0])},${quote(members[1])},'regular_season',false);
    INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type) VALUES ${players.map((id, index) =>
      `(${quote(ids.league)},${quote(ids.season)},${quote(members[index])},${quote(id)},1,current_date,'PG')`).join(',')};
    SELECT public.save_live_game_stats_atomic(${quote(ids.game)},${quote(provider)},${stats(10)}::jsonb,360);
    COMMIT;`)
  const cleanup = () => sql(`DELETE FROM public.leagues WHERE id=${quote(ids.league)};
    DELETE FROM auth.users WHERE id IN (${users.map(quote).join(',')});
    DELETE FROM public.player_game_stats WHERE game_id=${quote(ids.game)};
    DELETE FROM public.nba_games WHERE id=${quote(ids.game)};
    DELETE FROM public.players WHERE id IN (${players.map(quote).join(',')});
    DELETE FROM public.season_weeks WHERE season_year=${year};`)
  return { tag, ids, players, provider, year, members, stats, cleanup }
}

export function report(results) {
  for (const result of results) {
    console.log(`${result.ok ? 'ok' : 'FAIL'} ${result.name}: ${result.detail}`)
    if (!result.ok) console.log(`  fix: ${result.fix}${result.history ? ` History: ${result.history}.` : ''}`)
  }
  const failed = results.filter((result) => !result.ok).length
  console.log(`${results.length - failed} of ${results.length} passed`)
  return failed === 0 ? 0 : 1
}
