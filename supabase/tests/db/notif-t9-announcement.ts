import { Clock, Fixture, Transport, expectRows, q, sql, type OutboxRow } from './notif-t9-support.ts'

const clock = new Clock(), fixture = new Fixture(), transport = new Transport()
try {
  await clock.start('2026-10-21T16:00:00Z')
  await fixture.init()
  await transport.start()
  for (let occurrence = 0; occurrence < 2; occurrence++) {
    const batch: OutboxRow[] = []
    for (let rotation = 0; rotation < 4; rotation++) {
      const league = await fixture.league('active', rotation)
      const id = crypto.randomUUID()
      const publish = () => sql(`SELECT set_config('request.jwt.claim.sub',${q(fixture.memberUsers.get(league.members[0])!)},false); SELECT notif_publish_announcement_atomic(${q(league.id)},${q('Synthetic announcement ' + occurrence)},${q(id)})`)
      await publish()
      batch.push(...await expectRows('commissioner_announcement', `data->>'announcementId'=${q(id)}`, league.members.slice(1), publish))
    }
    await transport.prove(fixture, batch, 'supabase/tests/db/notif-t9-announcement.ts:17')
  }
  console.log('SYNTHETIC: real commissioner publication RPC, author/foreign/non-member exclusion, request replay, three send-time switches and fake receipts')
} finally {
  await transport.close()
  await fixture.cleanup()
  await clock.restore()
}
