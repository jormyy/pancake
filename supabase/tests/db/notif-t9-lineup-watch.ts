import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, sql, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  const sources = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league('active', rotation)
    const player = await fixture.player(), bench = await fixture.player()
    await sql(`UPDATE players SET nba_team=id::text,injury_status='Out' WHERE id=${q(player)};
      UPDATE players SET nba_team=id::text,position='SG',eligible_positions=ARRAY['SG'] WHERE id=${q(bench)};
      INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league.id)},${q(league.season)},${q(league.members[0])},${q(player)},'draft'),(${q(league.id)},${q(league.season)},${q(league.members[0])},${q(bench)},'draft');
      INSERT INTO weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type) VALUES(${q(league.id)},${q(league.season)},${q(league.members[0])},${q(player)},1,'2026-10-21','PG');`)
    const game = await fixture.game(league.year, '2026-10-21', 1)
    await sql(`UPDATE nba_games SET home_team=${q(player)},away_team=${q(bench)},game_time=clock_timestamp()+interval '1 hour' WHERE id=${q(game)}`)
    sources.push({ league, player })
  }
  await sql(clock.minute)
  const lineup: OutboxRow[] = []
  for (const source of sources) for (const event of ['lineup_inactive', 'lineup_empty']) lineup.push(...await expectRows(event, `data->>'leagueId'=${q(source.league.id)}`, [source.league.members[0]], () => sql(clock.minute)))
  await transport.prove(fixture, lineup, 'supabase/tests/db/notif-t9-lineup-watch.ts:24')
  const watched: OutboxRow[] = []
  for (const { league, player } of sources) {
    for (const member of league.members) await sql(`SELECT set_config('request.jwt.claim.sub',${q(fixture.memberUsers.get(member)!)},false); SELECT notif_set_player_watch_atomic(${q(league.id)},${q(player)},true)`)
    for (const member of fixture.foreignMembers) await sql(`SELECT set_config('request.jwt.claim.sub',${q(fixture.memberUsers.get(member)!)},false); SELECT notif_set_player_watch_atomic(${q(fixture.foreignLeague)},${q(player)},true)`)
    const roster = await sql(`SELECT id FROM roster_players WHERE league_id=${q(league.id)} AND player_id=${q(player)}`)
    const drop = () => sql(`SELECT set_config('request.jwt.claim.sub',${q(fixture.memberUsers.get(league.members[0])!)},false); SELECT drop_player_atomic(${q(roster)},${q(league.season)},NULL)`)
    await drop()
    watched.push(...await expectRows('watched_player_dropped', `data->>'playerId'=${q(player)}`, league.members.slice(1), async () => { await assert.rejects(drop, /not found|no longer/i) }))
  }
  await transport.prove(fixture, watched, 'supabase/tests/db/notif-t9-lineup-watch.ts:34')
  console.log('SYNTHETIC: saved starter and fillable empty-slot scanner, real watch/drop RPCs, actor and actual same-player foreign watchers excluded, source retries, all switches after rows, fake receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}
