import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const api = process.env.E2E_SUPABASE_URL
const db = process.env.SUPABASE_DB_URL
assert.ok(api && db && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const options = { auth: { persistSession: false, autoRefreshToken: false } }
const admin = createClient(api, process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY, options)
const client = createClient(api, process.env.E2E_SUPABASE_PUBLISHABLE_KEY, options)
const [league, member, season, player] = Array.from({ length: 4 }, () => randomUUID())
const email = `${league}@example.test`
const password = `Local-${league}`
let user
const sql = (text) => execFileSync('psql', [db, '-X', '-Atq', '-v', 'ON_ERROR_STOP=1', '-c', text], { encoding: 'utf8' }).trim()
try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  assert.equal(created.error, null)
  user = created.data.user.id
  sql(`BEGIN;
    INSERT INTO leagues(id,name,slug,commissioner_id,status) VALUES('${league}','IR API','${league}','${user}','active');
    INSERT INTO league_members(id,league_id,user_id,role) VALUES('${member}','${league}','${user}','commissioner');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',public.current_season_year_et(),true);
    INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) VALUES('${league}','${season}','${member}',1);
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status) VALUES('${player}','API','Injured','PG',ARRAY['PG'],'Out');
    INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,clears_at) VALUES('${league}','${season}','${player}',now()+interval '1 day');
    COMMIT;`)
  const signed = await client.auth.signInWithPassword({ email, password })
  assert.equal(signed.error, null)
  const post = async (path, body) => {
    const result = await fetch(`${api}/functions/v1/api${path}`, { method: 'POST', headers: {
      authorization: `Bearer ${signed.data.session.access_token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) })
    const content = await result.json()
    assert.equal(result.status, 200, JSON.stringify(content))
  }
  await post('/waivers/claims', { leagueId: league, memberId: member, playerId: player, toIr: true })
  const claim = sql(`SELECT id FROM waiver_claims WHERE member_id='${member}'`)
  assert.equal(sql(`SELECT to_ir FROM waiver_claims WHERE id='${claim}'`), 't')
  await post(`/waivers/claims/${claim}/edit`, { memberId: member, toIr: false })
  assert.equal(sql(`SELECT to_ir FROM waiver_claims WHERE id='${claim}'`), 'f')
  await post(`/waivers/claims/${claim}/edit`, { memberId: member, toIr: true })
  assert.equal(sql(`SELECT to_ir FROM waiver_claims WHERE id='${claim}'`), 't')
  console.log('PASS: authenticated API create and edit preserve the IR choice')
} finally {
  sql(`DELETE FROM leagues WHERE id='${league}'; DELETE FROM players WHERE id='${player}';`)
  if (user) {
    const removed = await admin.auth.admin.deleteUser(user)
    assert.equal(removed.error, null)
  }
}
