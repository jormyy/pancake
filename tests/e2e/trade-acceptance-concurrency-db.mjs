import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const [league, season, p1, p2, p3, ...rest] = Array.from({ length: 11 }, () => randomUUID())
const users = rest.slice(0, 3)
const members = rest.slice(3, 6)
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`

function query(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', [url, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let error = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { error += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output: output.trim(), error }))
  })
}

const one = async (sql) => {
  const result = await query(sql)
  assert.equal(result.code, 0, result.error)
  return result.output
}

const settle = async (tradeId) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await one(`SELECT status FROM trades WHERE id=${quote(tradeId)}`) !== 'pending') return
    for (const member of members) {
      await query(`SELECT public.accept_trade_atomic(${quote(tradeId)},${quote(member)})`)
    }
  }
}

const race = (statements) => Promise.all(statements.map((statement) => query(`BEGIN; SET LOCAL statement_timeout='20s'; ${statement} SELECT pg_sleep(0.25); COMMIT;`)))

try {
  await one(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id::uuid,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${users.map(quote).join(',')}]) id;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,trade_veto_mode,allow_inactive_trades)
      VALUES(${quote(league)},'Acceptance race',${quote(league)},${quote(users[0])},'active',1,0,0,'disabled',true);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},9701,true);
    ${members.map((id, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(id)},${quote(league)},${quote(users[index])},'${index === 0 ? 'commissioner' : 'manager'}','Race team ${index + 1}');`).join('\n')}
    INSERT INTO players(id,first_name,last_name,position,eligible_positions)
      VALUES(${quote(p1)},'Race','One','PG',ARRAY['PG']),(${quote(p2)},'Race','Two','PG',ARRAY['PG']),(${quote(p3)},'Race','Three','PG',ARRAY['PG']);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(${quote(league)},${quote(season)},${quote(members[0])},${quote(p1)},'verification'),
            (${quote(league)},${quote(season)},${quote(members[0])},${quote(p2)},'verification'),
            (${quote(league)},${quote(season)},${quote(members[2])},${quote(p3)},'verification');
    COMMIT;`)

  const first = await one(`SELECT public.propose_multi_team_trade_atomic(${quote(league)},${quote(season)},${quote(members[0])},
    ARRAY[${quote(members[1])},${quote(members[2])}]::uuid[],
    ${quote(JSON.stringify([
      { fromMemberId: members[0], toMemberId: members[2], playerId: p1 },
      { fromMemberId: members[2], toMemberId: members[1], faabAmount: 5 },
      { fromMemberId: members[1], toMemberId: members[0], faabAmount: 5 },
    ]))}::jsonb)`)
  const partial = await one(`SELECT public.accept_trade_atomic(${quote(first)},${quote(members[1])})`)
  assert.equal(JSON.parse(partial).allAccepted, false)
  assert.equal(await one(`SELECT status FROM trades WHERE id=${quote(first)}`), 'pending',
    'a partial acceptance succeeds while another team is full')

  await one(`SELECT public.set_trade_roster_plan_atomic(${quote(first)},${quote(members[2])},${quote(users[2])},'{}','{}',ARRAY[${quote(p3)}]::uuid[])`)
  const finalAccept = await race([
    `SELECT public.accept_trade_atomic(${quote(first)},${quote(members[2])});`,
    `SELECT public.accept_trade_atomic(${quote(first)},${quote(members[2])});`,
  ])
  assert.ok(finalAccept.some((result) => result.code === 0), JSON.stringify(finalAccept))
  assert.ok(finalAccept.every((result) => result.code === 0 || /league is busy|already accepted|no longer pending/i.test(result.error)), JSON.stringify(finalAccept))
  await settle(first)
  assert.equal(await one(`SELECT status FROM trades WHERE id=${quote(first)}`), 'accepted')
  assert.equal(await one(`SELECT count(*) FROM trade_participants WHERE trade_id=${quote(first)} AND accepted_at IS NOT NULL`), '3')

  const completions = await race([
    `SELECT public.complete_accepted_trade_atomic(${quote(first)});`,
    `SELECT public.complete_accepted_trade_atomic(${quote(first)});`,
  ])
  const completed = completions.filter((result) => result.code === 0)
  assert.equal(completed.length, 1, JSON.stringify(completions))
  assert.equal(await one(`SELECT status FROM trades WHERE id=${quote(first)}`), 'completed')
  assert.equal(await one(`SELECT member_id FROM roster_players WHERE league_id=${quote(league)} AND player_id=${quote(p1)}`), members[2])
  assert.equal(await one(`SELECT count(*) FROM roster_players WHERE league_id=${quote(league)} AND player_id=${quote(p3)}`), '0')
  assert.equal(await one(`SELECT balance FROM faab_balances WHERE league_id=${quote(league)} AND member_id=${quote(members[2])}`), '95')
  assert.equal(await one(`SELECT balance FROM faab_balances WHERE league_id=${quote(league)} AND member_id=${quote(members[1])}`), '100')
  assert.equal(await one(`SELECT balance FROM faab_balances WHERE league_id=${quote(league)} AND member_id=${quote(members[0])}`), '105')

  const second = await one(`SELECT public.propose_multi_team_trade_atomic(${quote(league)},${quote(season)},${quote(members[0])},
    ARRAY[${quote(members[1])},${quote(members[2])}]::uuid[],
    ${quote(JSON.stringify([
      { fromMemberId: members[0], toMemberId: members[1], playerId: p2 },
      { fromMemberId: members[1], toMemberId: members[0], faabAmount: 2 },
      { fromMemberId: members[2], toMemberId: members[0], faabAmount: 2 },
    ]))}::jsonb)`)
  const lastAccept = await race([
    `SELECT public.accept_trade_atomic(${quote(second)},${quote(members[1])});`,
    `SELECT public.accept_trade_atomic(${quote(second)},${quote(members[2])});`,
  ])
  assert.ok(lastAccept.some((result) => result.code === 0), JSON.stringify(lastAccept))
  assert.ok(lastAccept.every((result) => result.code === 0 || /league is busy|already accepted|no longer pending/i.test(result.error)), JSON.stringify(lastAccept))
  await settle(second)
  assert.equal(await one(`SELECT status FROM trades WHERE id=${quote(second)}`), 'accepted')
  assert.equal(await one(`SELECT count(*) FROM trade_participants WHERE trade_id=${quote(second)} AND accepted_at IS NOT NULL`), '3')

  console.log('PASS: partial acceptance survives a full participant; concurrent final acceptance and completion each apply exactly once')
} finally {
  const cleanup = await query(`DELETE FROM leagues WHERE id=${quote(league)}; DELETE FROM trades WHERE league_id=${quote(league)}; DELETE FROM players WHERE id IN (${[p1, p2, p3].map(quote).join(',')}); DELETE FROM auth.users WHERE id IN (${users.map(quote).join(',')});`)
  assert.equal(cleanup.code, 0, cleanup.error)
}
