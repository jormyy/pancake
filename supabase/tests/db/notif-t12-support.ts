import { strict as assert } from 'node:assert'
// eslint-disable-next-line import/no-unresolved
import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import { Fixture, q, sql } from './notif-t9-support.ts'

// Turn-12 recipes run only on the notif lane stack. Ports come from the lane env
// (PANCAKE_TEST_DB_PORT, SUPABASE_DB_URL, SUPABASE_URL); there is no default.
// The 582xx (sim-t6) and 574xx (sim-t12) replay stacks and the default 543xx
// stack are refused even when every URL agrees with the configured port.
const lanePort = Deno.env.get('PANCAKE_TEST_DB_PORT') ?? ''
assert.match(lanePort, /^\d{5}$/, 'PANCAKE_TEST_DB_PORT must name the lane stack')
const apiPort = Deno.env.get('PANCAKE_TEST_API_PORT')
if (apiPort !== undefined) assert.equal(Number(apiPort), Number(lanePort) - 1, 'PANCAKE_TEST_API_PORT is the lane API port')
const api = Deno.env.get('SUPABASE_URL')!
for (const port of [lanePort, apiPort, new URL(Deno.env.get('SUPABASE_DB_URL')!).port, new URL(api).port]) {
  if (port !== undefined) assert.ok(!/^(582|574|543)\d\d$/.test(port), `Refusing port ${port}: 582xx, 574xx and 543xx belong to other stacks`)
}

// Fixture users are inserted straight into auth.users and cannot sign in. The
// API routes need real sessions, so these come from the local GoTrue admin API
// with throwaway passwords; everything else matches Fixture.init.
export class SignedFixture extends Fixture {
  tokens = new Map<string, string>()
  async signIn() {
    const secret = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY')
    const publishable = Deno.env.get('PANCAKE_SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('E2E_SUPABASE_PUBLISHABLE_KEY')
    assert.ok(secret && publishable, 'The lane env provides the local stack keys')
    const options = { auth: { persistSession: false, autoRefreshToken: false } }
    const admin = createClient(api, secret, options)
    const scope = crypto.randomUUID().replaceAll('-', '').slice(0, 14)
    this.users = []
    for (let index = 0; index < 5; index++) {
      const email = `notif-t12-${scope}-${index}@example.test`, password = `Synthetic-${crypto.randomUUID()}!`
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `n12_${scope}_${index}` } })
      if (created.error) throw created.error
      this.users.push(created.data.user.id)
      const login = await createClient(api, publishable, options).auth.signInWithPassword({ email, password })
      if (login.error) throw login.error
      this.tokens.set(created.data.user.id, login.data.session.access_token)
    }
  }
  override async init() {
    assert.equal(this.tokens.size, 5, 'signIn() creates the users first')
    await sql(`INSERT INTO notification_preferences(user_id,event_settings) SELECT id,(SELECT jsonb_object_agg(event_type,false) FROM notif_event_catalog) FROM unnest(ARRAY[${this.users.map(q)}]::uuid[]) id;
      UPDATE profiles SET push_token='fake-notif-t12-'||id WHERE id IN (${this.users.map(q)});`)
    const foreign = await this.league('offseason', 0, false)
    this.foreignMembers.push(...foreign.members)
    this.foreignLeague = foreign.id
    const outsider = crypto.randomUUID()
    this.foreignMembers.push(outsider)
    this.memberUsers.set(outsider, this.users[4])
    await sql(`INSERT INTO league_members(id,league_id,user_id,role) VALUES(${q(outsider)},${q(foreign.id)},${q(this.users[4])},'manager')`)
    return this
  }
  override async cleanup() {
    if (this.users.length) await super.cleanup()
  }
  token(member: string) {
    const token = this.tokens.get(this.memberUsers.get(member)!)
    assert.ok(token, `member ${member} has a signed-in user`)
    return token
  }
}

// POST to the real API module served in-process (Transport.serve), through its
// router, auth and handler, as the signed-in user behind `token`.
export async function post(server: Deno.HttpServer<Deno.NetAddr>, route: string, token: string, body: object = {}) {
  const response = await fetch(`http://127.0.0.1:${server.addr.port}/functions/v1/api${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

// Outbox ids already present, as a uuid[] literal usable when the list is empty.
export const known = async (event: string, scope = 'true') =>
  JSON.parse(await sql(`SELECT COALESCE(json_agg(id),'[]') FROM notification_outbox WHERE event_type=${q(event)} AND (${scope})`)) as string[]
export const fresh = (ids: string[]) => `NOT (id = ANY(${q('{' + ids.join(',') + '}')}::uuid[]))`
