import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { apiTarget, databaseTarget } from '../../scripts/mutation/waivers/targets.mjs'

const db = databaseTarget().href
const origin = apiTarget().origin
const secret = process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY ?? process.env.PANCAKE_SUPABASE_SECRET_KEY
const publishable = process.env.E2E_SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY
const token = process.env.PANCAKE_EDGE_INTERNAL_TOKEN
assert(secret && publishable && token, 'Local stack keys and internal token are required')
const admin = createClient(origin, secret, { auth: { persistSession: false, autoRefreshToken: false } })
/** @type {{ id: string, accessToken?: string }[]} */
const users = []
const clients = []
let league
const players = [randomUUID(), randomUUID(), randomUUID()]
const quote = value => `'${String(value).replaceAll("'", "''")}'`
const sql = statement => {
  const result = spawnSync('psql', [db, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: statement, encoding: 'utf8', timeout: 25_000,
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const rpc = async (client, name, body) => {
  const result = await client.rpc(name, body)
  assert.ifError(result.error)
  return result.data
}
const route = async (index, path, body, expected = 200) => {
  const response = await fetch(`${origin}/functions/v1/api${path}`, {
    method: 'POST', headers: { apikey: publishable, authorization: `Bearer ${users[index].accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(25_000),
  })
  const result = await response.json()
  assert.equal(response.status, expected, JSON.stringify(result))
  return result
}
const seasonYear = Number(sql(`SELECT candidate FROM generate_series(2188,9999) candidate
  WHERE NOT EXISTS (SELECT 1 FROM season_weeks WHERE season_year=candidate)
    AND NOT EXISTS (SELECT 1 FROM league_seasons WHERE season_year=candidate)
    AND NOT EXISTS (SELECT 1 FROM nba_games WHERE season_year=candidate)
  ORDER BY candidate LIMIT 1`))
assert(Number.isInteger(seasonYear) && seasonYear >= 2188)
try {
  for (let i = 0; i < 2; i += 1) {
    const email = `synthetic-faab-${randomUUID()}@example.test`
    const password = `Local-${randomUUID()}`
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
    assert.ifError(created.error)
    users.push({ id: created.data.user.id })
    const client = createClient(origin, publishable, { auth: { persistSession: false, autoRefreshToken: false } })
    clients.push(client)
    const signed = await client.auth.signInWithPassword({ email, password })
    assert.ifError(signed.error)
    users[i].accessToken = signed.data.session.access_token
  }
  const created = await rpc(clients[0], 'create_league', { p_name: 'Synthetic HTTP waivers', p_team_name: 'HTTP A' })
  league = created.id
  const code = sql(`SELECT invite_code FROM leagues WHERE id=${quote(league)}`)
  await rpc(clients[1], 'join_league_by_invite_code', { p_invite_code: code, p_team_name: 'HTTP B' })
  const members = users.map(u => sql(`SELECT id FROM league_members WHERE league_id=${quote(league)} AND user_id=${quote(u.id)}`))
  sql(`BEGIN;
    UPDATE league_seasons SET season_year=${seasonYear} WHERE league_id=${quote(league)} AND is_current;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end)
    VALUES(${seasonYear},1,(now() AT TIME ZONE 'America/New_York')::date-3,(now() AT TIME ZONE 'America/New_York')::date+3);
    UPDATE leagues SET status='active',waiver_mode='faab',weekly_add_limit=2 WHERE id=${quote(league)};
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,status,nba_team)
    VALUES ${players.map(p => `(${quote(p)},'Synthetic','HTTP','PG',ARRAY['PG'],'Active','SIM')`).join(',')};
    INSERT INTO waiver_wire_log(league_id,league_season_id,player_id,placed_on_waivers_at)
    SELECT ${quote(league)},s.id,p.id,now()-interval '49 hours' FROM league_seasons s
    CROSS JOIN players p WHERE s.league_id=${quote(league)} AND s.is_current AND p.id IN(${players.map(quote).join(',')});
    UPDATE waiver_wire_log SET clears_at=now()-interval '1 minute' WHERE league_id=${quote(league)};
    COMMIT;`)
  await rpc(clients[0], 'update_league_settings_atomic', { p_league_id: league, p_settings: { skipped_weeks: [1] } })
  assert.equal(sql(`SELECT skipped_weeks::text FROM league_seasons WHERE league_id=${quote(league)} AND is_current`), '{1}')
  const body = (team, player, bid) => ({ leagueId: league, memberId: members[team], playerId: player, bidAmount: bid })
  const tooHigh = await route(0, '/waivers/claims', body(0, players[0], 101), 400)
  assert.match(JSON.stringify(tooHigh), /exceeds your available balance/)
  await route(0, '/waivers/claims', body(0, players[0], 10))
  await route(1, '/waivers/claims', body(1, players[0], 10))
  await route(0, '/waivers/claims', body(0, players[1], 0))
  await route(0, '/waivers/claims', body(0, players[2], 1))
  const claims = JSON.parse(sql(`SELECT json_object_agg(player_id,id) FROM waiver_claims WHERE member_id=${quote(members[0])}`))
  await route(0, `/waivers/claims/${claims[players[2]]}/cancel`, { memberId: members[0] })
  await route(0, `/waivers/claims/${claims[players[1]]}/edit`, { memberId: members[0], bidAmount: 0 })
  const processClaims = async () => {
    const response = await fetch(`${origin}/functions/v1/process-waivers`, {
      method: 'POST', headers: { apikey: secret, authorization: `Bearer ${secret}`, 'x-internal-function-token': token },
      signal: AbortSignal.timeout(30_000),
    })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    return result
  }
  await processClaims()
  const ownClaimStates = () => sql(`SELECT json_agg(json_build_array(id,status,failure_reason,processed_at) ORDER BY id)
    FROM waiver_claims WHERE league_id=${quote(league)}`)
  assert.deepEqual(JSON.parse(sql(`SELECT json_object_agg(status,total) FROM (
    SELECT status,count(*) total FROM waiver_claims WHERE league_id=${quote(league)} GROUP BY status
  ) counts`)), { cancelled: 1, failed_priority: 1, succeeded: 2 })
  const settledClaims = ownClaimStates()
  assert.equal(sql(`SELECT balance FROM faab_balances WHERE member_id=${quote(members[0])}`), '90')
  assert.equal(sql(`SELECT balance FROM faab_balances WHERE member_id=${quote(members[1])}`), '100')
  assert.equal(sql(`SELECT add_count FROM weekly_add_counts WHERE member_id=${quote(members[0])}`), '2')
  assert.equal(sql(`SELECT week_number FROM weekly_add_counts WHERE member_id=${quote(members[0])}`), '1')
  assert.equal(sql(`SELECT status FROM waiver_claims WHERE player_id=${quote(players[0])} AND member_id=${quote(members[1])}`), 'failed_priority')
  assert.equal(sql(`SELECT count(*) FROM roster_players WHERE member_id=${quote(members[0])}`), '2')
  await processClaims()
  assert.equal(ownClaimStates(), settledClaims)
  assert.equal(sql(`SELECT count(*) FROM roster_transactions WHERE league_id=${quote(league)} AND transaction_type='waiver_add'`), '2')
  assert.equal(sql(`SELECT balance FROM faab_balances WHERE member_id=${quote(members[0])}`), '90')
  sql(`UPDATE season_weeks SET week_start=(now() AT TIME ZONE 'America/New_York')::date-7,
    week_end=(now() AT TIME ZONE 'America/New_York')::date-1 WHERE season_year=${seasonYear} AND week_number=1;
    INSERT INTO season_weeks(season_year,week_number,week_start,week_end) VALUES(${seasonYear},2,
      (now() AT TIME ZONE 'America/New_York')::date,(now() AT TIME ZONE 'America/New_York')::date+6);`)
  await rpc(clients[0], 'add_free_agent_atomic', { p_member_id: members[0], p_league_id: league, p_player_id: players[2] })
  assert.deepEqual(JSON.parse(sql(`SELECT json_agg(add_count ORDER BY week_number) FROM weekly_add_counts WHERE member_id=${quote(members[0])}`)), [2, 1])
  console.log('PASS SYNTHETIC: authenticated HTTP submission/edit/cancel, skipped settings, real worker, tied/zero bids, winner-only debit, add limits, retry')
} finally {
  if (league) sql(`DELETE FROM leagues WHERE id=${quote(league)}; DELETE FROM players WHERE id IN(${players.map(quote).join(',')}); DELETE FROM season_weeks WHERE season_year=${seasonYear};`)
  for (const user of users) {
    const result = await admin.auth.admin.deleteUser(user.id)
    assert.ifError(result.error)
  }
}
