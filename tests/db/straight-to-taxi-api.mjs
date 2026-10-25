import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

const api = process.env.E2E_SUPABASE_URL
const db = process.env.SUPABASE_DB_URL
assert.ok(api && db && ['127.0.0.1', 'localhost'].includes(new URL(api).hostname) && ['127.0.0.1', 'localhost'].includes(new URL(db).hostname))
const admin = createClient(api, process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const client = createClient(api, process.env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const [league, member, season, player] = Array.from({ length: 4 }, () => randomUUID())
const email = `${league}@example.test`
const password = `Local-${league}`
const sql = text => execFileSync('psql', [db, '-XAtqv', 'ON_ERROR_STOP=1', '-c', text], { encoding: 'utf8' }).trim()
let user
try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  assert.equal(created.error, null)
  user = created.data.user.id
  sql(`INSERT INTO leagues(id,name,slug,commissioner_id,status,taxi_slots) VALUES('${league}','Taxi API','${league}','${user}','active',2);
    INSERT INTO league_members(id,league_id,user_id,role) VALUES('${member}','${league}','${user}','commissioner');
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES('${season}','${league}',public.current_season_year_et(),true);
    INSERT INTO waiver_priorities(league_id,league_season_id,member_id,priority) VALUES('${league}','${season}','${member}',1);
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,years_exp,career_regular_season_games) VALUES('${player}','Taxi','API','PG',ARRAY['PG'],1,64);
    INSERT INTO waiver_wire_log(league_id,league_season_id,player_id) VALUES('${league}','${season}','${player}');`)
  const signed = await client.auth.signInWithPassword({ email, password })
  assert.equal(signed.error, null)
  const post = async (path, body) => {
    const response = await fetch(`${api}/functions/v1/api${path}`, { method: 'POST', headers: {
      authorization: `Bearer ${signed.data.session.access_token}`, 'content-type': 'application/json',
    }, body: JSON.stringify(body) })
    assert.equal(response.status, 200, await response.text())
  }
  await post('/waivers/claims', { memberId: member, leagueId: league, playerId: player, toTaxi: true })
  const claim = sql(`SELECT id FROM waiver_claims WHERE member_id='${member}'`)
  assert.equal(sql(`SELECT to_taxi AND NOT to_ir FROM waiver_claims WHERE id='${claim}'`), 't')
  await post(`/waivers/claims/${claim}/edit`, { memberId: member })
  assert.equal(sql(`SELECT to_taxi FROM waiver_claims WHERE id='${claim}'`), 't')
  await post(`/waivers/claims/${claim}/edit`, { memberId: member, toTaxi: false })
  assert.equal(sql(`SELECT to_taxi FROM waiver_claims WHERE id='${claim}'`), 'f')
  await post(`/waivers/claims/${claim}/edit`, { memberId: member, toTaxi: true })
  assert.equal(sql(`SELECT to_taxi FROM waiver_claims WHERE id='${claim}'`), 't')
  console.log(JSON.stringify({ passed: 8, authenticatedTaxiClaimCreationAndEdits: true }))
} finally {
  sql(`DELETE FROM leagues WHERE id='${league}'; DELETE FROM players WHERE id='${player}';`)
  await client.auth.signOut()
  if (user) assert.equal((await admin.auth.admin.deleteUser(user)).error, null)
}
