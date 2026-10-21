import assert from 'node:assert/strict'
import { fixture, literal as q, sql } from './identity-db.ts'
import type { fetchBoxScore } from '../../functions/_shared/nba.ts'

type NBABoxScore = Awaited<ReturnType<typeof fetchBoxScore>>

assert.equal(await sql('SELECT count(*) FROM players'), '0')
Deno.env.set('NBA_CDN_BASE_URL', 'http://127.0.0.1:57780')
const { syncStatsGame } = await import('../../functions/_shared/syncStats.ts')
const nativeFetch = globalThis.fetch
const results: object[] = []
for (const world of [
  { id: '0022400768', person: '1629029', name: 'Luka Dončić', old: 'DAL', team: 'LAL', opponent: 'UTA' },
  { id: '0022500756', person: '201935', name: 'James Harden', old: 'LAC', team: 'CLE', opponent: 'SAC' },
]) {
  const { game: raw } = await fixture<{ game: NBABoxScore }>(`boxscore-${world.id}.json`)
  const box = { ...raw, gameStatus: 2, period: 1, gameClock: 'PT11M00.00S' }
  const user = crypto.randomUUID(), league = crypto.randomUUID(), season = crypto.randomUUID()
  const member = crypto.randomUUID(), player = crypto.randomUUID(), game = crypto.randomUUID(), oldGame = crypto.randomUUID()
  const day = await sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
  const first = world.name.split(' ')[0], last = world.name.slice(first.length + 1)
  let statAttempts = 0
  const server = Deno.serve({ hostname: '127.0.0.1', port: 57780, onListen: () => undefined }, request => {
    assert.equal(new URL(request.url).pathname, `/liveData/boxscore/boxscore_${world.id}.json`)
    return Response.json({ game: box })
  })
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith('/save_live_game_stats_atomic')) {
      statAttempts++
      return Promise.resolve(Response.json({ code: 'P0001', message: 'Synthetic stat persistence failure after verified membership' }, { status: 500 }))
    }
    return nativeFetch(input, init)
  }
  try {
    await sql(`BEGIN;
      INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES(${q(user)},'authenticated','authenticated',${q(user + '@example.test')},'x',now(),'{}','{}',now(),now());
      INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size) VALUES(${q(league)},'Synthetic membership clock',${q(league)},${q(user)},'active',2);
      INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Team');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},2198,true);
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(2198,1,${q(day)}::date-3,${q(day)}::date+3);
      INSERT INTO players(id,first_name,last_name,nba_id,nba_team,position,eligible_positions) VALUES(${q(player)},${q(first)},${q(last)},${q(world.person)},${q(world.old)},'PG',ARRAY['PG']);
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      VALUES(${q(league)},${q(season)},${q(member)},${q(player)},'draft',now()-interval '1 day');
      INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
      VALUES(${q(oldGame)},${q('membership-old-' + player)},2198,1,${q(day)},${q(world.old)},'XOP','Scheduled',now()+interval '2 hours'),
        (${q(game)},${q(world.id)},2198,1,${q(day)},${q(world.team)},${q(world.opponent)},'InProgress',now()-interval '5 seconds');
      COMMIT`)
    const move = (slot: string) => sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(user)},true);
      SELECT set_player_slot_atomic(${q(member)},${q(league)},${q(season)},${q(player)},${q(day)},'${slot}',1); COMMIT`)
    await move('PG'); await move('BE')
    assert.equal(await sql(`SELECT count(*) FROM weekly_lineups WHERE league_id=${q(league)} AND slot_type NOT IN ('BE','IR')`), '0')
    await move('PG')
    await assert.rejects(() => syncStatsGame({ id: game, nba_game_id: world.id, season_year: 2198, week_number: 1, status: 'InProgress' }), { message: 'Synthetic stat persistence failure after verified membership' })
    assert.equal(statAttempts, 1)
    assert.equal(await sql(`SELECT count(*) FROM player_game_stats WHERE game_id=${q(game)}`), '0')
    await assert.rejects(() => move('BE'), /Lineup changes are locked/, 'Verified first box must close the stale-team bench gap before stat persistence')
    assert.equal(await sql(`SELECT private.roster_status_game_started(${q(player)})`), 't')
    assert.equal(await sql(`SELECT nba_team FROM players WHERE id=${q(player)}`), world.old)
    assert.equal(await sql(`SELECT count(*) FROM private.player_game_memberships WHERE player_id=${q(player)} AND game_id=${q(game)}`), '1')
    const firstSeen = await sql(`SELECT first_seen_at FROM private.player_game_memberships WHERE player_id=${q(player)} AND game_id=${q(game)}`)
    await assert.rejects(() => syncStatsGame({ id: game, nba_game_id: world.id, season_year: 2198, week_number: 1, status: 'InProgress' }), { message: 'Synthetic stat persistence failure after verified membership' })
    assert.equal(await sql(`SELECT first_seen_at FROM private.player_game_memberships WHERE player_id=${q(player)} AND game_id=${q(game)}`), firstSeen)
    await sql(`UPDATE players SET nba_team=${q(world.team)} WHERE id=${q(player)};
      UPDATE nba_games SET game_date=${q(day)}::date-1,status='Final',game_time=now()-interval '1 day' WHERE id=${q(oldGame)};
      SELECT resolve_player_imports_atomic('nba_cdn',jsonb_build_array(jsonb_build_object('provider_id',${q(world.person)},'display_name',${q(world.name)},'nba_game_id',${q('membership-old-' + player)})))`)
    assert.equal(await sql(`SELECT nba_team FROM players WHERE id=${q(player)}`), world.team)
    assert.equal(await sql(`SELECT count(*) FROM private.player_game_memberships WHERE player_id=${q(player)}`), '2')
    const duplicate = crypto.randomUUID()
    await sql(`INSERT INTO players(id,first_name,last_name) VALUES(${q(duplicate)},'Synthetic',${q(duplicate)});
      DELETE FROM private.player_game_memberships WHERE player_id=${q(player)} AND game_id=${q(oldGame)};
      INSERT INTO private.player_game_memberships(player_id,game_id,first_seen_at)
        VALUES(${q(duplicate)},${q(game)},${q(firstSeen)}::timestamptz-interval '1 hour'),
          (${q(duplicate)},${q(oldGame)},now());
      SELECT merge_players(${q(player)},${q(duplicate)})`)
    assert.equal(await sql(`SELECT count(*) FROM private.player_game_memberships WHERE player_id=${q(player)}`), '2')
    assert.equal(await sql(`SELECT first_seen_at=${q(firstSeen)}::timestamptz-interval '1 hour'
      FROM private.player_game_memberships WHERE player_id=${q(player)} AND game_id=${q(game)}`), 't')
    results.push({ world: world.id, canonical: player, beforeFirstPoll: 'bench remains possible without source data', statRows: 0, lockedAfterFirstBox: true, historicalMemberships: 2 })
  } finally {
    globalThis.fetch = nativeFetch
    await server.shutdown()
    await sql(`BEGIN; DELETE FROM leagues WHERE id=${q(league)}; DELETE FROM player_game_stats; DELETE FROM nba_games WHERE id IN (${q(game)},${q(oldGame)}); DELETE FROM players; DELETE FROM season_weeks WHERE season_year=2198; DELETE FROM auth.users WHERE id=${q(user)}; COMMIT`)
  }
}
const cadence = await sql("SELECT schedule FROM cron.job WHERE jobname='nba-live-poll'")
assert.equal(cadence, '*/2 * * * *')
console.log(JSON.stringify({ provenance: 'REAL-DERIVED identities and boxes; SYNTHETIC live replay, current clock, ownership and stat failure', residualPollingSeconds: 120, conditionalBound: 'healthy cron, provider and invocation; provider delay and outages remain unbounded', cadence, results }))
