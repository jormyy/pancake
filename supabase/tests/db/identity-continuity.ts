import assert from 'node:assert/strict'
import { fixture, literal as q, sql, type Identity, type Rookie } from './identity-db.ts'

assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated identity stack')
const { resolvePlayerImports } = await import('../../functions/_shared/playerImports.ts')
const { resolveCdnPlayers } = await import('../../functions/_shared/playerResolver.ts')
const { calcWeekPointsByMember } = await import('../../functions/_shared/scoreLineups.ts')
const { syncScores } = await import('../../functions/_shared/syncScores.ts')
type Game = { gameId: string; date: string; home: string; away: string; time: string }
type Sample = { gameId: string; date: string; team: string; points: number }
const { picks } = await fixture<{ picks: Rookie[] }>('rookies-2025.json')
const { games: seasonGames } = await fixture<{ games: Game[] }>('games-2025.json')
const { games: priorGames } = await fixture<{ games: Game[] }>('games-2024.json')
const { games: lukaGames } = await fixture<{ games: (Sample & { personId: string; identity: Identity; statistics: { points: number } })[] }>('trades-2025.json')
const harden = await fixture<{ personId: string; identity: Identity; games: (Sample & { statistics: { points: number } })[] }>('trade-harden.json')
const games = new Map([...seasonGames, ...priorGames].map(game => [game.gameId, game]))
const leagues: string[] = [], users: string[] = [], ownedGames: string[] = []
const source = crypto.randomUUID(), run = crypto.randomUUID()
const results: Record<string, unknown>[] = []
let playerIds: string[] = []
const set = (values: string[]) => values.map(q).join(',')
const dayBefore = (date: string) => new Date(Date.parse(date + 'T12:00:00Z') - 86400000).toISOString()
const check = async (expression: string, message: string) => assert.equal(await sql(`SELECT (${expression})::text`), 'true', message)
const ensureGame = async (gameId: string, year: number) => {
  const existing = await sql(`SELECT id FROM nba_games WHERE nba_game_id=${q(gameId)}`)
  if (existing) return existing
  const game = games.get(gameId)!
  assert.ok(game, gameId)
  const id = crypto.randomUUID()
  ownedGames.push(id)
  await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
    VALUES(${q(id)},${q(gameId)},${year},1,${q(game.date)},${q(game.time)},${q(game.home)},${q(game.away)},'Final',now())`)
  return id
}
try {
  const board = await resolvePlayerImports('nba_draft', picks.map(pick => ({ display_name: pick.name, nba_draft_number: pick.pick })))
  assert.ok(board.results.every(row => row.player_id && ['inserted', 'updated'].includes(row.action)))
  const byPick = new Map(board.results.map((row, index) => [picks[index].pick, row.player_id!]))
  await sql(`INSERT INTO projection_sync_runs(id,projection_type,source_url) VALUES(${q(run)},'daily','https://www.fantasypros.com/nba/projections/daily-overall.php');
    INSERT INTO dynasty_rankings(source,source_rank,source_player_name,player_id)
    SELECT ${q(source)},nba_draft_number,display_name,id FROM players WHERE nba_draft_number IS NOT NULL;
    INSERT INTO fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,fetched_at,source_player_name,normalized_player_name,player_id,match_status,points)
    SELECT ${q(run)},'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',nba_draft_number,now(),display_name,private.player_import_name_key(display_name),id,'matched',1
    FROM players WHERE nba_draft_number IS NOT NULL;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(2025,1,'2024-10-01','2025-04-30'),(2026,1,'2025-10-01','2026-04-30')`)
  for (const pick of picks.filter(pick => pick.personId)) {
    assert.deepEqual(await resolveCdnPlayers([{ personId: pick.personId!, displayName: pick.identities![0].name }]), [byPick.get(pick.pick)])
  }
  const rookie = picks.find(pick => pick.pick === 8)!
  const played = rookie.games!.filter(game => game.played === '1')
  const late = played.findIndex(game => game.date >= '2026-01-20')
  const worlds = [
    { name: 'rookie', id: byPick.get(8)!, personId: rookie.personId!, identity: rookie.identities![0], year: 2026,
      samples: [played[0], played[1], played[2], played[late], played[late + 1]].map(game => ({ ...game, points: game.stats.points })) },
    { name: 'nba-2025', id: (await resolveCdnPlayers([{ personId: lukaGames[0].personId, displayName: lukaGames[0].identity.name }]))[0],
      personId: lukaGames[0].personId, identity: lukaGames[0].identity, year: 2025, samples: lukaGames.map(game => ({ ...game, points: game.statistics.points })) },
    { name: 'nba-2026', id: (await resolveCdnPlayers([{ personId: harden.personId, displayName: harden.identity.name }]))[0],
      personId: harden.personId, identity: harden.identity, year: 2026, samples: harden.games.map(game => ({ ...game, points: game.statistics.points })) },
  ]
  for (const world of worlds) {
    const league = crypto.randomUUID(), season = crypto.randomUUID(), counter = crypto.randomUUID()
    const member = [crypto.randomUUID(), crypto.randomUUID()]
    const account = [crypto.randomUUID(), crypto.randomUUID()]
    leagues.push(league); users.push(...account)
    const sample = world.samples
    assert.equal(sample.length, 5)
    await sql(`BEGIN;
      ${account.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
        VALUES(${q(user)},'authenticated','authenticated',${q(user + '@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')}
      INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,scoring_settings,trade_veto_mode,waiver_mode,playoff_start_week)
      VALUES(${q(league)},'Synthetic identity ownership',${q(league)},${q(account[0])},'active',15,'{"points":1}','disabled','rolling',30);
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},${world.year},true);
      ${member.map((id, i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(id)},${q(league)},${q(account[i])},'${i ? 'manager' : 'commissioner'}','Team ${i}');`).join('\n')}
      INSERT INTO players(id,first_name,last_name,position,eligible_positions) VALUES(${q(counter)},'Synthetic',${q(counter)},'SF',ARRAY['SF']);
      UPDATE players SET position='SF',eligible_positions=ARRAY['SF'],nba_team=${q(sample[0].team)} WHERE id=${q(world.id)};
      INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${q(league)},'UTIL',15) ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=15;
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      VALUES(${q(league)},${q(season)},${q(member[0])},${q(world.id)},'draft',${q(dayBefore(sample[0].date))}),
        (${q(league)},${q(season)},${q(member[1])},${q(counter)},'draft',${q(dayBefore(sample[0].date))});
      INSERT INTO roster_transactions(league_id,league_season_id,member_id,player_id,transaction_type,occurred_at)
      VALUES(${q(league)},${q(season)},${q(member[0])},${q(world.id)},'draft_won',${q(dayBefore(sample[0].date))}),
        (${q(league)},${q(season)},${q(member[1])},${q(counter)},'draft_won',${q(dayBefore(sample[0].date))});
      INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority)
      VALUES(${q(league)},${q(season)},${q(member[0])},1),(${q(league)},${q(season)},${q(member[1])},2);
      INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type)
      VALUES(${q(league)},${q(season)},1,${q(member[0])},${q(member[1])},'regular_season'); COMMIT`)
    const score = async (expected: number[], stage: string) => {
      const actual = await calcWeekPointsByMember(member, season, world.year, 1, { points: 1 }, world.year === 2025 ? '2024-10-01' : '2025-10-01', `${world.year}-04-30`)
      assert.deepEqual(member.map(id => actual.get(id)), expected, `${world.name} ${stage}`)
    }
    for (const [index, game] of sample.entries()) {
      const resolved = await resolveCdnPlayers([{ personId: world.personId, displayName: world.identity.name }])
      assert.deepEqual(resolved, [world.id], `${world.name}: NBA team change forks identity`)
      const gameId = await ensureGame(game.gameId, world.year)
      const owner = index === 3 ? 1 : 0
      if (index === 3) {
        await sql(`DO $$ DECLARE trade uuid; BEGIN
          trade:=propose_trade_atomic(${q(league)},${q(season)},${q(member[0])},${q(member[1])},ARRAY[${q(world.id)}]::uuid[],ARRAY[${q(counter)}]::uuid[],ARRAY[]::uuid[],ARRAY[]::uuid[]);
          PERFORM accept_trade_atomic(trade,${q(member[1])});
          IF (SELECT status FROM trades WHERE id=trade) <> 'completed' THEN RAISE EXCEPTION 'Fantasy trade does not complete'; END IF;
        END $$;
        UPDATE roster_transactions SET occurred_at=${q(dayBefore(game.date))} WHERE league_id=${q(league)} AND transaction_type IN ('trade_in','trade_out');
        UPDATE roster_players SET acquired_at=${q(dayBefore(game.date))} WHERE league_id=${q(league)}`)
      }
      if (index === 4) {
        await sql(`BEGIN; SELECT set_config('request.jwt.claim.sub',${q(account[1])},true);
          SELECT drop_player_atomic((SELECT id FROM roster_players WHERE league_id=${q(league)} AND player_id=${q(world.id)}));
          UPDATE waiver_wire_log SET placed_on_waivers_at=now()-interval '49 hours',clears_at=now()-interval '1 hour' WHERE league_id=${q(league)} AND player_id=${q(world.id)} AND cleared_at IS NULL;
          SELECT create_waiver_claim_atomic(${q(league)},${q(member[0])},${q(world.id)},NULL,${q(account[0])});
          UPDATE waiver_claims SET process_date=(now() AT TIME ZONE 'America/New_York')::date WHERE league_id=${q(league)};
          SELECT * FROM process_due_waiver_claims_atomic((now() AT TIME ZONE 'America/New_York')::date,10);
          UPDATE roster_transactions SET occurred_at=${q(dayBefore(game.date))} WHERE league_id=${q(league)} AND transaction_type IN ('fa_drop','waiver_add');
          UPDATE roster_players SET acquired_at=${q(dayBefore(game.date))} WHERE league_id=${q(league)} AND player_id=${q(world.id)}; COMMIT`)
        await check(`EXISTS(SELECT FROM waiver_claims WHERE league_id=${q(league)} AND player_id=${q(world.id)} AND status='succeeded')`, await sql(`SELECT coalesce(jsonb_agg(to_jsonb(w)),'[]') FROM waiver_claims w WHERE league_id=${q(league)}`))
      }
      await check(`EXISTS(SELECT FROM roster_players WHERE league_id=${q(league)} AND player_id=${q(world.id)} AND member_id=${q(member[owner])})`, `${world.name}: ownership lost`)
      await sql(`INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
        VALUES(${q(world.id)},${q(gameId)},${world.year},1,${game.points},false)
        ON CONFLICT(player_id,game_id) DO UPDATE SET points=EXCLUDED.points;
        INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type)
        VALUES(${q(league)},${q(season)},${q(member[owner])},${q(world.id)},${q(game.date)},1,'${index === 2 ? 'BE' : 'UTIL'}')`)
      const totalA = sample.slice(0, Math.min(index + 1, 2)).reduce((sum, entry) => sum + entry.points, 0) + (index === 4 ? sample[4].points : 0)
      await score([totalA, index >= 3 ? sample[3].points : 0], `game ${index}`)
    }
    const expected = [sample[0].points + sample[1].points + sample[4].points, sample[3].points]
    await syncScores(league, new Date(`${world.year}-05-06T16:00:00Z`), { recoverStats: false })
    const weekly = JSON.parse(await sql(`SELECT jsonb_build_object('home',home_points,'away',away_points,'final',is_finalized) FROM matchups WHERE league_id=${q(league)}`))
    assert.deepEqual(weekly, { home: expected[0], away: expected[1], final: true })
    const rolled = JSON.parse(await sql(`UPDATE leagues SET status='archived' WHERE id=${q(league)}; SELECT row_to_json(s) FROM advance_season_atomic(${q(league)}) s`))
    await check(`EXISTS(SELECT FROM roster_players WHERE league_id=${q(league)} AND league_season_id=${q(rolled.new_season_id)} AND player_id=${q(world.id)} AND member_id=${q(member[0])})`, 'Rollover loses the canonical player')
    if (world.name === 'rookie') await check(`EXISTS(SELECT FROM players WHERE id=${q(world.id)} AND nba_draft_number=8)`, 'Rollover loses draft number')
    results.push({ scenario: world.name, playerId: world.id, teams: [...new Set(sample.map(game => game.team))], games: sample.map(game => game.gameId), weekly, expected, fantasyTrade: true, waiverReadd: true, rollover: true })
  }
  const existingGames: { id: string; nba_game_id: string }[] = JSON.parse(await sql("SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'nba_game_id',nba_game_id)),'[]') FROM nba_games"))
  const gameIds = new Map(existingGames.map(game => [game.nba_game_id, game.id]))
  const additions = seasonGames.filter(game => !gameIds.has(game.gameId)).map(game => ({ ...game, id: crypto.randomUUID() }))
  for (const game of additions) { gameIds.set(game.gameId, game.id); ownedGames.push(game.id) }
  if (additions.length) await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,stats_synced_at)
    SELECT (r->>'id')::uuid,r->>'gameId',2026,1,(r->>'date')::date,(r->>'time')::timestamptz,r->>'home',r->>'away','Final',now()
    FROM jsonb_array_elements(${q(JSON.stringify(additions))}::jsonb) r`)
  const rows = picks.filter(pick => pick.personId).flatMap(pick => pick.games!.map(game => ({
    player: byPick.get(pick.pick)!, game: gameIds.get(game.gameId)!, played: game.played === '1', ...game.stats,
  })))
  for (let start = 0; start < rows.length; start += 500) await sql(`INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,did_not_play,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made)
    SELECT (r->>'player')::uuid,(r->>'game')::uuid,2026,1,NOT (r->>'played')::boolean,(r->>'points')::int,(r->>'reboundsTotal')::int,
      (r->>'assists')::int,(r->>'steals')::int,(r->>'blocks')::int,(r->>'turnovers')::int,(r->>'threePointersMade')::int
    FROM jsonb_array_elements(${q(JSON.stringify(rows.slice(start, start + 500)))}::jsonb) r
    ON CONFLICT(player_id,game_id) DO UPDATE SET did_not_play=EXCLUDED.did_not_play,points=EXCLUDED.points,
      rebounds=EXCLUDED.rebounds,assists=EXCLUDED.assists,steals=EXCLUDED.steals,blocks=EXCLUDED.blocks,turnovers=EXCLUDED.turnovers,three_pointers_made=EXCLUDED.three_pointers_made`)
  const actualRows: { player: string; game: string; points: number; reboundsTotal: number; assists: number; played: boolean }[] = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('player',player_id,'game',game_id,'points',points,'reboundsTotal',rebounds,'assists',assists,'played',NOT did_not_play) ORDER BY player_id,game_id)
    FROM player_game_stats WHERE player_id IN (${set([...byPick.values()])})`))
  const rowKey = (row: { player: string; game: string }) => `${row.player}|${row.game}`
  const expectedRows = rows.map(row => ({ player: row.player, game: row.game, points: row.points, reboundsTotal: row.reboundsTotal, assists: row.assists, played: row.played }))
    .sort((a, b) => rowKey(a).localeCompare(rowKey(b)))
  assert.deepEqual(actualRows, expectedRows, 'A real rookie game is missing, duplicated, changed, or linked to the wrong row')
  const totalLeague = crypto.randomUUID(), totalSeason = crypto.randomUUID()
  const totalAccounts = Array.from({ length: 4 }, () => crypto.randomUUID())
  const totalMembers: string[] = totalAccounts.map(() => crypto.randomUUID())
  leagues.push(totalLeague); users.push(...totalAccounts)
  const expectedPoints = [0, 0, 0, 0]
  await sql(`BEGIN;
    ${totalAccounts.map(user => `INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES(${q(user)},'authenticated','authenticated',${q(user + '@example.test')},'x',now(),'{}','{}',now(),now());`).join('\n')}
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,scoring_settings,playoff_start_week)
    VALUES(${q(totalLeague)},'Synthetic all-rookie scoring',${q(totalLeague)},${q(totalAccounts[0])},'active',15,'{"points":1}',30);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(totalSeason)},${q(totalLeague)},2026,true);
    ${totalMembers.map((id, i) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(id)},${q(totalLeague)},${q(totalAccounts[i])},'${i ? 'manager' : 'commissioner'}','Team ${i}');`).join('\n')}
    INSERT INTO lineup_slot_templates(league_id,slot_type,slot_count) VALUES(${q(totalLeague)},'UTIL',15)
      ON CONFLICT(league_id,slot_type) DO UPDATE SET slot_count=15;
    ${picks.map((pick, i) => `INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via,acquired_at)
      VALUES(${q(totalLeague)},${q(totalSeason)},${q(totalMembers[i % 4])},${q(byPick.get(pick.pick)!)},'draft','2025-10-01T00:00:00Z');`).join('\n')}
    INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type)
    SELECT DISTINCT ${q(totalLeague)}::uuid,${q(totalSeason)}::uuid,roster.member_id,stats.player_id,stats.game_date,1,'UTIL'::roster_slot_type
    FROM player_game_stats stats JOIN roster_players roster ON roster.player_id=stats.player_id
    WHERE roster.league_id=${q(totalLeague)} AND stats.season_year=2026;
    INSERT INTO matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,matchup_type)
    VALUES(${q(totalLeague)},${q(totalSeason)},1,${q(totalMembers[0])},${q(totalMembers[1])},'regular_season'),
      (${q(totalLeague)},${q(totalSeason)},1,${q(totalMembers[2])},${q(totalMembers[3])},'regular_season'); COMMIT`)
  picks.forEach((pick, i) => { expectedPoints[i % 4] += pick.games?.reduce((sum, game) => sum + game.stats.points, 0) ?? 0 })
  const liveTotals = await calcWeekPointsByMember(totalMembers, totalSeason, 2026, 1, { points: 1 }, '2025-10-01', '2026-04-30')
  assert.deepEqual(totalMembers.map(id => liveTotals.get(id)), expectedPoints, 'A real rookie game does not score for its owner')
  await syncScores(totalLeague, new Date('2026-05-06T16:00:00Z'), { recoverStats: false })
  const published: { home_member_id: string; away_member_id: string; home_points: number; away_points: number; is_finalized: boolean }[] = JSON.parse(await sql(`SELECT jsonb_agg(to_jsonb(m)) FROM matchups m WHERE league_id=${q(totalLeague)}`))
  for (const matchup of published) {
    assert.equal(matchup.home_points, expectedPoints[totalMembers.indexOf(matchup.home_member_id)])
    assert.equal(matchup.away_points, expectedPoints[totalMembers.indexOf(matchup.away_member_id)])
    assert.equal(matchup.is_finalized, true)
  }
  results.push({ scenario: 'all-rookie-owner-scoring', live: expectedPoints, finalizedMatchups: published.length, unscoredGames: 0 })
  const totals: { id: string; games: number; played: number; points: number; rebounds: number; assists: number }[] = JSON.parse(await sql(`SELECT jsonb_agg(to_jsonb(t)) FROM (
    SELECT player_id AS id,count(*)::int AS games,count(*) FILTER (WHERE NOT did_not_play)::int AS played,
      sum(points)::int AS points,sum(rebounds)::int AS rebounds,sum(assists)::int AS assists
    FROM player_game_stats WHERE player_id IN (${set([...byPick.values()])}) GROUP BY player_id) t`))
  const evidence = ['pick\tname\tplayer_id\tgames\tplayed\tpoints\trebounds\tassists']
  for (const pick of picks.filter(pick => pick.personId)) {
    const actual = totals.find(row => row.id === byPick.get(pick.pick))!
    assert.ok(actual, `Missing season totals for ${pick.name}`)
    const expected = { id: byPick.get(pick.pick)!, games: pick.games!.length, played: pick.games!.filter(game => game.played === '1').length,
      points: pick.games!.reduce((sum, game) => sum + game.stats.points, 0), rebounds: pick.games!.reduce((sum, game) => sum + game.stats.reboundsTotal, 0),
      assists: pick.games!.reduce((sum, game) => sum + game.stats.assists, 0) }
    assert.deepEqual(actual, expected, `Season totals lose a game for ${pick.name}`)
    evidence.push([pick.pick, pick.name, actual.id, actual.games, actual.played, actual.points, actual.rebounds, actual.assists].join('\t'))
  }
  await Deno.mkdir('evidence', { recursive: true })
  await Deno.writeTextFile('evidence/rookie-season-totals.tsv', evidence.join('\n') + '\n')
  for (const pick of picks.filter(pick => pick.games?.some(game => game.played === '1'))) {
    assert.equal(Number(await sql(`SELECT games_played FROM mv_player_season_averages WHERE player_id=${q(byPick.get(pick.pick)!)} AND season_year=2026`)), pick.games!.filter(game => game.played === '1').length)
  }
  results.push({ scenario: 'all-rookie-season-totals', identities: totals.length, rawRows: rows.length,
    playedGames: rows.filter(row => row.played).length, missingGames: 0, averagesCanonical: true })
  await check(`(SELECT count(*) FROM dynasty_rankings WHERE source=${q(source)} AND player_id IS NOT NULL)=59`, 'First box link loses a ranking row')
  await check(`(SELECT count(*) FROM fantasypros_projection_rows WHERE run_id=${q(run)} AND player_id IS NOT NULL)=59`, 'First box link loses a projection row')
  console.log(JSON.stringify({ provenance: 'REAL-DERIVED', fixtureState: 'SYNTHETIC leagues, one long test week, historical acquisition clocks, counterplayers and support rows', results }))
} finally {
  playerIds = JSON.parse(await sql("SELECT coalesce(jsonb_agg(id),'[]') FROM players"))
  await sql(`BEGIN;
    ${leagues.length ? `DELETE FROM roster_transactions WHERE league_id IN (${set(leagues)}); DELETE FROM trade_items WHERE trade_id IN (SELECT id FROM trades WHERE league_id IN (${set(leagues)})); DELETE FROM draft_picks WHERE league_id IN (${set(leagues)}); DELETE FROM leagues WHERE id IN (${set(leagues)});` : ''}
    DELETE FROM dynasty_rankings WHERE source=${q(source)}; DELETE FROM projection_sync_runs WHERE id=${q(run)};
    ${ownedGames.length ? `DELETE FROM player_game_stats WHERE game_id IN (${set(ownedGames)}); DELETE FROM nba_games WHERE id IN (${set(ownedGames)});` : ''}
    ${playerIds.length ? `DELETE FROM players WHERE id IN (${set(playerIds)});` : ''}
    DELETE FROM season_weeks WHERE season_year IN (2025,2026);
    ${users.length ? `DELETE FROM auth.users WHERE id IN (${set(users)});` : ''} COMMIT`)
}
