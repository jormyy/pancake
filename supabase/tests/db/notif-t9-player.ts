import { strict as assert } from 'node:assert'
import { Clock, Fixture, Transport, expectRows, q, sql, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  const player = await fixture.player()
  const expected: string[] = []
  for (let rotation = 0; rotation < 4; rotation++) {
    const league = await fixture.league()
    const owner = league.members[rotation]
    expected.push(owner)
    await sql(`INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(${q(league.id)},${q(league.season)},${q(owner)},${q(player)},'draft')`)
  }
  const scope = `data->>'playerId'=${q(player)}`
  for (const injury of ['Out', 'Questionable', 'Out']) {
    const before = JSON.parse(await sql(`SELECT COALESCE(json_agg(id),'[]') FROM notification_outbox WHERE data->>'playerId'=${q(player)}`)) as string[]
    const update = () => sql(`SELECT resolve_player_imports_atomic('espn',${q(JSON.stringify([{ provider_id: 'notif-' + player, first_name: 'Synthetic', last_name: player, metadata: { injury_status: injury, status: 'Active' } }]))}::jsonb)`)
    await update()
    assert.equal(await sql(`SELECT injury_status FROM players WHERE id=${q(player)}`), injury)
    const batch: OutboxRow[] = []
    for (const event of injury === 'Out' ? ['owned_player_status', 'owned_player_injured', 'owned_player_ruled_out'] : ['owned_player_status', 'owned_player_injured']) {
      batch.push(...await expectRows(event, scope + (before.length ? ` AND id NOT IN (${before.map(q)})` : ''), expected, update))
    }
    await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-player.ts:27')
  }
  console.log('SYNTHETIC: real resolve_player_imports_atomic ESPN metadata path, owned-player injury/status/Out, unchanged import retry, repeated distinct status occurrences, exact owner/foreign/non-member negatives, send-time switches and receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}
