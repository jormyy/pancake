import assert from 'node:assert/strict'
import { createWorld, handler, ids, q, rows, sql, type RookieGame } from './identity-rank-projection-fixture.ts'

const world = await createWorld()
const played = world.picks.filter(pick => pick.games?.some(game => game.played === '1'))
const fields = { projected_stat_points: 'points', projected_rebounds: 'reboundsTotal', projected_assists: 'assists',
  projected_steals: 'steals', projected_blocks: 'blocks', projected_turnovers: 'turnovers', projected_three_pointers_made: 'threePointersMade' } as const
type Projection = { player_id: string; fetched_at: string } & Record<keyof typeof fields, number>
const average = (games: RookieGame[], key: keyof RookieGame['stats']) => Number((games.reduce((sum, game) => sum + game.stats[key], 0) / games.length).toFixed(2))
const evidence: unknown[] = []
try {
  assert.equal(played.length, 55)
  await world.store(false)
  const control = crypto.randomUUID()
  world.owned.add(control)
  await sql(`INSERT INTO players(id,first_name,last_name) VALUES(${q(control)},'Synthetic','Window control')`)
  for (const [index, week, date, provider, points, dnp] of [
    [0,1,'2025-09-20','0029998000',900,false], [1,2,'2025-09-25','0029998001',10,false],
    [2,5,'2026-04-10','0029998002',20,false], [3,5,'2026-04-11','0029998003',900,true],
    [4,6,'2026-04-14','0029998004',900,false], [5,5,'2026-04-11','0069998005',900,false],
  ] as const) {
    const game = crypto.randomUUID()
    world.gameIds.set(`control-${index}`, game)
    await sql(`INSERT INTO nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(${q(game)},${q(provider)},2026,${week},${q(date)},'SYNTHETIC-A','SYNTHETIC-B','Final');
      INSERT INTO player_game_stats(player_id,game_id,season_year,week_number,points,did_not_play)
      VALUES(${q(control)},${q(game)},2026,${week},${points},${dnp})`)
  }
  const run = await handler(new URL('../../functions/sync-projections/index.ts', import.meta.url).href)
  const check = async (phase: string, all: boolean) => {
    const receipt = await run()
    assert.equal(receipt.internalFallback, played.length + 1)
    assert.deepEqual(receipt.fantasypros.map((source: { status: string }) => source.status), ['failed', 'failed', 'failed'])
    const runs = await rows<{ status: string; http_status: number; error_message: string; projection_type: string; season_year: number; week_number: number }>('SELECT status,http_status,error_message,projection_type,season_year,week_number FROM projection_sync_runs')
    assert.equal(runs.length, (evidence.length + 1) * 3)
    assert.ok(runs.every(row => row.status === 'failed' && row.http_status === 403 && row.error_message.includes('HTTP 403') && row.season_year === 2026 && row.week_number === 5))
    for (const type of ['daily', 'weekly_avg', 'weekly_total']) assert.equal(runs.filter(row => row.projection_type === type).length, evidence.length + 1)
    const actual = await rows<Projection>(`SELECT * FROM player_projections WHERE season_year=2026 AND week_number=5 AND player_id IN (${ids(world.byPick.values())})`)
    assert.equal(actual.length, played.length)
    const requested = played.map(pick => world.byPick.get(pick.pick)!)
    const surface = await rows<{ player_id: string; projection_source: string; projection_points: number; projection_fantasy_points: number }>(
      `SELECT * FROM get_league_projection_rows(${q(world.league)},2026,(now() AT TIME ZONE 'America/New_York')::date,'today',ARRAY[${ids(requested)}]::uuid[])`)
    const forecast = await world.forecast<{ player_id: string; projection_source: string; projection_fantasy_points: number }>(requested)
    assert.equal(surface.length, played.length)
    assert.equal(forecast.length, played.length)
    assert.equal(new Set(surface.map(row => row.player_id)).size, played.length)
    assert.equal(new Set(forecast.map(row => row.player_id)).size, played.length)
    for (const pick of played) {
      const id = world.byPick.get(pick.pick)!, games = pick.games!.filter(game => game.played === '1')
      const sample = all ? games : games.slice(0, 1)
      const row = actual.find(row => row.player_id === id)!
      assert.ok(row, `${phase}: missing ${pick.name}`)
      for (const [column, stat] of Object.entries(fields)) assert.equal(row[column as keyof typeof fields], average(sample, stat), `${phase}: ${pick.name} ${column}`)
      const projection = surface.find(row => row.player_id === id)!, input = forecast.find(row => row.player_id === id)!
      assert.equal(projection.projection_source, 'internal')
      assert.equal(projection.projection_points, average(sample, 'points'))
      assert.equal(projection.projection_fantasy_points, average(sample, 'points'))
      assert.equal(input.projection_source, 'internal')
      assert.equal(input.projection_fantasy_points, average(sample, 'points'))
    }
    assert.equal(Number(await sql(`SELECT projected_stat_points FROM player_projections WHERE player_id=${q(control)} AND week_number=5`)), 15, 'The four-week window includes its lower bound and excludes older, future, Cup and DNP rows')
    evidence.push({ phase, played: played.length, drafts: world.picks.length, failedFantasyProsRuns: runs.length, canonicalProjectionRows: actual.length })
    return actual
  }
  const before = await check('before-nba-link', false)
  await world.link()
  await check('after-nba-link', false)
  await world.store(true)
  await world.advance()
  const after = await check('after-more-real-games', true)
  let changed = 0
  for (const row of after) {
    const prior = before.find(prior => prior.player_id === row.player_id)!
    assert.notEqual(row.fetched_at, prior.fetched_at)
    if (Object.keys(fields).some(key => row[key as keyof typeof fields] !== prior[key as keyof typeof fields])) changed++
  }
  assert.ok(changed > 0)
  const { loser, winner } = await world.merge()
  assert.equal(await sql(`SELECT count(*) FROM player_projections WHERE player_id=${q(loser)}`), '0')
  assert.equal(await sql(`SELECT count(*) FROM player_projections WHERE player_id=${q(winner)} AND week_number=5`), '1', 'Internal projection must move during merge before another handler run')
  const merged = await rows<Projection>(`SELECT * FROM player_projections WHERE player_id=${q(winner)} AND week_number=5`)
  const prior = after.find(row => row.player_id === loser)!
  for (const field of Object.keys(fields)) assert.equal(merged[0][field as keyof typeof fields], prior[field as keyof typeof fields])
  const surface = await rows<{ player_id: string; projection_source: string; projection_points: number }>(`SELECT * FROM get_league_projection_rows(${q(world.league)},2026,'2026-04-13','today',ARRAY[${ids(played.map(pick => world.byPick.get(pick.pick)!))}]::uuid[])`)
  const forecast = await world.forecast<{ player_id: string; projection_source: string; projection_fantasy_points: number }>(played.map(pick => world.byPick.get(pick.pick)!))
  assert.equal(surface.length, played.length)
  assert.equal(forecast.length, played.length)
  const expectedIds = played.map(pick => world.byPick.get(pick.pick)!).sort()
  assert.deepEqual(surface.map(row => row.player_id).sort(), expectedIds)
  assert.deepEqual(forecast.map(row => row.player_id).sort(), expectedIds)
  assert.equal(surface.find(row => row.player_id === winner)?.projection_points, prior.projected_stat_points)
  assert.equal(forecast.find(row => row.player_id === winner)?.projection_fantasy_points, prior.projected_stat_points)
  assert.ok(!surface.some(row => row.player_id === loser) && !forecast.some(row => row.player_id === loser))
  console.log(JSON.stringify({ provenance: 'REAL-DERIVED rookie boxes; SYNTHETIC calendar, clock, league and boundary controls', evidence, changed,
    failedFetches: world.failures.length, merge: { loser, winner }, excluded: world.picks.filter(pick => !played.includes(pick)).map(pick => pick.name) }))
} finally { await world.cleanup() }
