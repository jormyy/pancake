import { deepStrictEqual, equal, ok } from 'node:assert/strict'
import fixture from '../../../tests/fixtures/stats-certification/okc-dal.json' with { type: 'json' }
import { validateStatsCertificationFixture } from '../../../tests/db/stats-certification-backup.mjs'

const database = Deno.env.get('SUPABASE_DB_URL')
const databasePort = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '61022'
const apiPort = `${databasePort.slice(0, 3)}21`
const fixturePort = `${databasePort.slice(0, 3)}80`
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${apiPort}`)
Deno.env.set('PANCAKE_SUPABASE_SECRET_KEY', 'certification-fixture-test')
Deno.env.set('NBA_CDN_BASE_URL', `http://127.0.0.1:${fixturePort}`)
const { syncLiveStatsGames, buildStatRow } = await import('./syncStats.ts')
const quote = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`

async function sql(query: string): Promise<string> {
  const result = await new Deno.Command('psql', { args: [database!, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-c', query],
    stdout: 'piped', stderr: 'piped' }).output()
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}

Deno.test({ name: 'OKC at DAL certifies past the reconstructed Sorber inactive row', ignore: !database, fn: async () => {
  equal(new URL(database!).hostname, '127.0.0.1')
  equal(new URL(database!).port, databasePort)
  validateStatsCertificationFixture(fixture)
  const game = fixture.game
  equal(game.nba_game_id, '0022600142')
  equal(game.status, 'Scheduled')
  const sorber = fixture.players.find(player => player.first_name === 'Thomas' && player.last_name === 'Sorber')!
  ok(sorber)
  const names = new Set(['Shai Gilgeous-Alexander', 'Chet Holmgren', 'Jalen Williams', 'Isaiah Hartenstein',
    'Alex Caruso', 'Ajay Mitchell', 'Cason Wallace', 'Cooper Flagg', 'Kyrie Irving', 'P.J. Washington',
    'Daniel Gafford', 'Dereck Lively II', 'Naji Marshall', 'Max Christie'])
  const players = fixture.players.filter(player => names.has(`${player.first_name} ${player.last_name}`))
  equal(players.length, names.size)
  const statistics = { assists: 0, blocks: 0, fieldGoalsAttempted: 0, fieldGoalsMade: 0, foulsPersonal: 0,
    freeThrowsAttempted: 0, freeThrowsMade: 0, minutes: 'PT00M00.00S', plusMinusPoints: 0, points: 0,
    reboundsDefensive: 0, reboundsOffensive: 0, reboundsTotal: 0, steals: 0, threePointersAttempted: 0,
    threePointersMade: 0, turnovers: 0 }
  const finalPlayers = players.map(player => ({ ...player, personId: Number(player.nba_id),
    name: `${player.first_name} ${player.last_name}`, played: '1',
    statistics: { ...statistics, minutes: 'PT30M00.00S', points: 20, fieldGoalsMade: 10, fieldGoalsAttempted: 15 } }))
  const liveRows = finalPlayers.map(player => buildStatRow({ ...player, isHome: player.nba_team === 'DAL',
    statistics: { ...player.statistics, minutes: 'PT06M00.00S', points: 4, fieldGoalsMade: 2, fieldGoalsAttempted: 3 } },
  player.id, game.id, game.season_year, game.week_number))
  liveRows.push(buildStatRow({ personId: Number(sorber.nba_id), name: 'Thomas Sorber', played: '0', isHome: false, statistics },
    sorber.id, game.id, game.season_year, game.week_number))
  equal(await sql(`SELECT count(*) FROM public.nba_games WHERE id=${quote(game.id)}`), '0')
  equal(await sql(`SELECT count(*) FROM public.players WHERE id IN (${[...players, sorber].map(player => quote(player.id)).join(',')})`), '0')
  const originalFetch = globalThis.fetch
  try {
    await sql(`BEGIN;
      INSERT INTO public.players(id, nba_id, first_name, last_name, nba_team)
      SELECT id, nba_id, first_name, last_name, nba_team FROM jsonb_to_recordset(${quote(JSON.stringify([...players, sorber]))}::jsonb)
        AS p(id uuid, nba_id text, first_name text, last_name text, nba_team text);
      INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status, home_score, away_score)
      VALUES(${quote(game.id)}, ${quote(game.nba_game_id)}, ${game.season_year}, ${game.week_number},
        ${quote(game.game_date)}, 'DAL', 'OKC', 'InProgress', 28, 28);
      SELECT public.save_live_game_stats_atomic(${quote(game.id)}, ${quote(game.nba_game_id)}, ${quote(JSON.stringify(liveRows))}::jsonb, 360);
      COMMIT;`)
    equal(await sql(`SELECT count(*) FROM public.player_game_stats WHERE game_id=${quote(game.id)}`), '15')
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      equal(url.hostname, '127.0.0.1')
      if (url.port === fixturePort) return Response.json({ meta: { time: '2026-10-29T04:30:00Z' }, game: {
        gameStatus: 3, gameStatusText: 'Final',
        homeTeam: { score: 140, players: finalPlayers.filter(player => player.nba_team === 'DAL') },
        awayTeam: { score: 140, players: finalPlayers.filter(player => player.nba_team === 'OKC') },
      } })
      equal(url.port, apiPort)
      const body = await request.json()
      const name = url.pathname.split('/').at(-1)
      if (name === 'assert_nba_game_unambiguous') {
        await sql(`SELECT public.assert_nba_game_unambiguous(${quote(body.p_game_id)})`)
        return Response.json(null)
      }
      if (name === 'resolve_player_imports_atomic') return Response.json({
        results: body.p_records.map((record: { provider_id: string }, index: number) => ({
          index, player_id: players.find(player => player.nba_id === record.provider_id)!.id, action: 'updated',
        })), stale_draft_numbers_cleared: 0,
      })
      equal(name, 'save_final_game_snapshot_atomic')
      const count = await sql(`SELECT public.save_final_game_snapshot_atomic(${quote(body.p_game_id)},
        ${quote(body.p_provider_game_id)}, ${quote(JSON.stringify(body.p_stats))}::jsonb,
        ${quote(body.p_source_updated_at)}, ${body.p_home_score}, ${body.p_away_score}, ${quote(body.p_status_text)})`)
      return Response.json(Number(count))
    }
    const result = await syncLiveStatsGames([{ ...game, status: 'Final' }])
    deepStrictEqual(result.failures, [])
    equal(result.statLines, 14)
    equal(await sql(`SELECT count(*) FROM public.player_game_stats WHERE game_id=${quote(game.id)}`), '14')
    equal(await sql(`SELECT bool_and(points=20 AND minutes_played=30) FROM public.player_game_stats WHERE game_id=${quote(game.id)}`), 't')
    equal(await sql(`SELECT status='Final' AND stats_synced_at IS NOT NULL AND home_score=140 AND away_score=140
      FROM public.nba_games WHERE id=${quote(game.id)}`), 't')
    equal(await sql(`SELECT count(*) FROM public.sync_runs WHERE details->>'game_id'=${quote(game.id)}
      AND rows_affected=1 AND details->'removed_inactive_rows'->0->>'player_id'=${quote(sorber.id)}`), '1')
    equal(await sql(`SELECT count(*) FROM private.game_stat_revisions WHERE game_id=${quote(game.id)}`), '1')
  } finally {
    globalThis.fetch = originalFetch
    await sql(`BEGIN;
      DELETE FROM public.player_game_stats WHERE game_id=${quote(game.id)};
      DELETE FROM private.game_stat_revisions WHERE game_id=${quote(game.id)};
      DELETE FROM public.nba_games WHERE id=${quote(game.id)};
      DELETE FROM public.sync_runs WHERE details->>'game_id'=${quote(game.id)};
      DELETE FROM public.players WHERE id IN (${[...players, sorber].map(player => quote(player.id)).join(',')});
      COMMIT;`)
  }
} })
