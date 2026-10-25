import assert from 'node:assert/strict'
import { virtualDate } from '../../../scripts/season-sim/virtual-clock.mjs'

export type RookieGame = {
  gameId: string; date: string; team: string; played: string
  stats: { points: number; reboundsTotal: number; assists: number; steals: number; blocks: number; turnovers: number; threePointersMade: number }
}
type Rookie = {
  pick: number; name: string; personId?: string
  identities?: { name: string; firstName: string; familyName: string }[]; games?: RookieGame[]
}
const api = Deno.env.get('SUPABASE_URL')!
const db = Deno.env.get('SUPABASE_DB_URL')!
for (const [value, port] of [[api, Deno.env.get('PANCAKE_TEST_API_PORT') ?? '54321'], [db, Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322']]) {
  const url = new URL(value)
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === port, `Only the expected loopback port ${port} is allowed`)
}
const admin = new URL(db)
admin.username = 'supabase_admin'
export const q = (value: string) => `'${value.replaceAll("'", "''")}'`
export const ids = (values: Iterable<string>) => [...values].map(q).join(',')
export async function sql(statement: string): Promise<string> {
  const child = new Deno.Command('psql', { args: [admin.href, '-XqAt', '-v', 'ON_ERROR_STOP=1'], stdin: 'piped', stdout: 'piped', stderr: 'piped' }).spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(statement))
  await writer.close()
  const result = await child.output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
export async function rows<T>(statement: string): Promise<T[]> {
  return JSON.parse(await sql(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]') FROM (${statement}) t`))
}
async function fixture<T>(name: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(new URL(`../../../tests/fixtures/identity/${name}`, import.meta.url)))
}

export async function createWorld() {
  assert.equal(await sql('SELECT count(*) FROM players'), '0', 'Use an empty isolated identity stack')
  assert.equal(await sql('SELECT count(*) FROM nba_games'), '0', 'Use an empty isolated game table')
  assert.equal(await sql('SELECT count(*) FROM dynasty_rankings'), '0', 'Use empty isolated rankings')
  assert.equal(await sql('SELECT count(*) FROM projection_sync_runs'), '0', 'Use empty isolated projection runs')
  const { picks, provenance } = await fixture<{ provenance: string; picks: Rookie[] }>('rookies-2025.json')
  const { games, provenance: gameProvenance } = await fixture<{ provenance: string; games: { gameId: string; date: string; home: string; away: string; time: string }[] }>('games-2025.json')
  assert.equal(provenance, 'REAL-DERIVED')
  assert.equal(gameProvenance, 'REAL-DERIVED')
  const league = crypto.randomUUID(), member = crypto.randomUUID(), user = crypto.randomUUID(), season = crypto.randomUUID()
  const nativeDate = Date, nativeFetch = globalThis.fetch
  const cron = await sql("SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY jobid), '[]') FROM cron.job j")
  const calendar = await sql("SELECT coalesce(jsonb_agg(to_jsonb(w)), '[]') FROM season_weeks w WHERE season_year=2026")
  let clock = { simMs: Date.parse('2026-04-12T12:00:00Z'), realMs: Date.now(), rate: 0 }
  const clockSource = await Deno.readTextFile('scripts/season-sim/clock.sql')
  await sql(clockSource.slice(clockSource.indexOf('BEGIN;')).replaceAll(":'sim_ms'", String(clock.simMs))
    .replaceAll(":'real_ms'", String(clock.realMs)).replaceAll(":'rate'", '0').replaceAll(":'cap_ms'", 'NULL'))
  globalThis.Date = virtualDate(nativeDate, () => clock)
  const byPick = new Map<number, string>(), owned = new Set<string>(), gameIds = new Map<string, string>()
  const origins = new Set([new URL(api).origin])
  const failures: string[] = []
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.hostname === 'www.fantasypros.com') {
      failures.push(url.pathname)
      return Promise.resolve(new Response('SYNTHETIC local provider denial', { status: 403 }))
    }
    assert.ok(origins.has(url.origin), `External fetch blocked: ${url.origin}`)
    return nativeFetch(input, init)
  }
  const cleanup = async () => {
    globalThis.Date = nativeDate
    globalThis.fetch = nativeFetch
    try {
      await sql(`DELETE FROM leagues WHERE id=${q(league)};
        DELETE FROM auth.users WHERE id=${q(user)};
        DELETE FROM dynasty_rankings;
        DELETE FROM projection_sync_runs;
        ${owned.size ? `DELETE FROM player_projections WHERE player_id IN (${ids(owned)});
          DELETE FROM player_game_stats WHERE player_id IN (${ids(owned)});` : ''}
        ${owned.size ? `DELETE FROM players WHERE id IN (${ids(owned)});` : ''}
        ${gameIds.size ? `DELETE FROM nba_games WHERE id IN (${ids(gameIds.values())});` : ''}
        DELETE FROM season_weeks WHERE season_year=2026;
        INSERT INTO season_weeks SELECT * FROM jsonb_populate_recordset(NULL::season_weeks,${q(calendar)}::jsonb);`)
    } finally {
      const restore = await Deno.readTextFile('scripts/season-sim/restore-clock.sql')
      await sql(restore.slice(restore.indexOf('BEGIN;')))
      await sql(`INSERT INTO cron.job SELECT * FROM jsonb_populate_recordset(NULL::cron.job,${q(cron)}::jsonb)`)
      assert.equal(await sql("SELECT prosrc FROM pg_proc WHERE oid='pg_catalog.clock_timestamp()'::regprocedure"), 'clock_timestamp')
      assert.equal(await sql("SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY jobid), '[]') FROM cron.job j"), cron)
    }
  }
  try {
    await sql(`INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(${q(user)},${q(user + '@example.test')},jsonb_build_object('username',${q(user)}));
      INSERT INTO leagues(id,name,slug,commissioner_id,status,scoring_settings) VALUES(${q(league)},'Synthetic rookie rankings and projections',${q(league)},${q(user)},'active','{"points":1}');
      INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${q(member)},${q(league)},${q(user)},'commissioner','Rookies');
      INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${q(season)},${q(league)},2026,true);
      DELETE FROM season_weeks WHERE season_year=2026;
      INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES
        (2026,1,'2025-09-15','2025-09-21'),(2026,2,'2025-09-22','2025-09-28'),
        (2026,3,'2025-09-29','2025-10-05'),(2026,4,'2025-10-06','2025-10-12'),
        (2026,5,'2025-10-13','2026-04-13'),(2026,6,'2026-04-14','2026-04-20');`)
    const { resolvePlayerImports } = await import('../../functions/_shared/playerImports.ts')
    const board = await resolvePlayerImports('nba_draft', picks.map(pick => ({ display_name: pick.name, nba_draft_number: pick.pick })))
    assert.equal(board.results.length, 59)
    board.results.forEach((row, index) => {
      assert.ok(row.player_id && ['inserted', 'updated'].includes(row.action))
      byPick.set(picks[index].pick, row.player_id)
      owned.add(row.player_id)
    })
    const store = async (all: boolean) => {
      const selected = picks.flatMap(pick => (all ? pick.games ?? [] : (pick.games ?? []).filter(game => game.played === '1').slice(0, 1))
        .map(game => ({ pick: pick.pick, ...game })))
      for (const game of selected) {
        if (gameIds.has(game.gameId)) continue
        const source = games.find(row => row.gameId === game.gameId)!
        assert.ok(source, game.gameId)
        const id = crypto.randomUUID()
        gameIds.set(game.gameId, id)
        await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
          VALUES(${q(id)},${q(source.gameId)},2026,5,${q(source.date)},${q(source.time)},${q(source.home)},${q(source.away)},'Final')`)
      }
      for (let start = 0; start < selected.length; start += 500) {
        const values = selected.slice(start, start + 500).map(game => `(${q(byPick.get(game.pick)!)},${q(gameIds.get(game.gameId)!)},2026,5,${game.played !== '1'},${game.stats.points},${game.stats.reboundsTotal},${game.stats.assists},${game.stats.steals},${game.stats.blocks},${game.stats.turnovers},${game.stats.threePointersMade})`)
        await sql(`INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,did_not_play,points,rebounds,assists,steals,blocks,turnovers,three_pointers_made)
          VALUES ${values.join(',')} ON CONFLICT(player_id,game_id) DO NOTHING`)
      }
    }
    const link = async () => {
      const { resolveCdnPlayers } = await import('../../functions/_shared/playerResolver.ts')
      assert.equal(picks.filter(pick => pick.personId).length, 57)
      for (const pick of picks.filter(pick => pick.personId)) {
        assert.deepEqual(await resolveCdnPlayers([{ personId: pick.personId!, displayName: pick.identities![0].name }]), [byPick.get(pick.pick)])
      }
    }
    const merge = async () => {
      const pick = picks.find(pick => pick.pick === 8)!, loser = byPick.get(8)!, winner = crypto.randomUUID()
      owned.add(winner)
      await sql(`UPDATE players SET nba_id=NULL WHERE id=${q(loser)};
        INSERT INTO players(id,first_name,last_name,nba_id) VALUES(${q(winner)},${q(pick.identities![0].firstName)},${q(pick.identities![0].familyName)},${q(pick.personId!)});
        SELECT assign_player_nba_id_atomic(${q(loser)},${q(pick.personId!)});`)
      byPick.set(8, winner)
      assert.equal(await sql(`SELECT count(*) FROM players WHERE id=${q(loser)}`), '0')
      return { loser, winner }
    }
    const advance = async () => {
      clock = { ...clock, simMs: nativeDate.parse('2026-04-13T12:00:00Z') }
      await sql(`UPDATE season_sim.clock SET sim_ms=${clock.simMs} WHERE singleton`)
    }
    const forecast = async <T>(requested?: string[]): Promise<T[]> => JSON.parse(await sql(`BEGIN;
      SET LOCAL request.jwt.claim.sub=${q(user)};
      SELECT coalesce(jsonb_agg(to_jsonb(f)), '[]') FROM
        get_dynasty_forecast_inputs(${q(league)},${q(member)},2026,${requested ? `ARRAY[${ids(requested)}]::uuid[]` : 'NULL'}) f;
      ROLLBACK;`))
    return { picks, byPick, owned, gameIds, origins, failures, league, store, link, merge, advance, forecast, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

export async function handler(module: string) {
  const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
  let captured: ((req: Request) => Promise<Response>) | undefined
  Object.defineProperty(Deno, 'serve', { value: (fn: (req: Request) => Promise<Response>) => { captured = fn } })
  try { await import(module) } finally { Object.defineProperty(Deno, 'serve', descriptor) }
  assert.ok(captured)
  return async (body = {}) => {
    const response = await captured!(new Request(`${api}/functions/v1/identity-fixture`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-function-token': Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')! }, body: JSON.stringify(body) }))
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
}
