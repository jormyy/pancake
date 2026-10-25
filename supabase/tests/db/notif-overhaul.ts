import { strict as assert } from 'node:assert'

const db = Deno.env.get('SUPABASE_DB_URL')
assert.ok(db, 'SUPABASE_DB_URL is required')
const target = new URL(db)
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.port === port, 'Only the configured loopback test database is allowed')
const result = await new Deno.Command('psql', { args: [db, '-XqAt', '--set', 'ON_ERROR_STOP=1', '-f', 'tests/db/notif-overhaul.sql'], stdout: 'piped', stderr: 'piped' }).output()
const output = new TextDecoder().decode(result.stdout)
console.log(output)
console.error(new TextDecoder().decode(result.stderr))
if (result.code !== 0) Deno.exit(result.code)
const exported = output.split('\n').filter(line => line.startsWith('{"onClockRows"')).map(line => JSON.parse(line))[0]
assert.equal(exported?.onClockRows?.length, 8, 'Two local drafts must each produce four on-clock notifications')
const { deliverNotificationOutbox } = await import('../../functions/process-trades/outbox.ts')
const { createNotifyMembers } = await import('../../functions/_shared/notificationDelivery.ts')
const rows = exported.onClockRows as import('../../functions/process-trades/outbox.ts').NotificationOutboxRow[]
const pushes: { data: { pickId: string } }[] = []
const fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const messages = await request.json()
  pushes.push(...messages)
  return Response.json({ data: messages.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
})
try {
  const tickets = new Set<string>()
  const notify = createNotifyMembers({
    persistExpoTicket: async message => { tickets.add(message.delivery!.id) },
    members: async ids => ({ data: ids.map(id => ({ id, user_id: id })), error: null }),
    preferences: async () => ({ data: [], error: null }),
    profiles: async ids => ({ data: ids.map(id => ({ id, push_token: 'fake-' + id })), error: null }),
    send: (url, init) => fetch(url, init),
    pushUrl: `http://127.0.0.1:${fake.addr.port}/send`,
  })
  const delivered = await deliverNotificationOutbox(rows, notify,
    async () => { throw new Error('Ticketed pushes cannot complete before receipts') },
    async (_, error) => { throw new Error(error) }, async (_, error) => { throw new Error(error) })
  assert.equal(delivered.ticketed, 8)
  assert.equal(tickets.size, 8)
  assert.equal(pushes.length, 8)
  assert.equal(new Set(pushes.map(push => push.data.pickId)).size, 8)
  console.log(JSON.stringify({ provenance: 'SYNTHETIC', localSeasons: 2, picks: 8, onClockPushes: pushes.length, transport: 'task-local fake Expo' }))
} finally {
  await fake.shutdown()
}
