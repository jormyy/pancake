import { strict as assert } from 'node:assert'
import { supabase as admin } from '../../functions/_shared/supabase.ts'

const db = Deno.env.get('SUPABASE_DB_URL')!
const api = Deno.env.get('SUPABASE_URL')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && Number(new URL(api).port) === Number(port) - 1)
const key = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')!
const internalToken = Deno.env.get('PANCAKE_EDGE_INTERNAL_TOKEN')!
assert.ok(key && internalToken)
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
async function sql(statement: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', statement], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
const pushes: { data: { notificationEvent: string; outboxId: string } }[] = []
let failing = true
const fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const body = await request.json()
  if (new URL(request.url).pathname === '/receipts') return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
  if (failing) return Response.json({ error: 'Synthetic retry' }, { status: 503 })
  pushes.push(...body)
  return Response.json({ data: body.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
})
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${fake.addr.port}/send`)
Deno.env.set('EXPO_RECEIPTS_URL', `http://127.0.0.1:${fake.addr.port}/receipts`)
Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
const serve = Deno.serve
const descriptor = Object.getOwnPropertyDescriptor(Deno, 'serve')!
let worker: Deno.HttpServer<Deno.NetAddr> | undefined
Object.defineProperty(Deno, 'serve', { value: (handler: Deno.ServeHandler) => {
  worker = serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, handler)
  return worker
} })
try { await import('../../functions/process-trades/index.ts') } finally { Object.defineProperty(Deno, 'serve', descriptor) }
assert.ok(worker)
const endpoint = `http://127.0.0.1:${worker.addr.port}`
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input, init) => {
  assert.ok([new URL(api).origin, `http://127.0.0.1:${fake.addr.port}`, endpoint].includes(new URL(input instanceof Request ? input.url : input).origin))
  return nativeFetch(input, init)
}
async function drain() {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'x-internal-function-token': internalToken }, body: '{}' })
  const body = await response.text()
  console.log(body)
  assert.equal(response.status, 200, body)
}
try {
  for (const source of ['lineup', 'watch', 'announcement']) {
    const fixture = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-v', `notif_case=${source}`, '-v', 'notif_persist=true', '-f', 'tests/db/notif-round3.sql'], stdout: 'piped', stderr: 'piped' }).output()
    assert.equal(fixture.code, 0, new TextDecoder().decode(fixture.stderr))
    const exported = JSON.parse(new TextDecoder().decode(fixture.stdout).split('\n').find(line => line.startsWith('{"fixture"'))!)
    const f = exported.fixture
    try {
      await sql(`UPDATE profiles SET push_token='fake-notif-round3-' || id WHERE id IN(${quote(f.owner)},${quote(f.opponent)});
        UPDATE notification_outbox SET claimed_at=NULL,claim_token=NULL WHERE member_id IN(${quote(f.member)},${quote(f.other_member)});`)
      failing = true
      await drain()
      failing = false
      await sql(`UPDATE notification_outbox SET available_at=clock_timestamp()-interval '1 second' WHERE member_id IN(${quote(f.member)},${quote(f.other_member)});`)
      const before = pushes.length
      await drain()
      const events = source === 'lineup' ? ['lineup_inactive', 'lineup_empty'] : source === 'watch' ? ['watched_player_dropped'] : ['commissioner_announcement']
      for (const event of events) {
        assert.equal(pushes.slice(before).filter(push => push.data.notificationEvent === event).length, 1, event + ': ' + await sql(`SELECT json_agg(row_to_json(o)) FROM notification_outbox o WHERE member_id IN(${quote(f.member)},${quote(f.other_member)})`))
        const state = await admin.from('notification_outbox').select('id,delivered_at,suppressed_at').eq('event_type', event).in('member_id', [f.member, f.other_member])
        assert.equal(state.error, null)
        assert.equal(state.data?.length, 1)
        assert.ok(state.data?.[0].delivered_at, `${event} must have a fake Expo receipt`)
        assert.equal(state.data?.[0].suppressed_at, null)
      }
      const settled = pushes.length
      await drain()
      assert.equal(pushes.length, settled, 'Resume cannot resend a receipted event')
      console.log(JSON.stringify({ provenance: 'SYNTHETIC', source, events, retry: true, receipts: events.length, resumedWithoutDuplicate: true }))
    } finally {
      await sql(`DELETE FROM leagues WHERE id IN(${quote(f.league)},${quote(f.other_league)});
        DELETE FROM auth.users WHERE id IN(${quote(f.owner)},${quote(f.opponent)},${quote(f.outsider)});
        DELETE FROM profiles WHERE id IN(${quote(f.owner)},${quote(f.opponent)},${quote(f.outsider)});
        DELETE FROM players WHERE id IN(${exported.resources.players.map(quote).join(',')});
        DELETE FROM nba_games WHERE id IN(${exported.resources.games.map(quote).join(',')});
        DELETE FROM season_weeks WHERE season_year=${f.fixture_year} AND week_number=1;
        ${exported.resources.calendar ? `INSERT INTO season_weeks SELECT * FROM jsonb_populate_record(NULL::public.season_weeks,${quote(JSON.stringify(exported.resources.calendar))}::jsonb);` : ''}`)
    }
  }
} finally {
  globalThis.fetch = nativeFetch
  await fake.shutdown()
  await worker.shutdown()
}
