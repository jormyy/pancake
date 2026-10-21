import { strict as assert } from 'node:assert'
const db = Deno.env.get('SUPABASE_DB_URL')!
const port = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? '54322'
assert.match(port, /^\d+$/)
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(db).hostname) && new URL(db).port === port)
async function sql(statement: string) {
  const result = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-c', statement], stdout: 'piped', stderr: 'piped' }).output()
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr))
  return new TextDecoder().decode(result.stdout).trim()
}
let expo = 0, web = 0
const fake = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async request => {
  const body = await request.json()
  const route = new URL(request.url).pathname
  if (route === '/web') { web++; return Response.json({ ok: true }) }
  if (route === '/receipts') return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, { status: 'ok' }])) })
  assert.equal(route, '/send')
  expo += body.length
  return Response.json({ data: body.map(() => ({ status: 'ok', id: crypto.randomUUID() })) })
})
Deno.env.set('EXPO_PUSH_URL', `http://127.0.0.1:${fake.addr.port}/send`)
Deno.env.set('EXPO_RECEIPT_DELAY_SECONDS', '0')
const cases = [
  ['expo_before_network', 'expo', 1, true], ['expo_after_acceptance', 'expo', 2, true],
  ['expo_after_ticket', 'expo', 1, true], ['expo_after_receipt', 'expo', 1, true], ['expo_after_complete', 'expo', 1, true],
  ['web_before_reservation', 'web', 1, true], ['web_after_reservation', 'web', 0, false],
  ['web_after_acceptance', 'web', 1, false], ['web_after_finish', 'web', 1, true],
] as const
function child(phase: string, transport: string, id: string) {
  return new Deno.Command('deno', { args: ['run', '--no-lock', '--allow-env', '--allow-net=127.0.0.1', 'supabase/tests/db/notif-crash-worker.ts', phase, transport, id], stdout: 'piped', stderr: 'inherit' }).spawn()
}
try {
  for (const [phase, transport, expected, delivered] of cases) {
    const fixture = await new Deno.Command('psql', { args: [db, '-XqAtv', 'ON_ERROR_STOP=1', '-v', 'notif_case=announcement', '-v', 'notif_persist=true', '-f', 'tests/db/notif-round3.sql'], stdout: 'piped', stderr: 'piped' }).output()
    assert.equal(fixture.code, 0, new TextDecoder().decode(fixture.stderr))
    const { fixture: f, resources } = JSON.parse(new TextDecoder().decode(fixture.stdout).split('\n').find(line => line.startsWith('{"fixture"'))!)
    try {
      const id = await sql(`UPDATE notification_outbox SET suppressed_at=now(),suppression_reason='preferences_disabled' WHERE member_id IN('${f.member}','${f.other_member}') AND event_type<>'commissioner_announcement';
        UPDATE profiles SET push_token='fake-crash-' || id WHERE id='${f.opponent}';
        UPDATE notification_outbox SET claimed_at=NULL,claim_token=NULL WHERE member_id='${f.other_member}' AND event_type='commissioner_announcement' RETURNING id;`)
      const before = transport === 'expo' ? expo : web
      const process = child(phase, transport, id)
      const reader = process.stdout.getReader()
      let output = ''
      let timer = 0
      try {
        await Promise.race([ (async () => {
          while (!output.includes('CRASH_WINDOW ' + phase)) {
            const { done, value } = await reader.read()
            if (done) throw new Error('Worker exited before crash barrier: ' + output)
            output += new TextDecoder().decode(value)
          }
        })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Crash barrier timeout: ' + output)), 15000) }) ])
      } finally {
        clearTimeout(timer)
        process.kill('SIGKILL')
        const status = await process.status
        assert.equal(status.signal, 'SIGKILL')
        reader.releaseLock()
      }
      await sql(`UPDATE notification_outbox SET claimed_at=CASE WHEN claim_token IS NULL THEN NULL ELSE clock_timestamp()-interval '61 seconds' END,available_at=clock_timestamp()-interval '1 second' WHERE id='${id}'`)
      const resumed = child('normal', transport, id)
      const status = await resumed.status
      assert.equal(status.code, 0)
      await resumed.stdout.cancel()
      assert.equal((transport === 'expo' ? expo : web) - before, expected, phase)
      assert.equal(await sql(`SELECT delivered_at IS NOT NULL FROM notification_outbox WHERE id='${id}'`), delivered ? 't' : 'f', phase)
      assert.equal(await sql(`SELECT count(*) FROM notification_outbox WHERE event_type='commissioner_announcement' AND member_id='${f.other_member}'`), '1')
      console.log(JSON.stringify({ provenance: 'SYNTHETIC', phase, killed: 'SIGKILL', transport, acceptedAttempts: expected, delivered, outboxRows: 1 }))
    } finally {
      await sql(`DELETE FROM leagues WHERE id IN('${f.league}','${f.other_league}'); DELETE FROM auth.users WHERE id IN('${f.owner}','${f.opponent}','${f.outsider}'); DELETE FROM profiles WHERE id IN('${f.owner}','${f.opponent}','${f.outsider}'); DELETE FROM players WHERE id IN(${resources.players.map((id: string) => `'${id}'`).join(',')}); DELETE FROM nba_games WHERE id IN(${resources.games.map((id: string) => `'${id}'`).join(',')}); DELETE FROM season_weeks WHERE season_year=${f.fixture_year} AND week_number=1; ${resources.calendar ? `INSERT INTO season_weeks SELECT * FROM jsonb_populate_record(NULL::public.season_weeks,'${JSON.stringify(resources.calendar).replaceAll("'", "''")}'::jsonb);` : ''}`)
    }
  }
} finally { await fake.shutdown() }
