import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, rows, sql, type League, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
type Match = { id: string; home_member_id: string; away_member_id: string; week_number: number }
const leagues: League[] = []
const regular = new Map<string, Match[]>()
async function finalize(league: League, week: number, games: Match[]) {
  const token = JSON.parse(await sql(`SELECT capture_score_inputs(${q(league.season)},${week})`))
  const payload = games.map((game, index) => ({ id: game.id, input_token: token, winner_member_id: game.home_member_id, home_points: 100 - index * 10, away_points: 99 - index * 10, home_max_possible_points: 105 - index * 10, away_max_possible_points: 104 - index * 10 }))
  const standings = week === 1 ? league.members.map((member, index) => ({ member_id: member, wins: index % 2 ? 0 : 1, losses: index % 2 ? 1 : 0, ties: 0, points_for: 100 - index, points_against: 90 - index, max_possible_points: 105 - index, waiver_priority: index + 1, created_at: '2026-10-25T16:00:00Z' })) : []
  await sql(`SELECT finalize_score_week_atomic(${q(league.id)},${q(league.season)},${week},${q(JSON.stringify(payload))}::jsonb,${q(JSON.stringify(standings))}::jsonb)`)
}
try {
  await clock.start('2026-10-20T16:00:00Z')
  await fixture.init()
  await transport.start()
  for (let rotation = 0; rotation < 4; rotation++) leagues.push(await fixture.league('active', rotation, true, 2))
  for (const value of [true, false]) {
  const settings: OutboxRow[] = []
  for (const league of leagues) {
    const before = (await rows('league_settings_changed', `data->>'leagueId'=${q(league.id)}`)).map(row => row.id)
    const update = () => sql(`SELECT set_config('request.jwt.claim.sub',${q(fixture.memberUsers.get(league.members[0])!)},false); SELECT update_league_settings_atomic(${q(league.id)},'${JSON.stringify({ allow_inactive_trades: value })}')`)
    await update()
    settings.push(...await expectRows('league_settings_changed', `data->>'leagueId'=${q(league.id)}` + (before.length ? ` AND id NOT IN (${before.map(q)})` : ''), league.members, update))
  }
  await transport.prove(fixture, settings, 'supabase/tests/db/notif-t9-matchup-league.ts:27')
  }
  for (const league of leagues) {
    const date = await sql(`SELECT private.trade_deadline_for_season(trade_deadline,${league.year})-4 FROM leagues WHERE id=${q(league.id)}`)
    await clock.scan(date + ' 16:00:00+00')
    assert.equal((await rows('trade_deadline_approaching', `data->>'leagueSeasonId'=${q(league.season)}`)).length, 0, 'No deadline warning before the three-day window')
    const inside = await sql(`SELECT private.trade_deadline_for_season(trade_deadline,${league.year})-3 FROM leagues WHERE id=${q(league.id)}`)
    await clock.scan(inside + ' 16:00:00+00')
    const deadline = await expectRows('trade_deadline_approaching', `data->>'leagueSeasonId'=${q(league.season)}`, league.members, () => sql(clock.minute))
    await transport.prove(fixture, deadline, 'supabase/tests/db/notif-t9-matchup-league.ts:36')
  }
  await clock.at('2026-10-20T16:00:00Z')
  for (const league of leagues) {
    const games: Match[] = []
    for (const pair of [[0, 1], [2, 3]]) {
      const id = crypto.randomUUID()
      games.push({ id, home_member_id: league.members[pair[0]], away_member_id: league.members[pair[1]], week_number: 1 })
      await sql(`INSERT INTO matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points) VALUES(${q(id)},${q(league.id)},${q(league.season)},1,${q(league.members[pair[0]])},${q(league.members[pair[1]])},100,99)`)
    }
    regular.set(league.id, games)
  }
  await sql(clock.minute)
  const started: OutboxRow[] = []
  for (const league of leagues) for (const game of regular.get(league.id)!) started.push(...await expectRows('matchup_started', `data->>'matchupId'=${q(game.id)}`, [game.home_member_id, game.away_member_id], () => sql(clock.minute)))
  await transport.prove(fixture, started, 'supabase/tests/db/notif-t9-matchup-league.ts:51')
  await clock.scan('2026-10-25T16:00:00Z')
  const close: OutboxRow[] = []
  for (const league of leagues) for (const game of regular.get(league.id)!) close.push(...await expectRows('matchup_close', `data->>'matchupId'=${q(game.id)}`, [game.home_member_id, game.away_member_id], () => sql(clock.minute)))
  await transport.prove(fixture, close, 'supabase/tests/db/notif-t9-matchup-league.ts:55')
  const finals: OutboxRow[] = []
  for (const league of leagues) {
    const games = regular.get(league.id)!
    await finalize(league, 1, games)
    finals.push(...await expectRows('playoff_clinched', `data->>'leagueSeasonId'=${q(league.season)}`, [league.members[0], league.members[2]], () => finalize(league, 1, games)))
    for (const game of games) finals.push(...await expectRows('matchup_final', `data->>'matchupId'=${q(game.id)}`, [game.home_member_id, game.away_member_id], () => finalize(league, 1, games)))
  }
  await transport.prove(fixture, finals, 'supabase/tests/db/notif-t9-matchup-league.ts:63')
  const seeds: OutboxRow[] = [], playoffFinals = new Map<string, Match>()
  for (const league of leagues) {
    await sql(`SELECT generate_playoff_bracket_atomic(${q(league.id)})`)
    seeds.push(...await expectRows('playoff_seeding', `data->>'leagueSeasonId'=${q(league.season)}`, [league.members[0], league.members[2]], () => sql(`SELECT generate_playoff_bracket_atomic(${q(league.id)})`)))
    playoffFinals.set(league.id, JSON.parse(await sql(`SELECT row_to_json(m) FROM matchups m WHERE league_season_id=${q(league.season)} AND matchup_type='playoff_final'`)))
  }
  await transport.prove(fixture, seeds, 'supabase/tests/db/notif-t9-matchup-league.ts:70')
  await clock.at('2026-11-01T16:00:00Z')
  const playoff: OutboxRow[] = []
  for (const league of leagues) {
    const game = playoffFinals.get(league.id)!
    await finalize(league, game.week_number, [game])
    playoff.push(...await expectRows('playoff_eliminated', `data->>'matchupId'=${q(game.id)}`, [game.away_member_id], () => finalize(league, game.week_number, [game])))
    playoff.push(...await expectRows('champion', `data->>'matchupId'=${q(game.id)}`, league.members, () => finalize(league, game.week_number, [game])))
  }
  await transport.prove(fixture, playoff, 'supabase/tests/db/notif-t9-matchup-league.ts:79')
  console.log('SYNTHETIC: real settings RPC, minute scanner deadline/started/close, certified score finalizer, bracket generation, playoff loss/final, exact recipients with pair/seed/foreign negatives, source retries, send-time switches and receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}
