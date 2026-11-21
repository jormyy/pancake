import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const [league, season, p1, p2, p3, ...rest] = Array.from({ length: 9 }, () => randomUUID())
const users = rest.slice(0, 2)
const members = rest.slice(2, 4)
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

const race = (statements) => Promise.all(statements.map((statement) => query(`BEGIN; SET LOCAL statement_timeout='20s'; ${statement} SELECT pg_sleep(0.05); COMMIT;`)))

const propose = () => one(`SELECT public.propose_trade_atomic(${quote(league)},${quote(season)},${quote(members[0])},${quote(members[1])},
  '{}'::uuid[], ARRAY[${quote(p2)}]::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0)`)

const state = async (tradeId) => {
  const row = await one(`SELECT json_build_object(
    'status', trade.status,
    'proposerAccepted', proposer.accepted_at IS NOT NULL,
    'recipientAccepted', recipient.accepted_at IS NOT NULL)
    FROM trades trade
    JOIN trade_participants proposer ON proposer.trade_id=trade.id AND proposer.member_id=${quote(members[0])}
    JOIN trade_participants recipient ON recipient.trade_id=trade.id AND recipient.member_id=${quote(members[1])}
    WHERE trade.id=${quote(tradeId)}`)
  return JSON.parse(row)
}

const assertLegal = (tradeId, label) => async () => {
  const current = await state(tradeId)
  if (current.status === 'accepted') {
    assert.equal(current.proposerAccepted, true, `${label}: accepted trade keeps the proposer acceptance`)
    assert.equal(current.recipientAccepted, true, `${label}: accepted trade keeps the recipient acceptance`)
    return
  }
  assert.equal(current.status, 'pending', `${label}: unexpected status ${current.status}`)
  assert.ok(!(current.proposerAccepted && current.recipientAccepted), `${label}: a unanimous pending trade is illegal`)
}

try {
  await one(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id::uuid,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${users.map(quote).join(',')}]) id;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,trade_veto_mode,allow_inactive_trades)
      VALUES(${quote(league)},'Hold race',${quote(league)},${quote(users[0])},'active',2,0,0,'disabled',true);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},9712,true);
    ${members.map((id, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(id)},${quote(league)},${quote(users[index])},'${index === 0 ? 'commissioner' : 'manager'}','Hold race team ${index + 1}');`).join('\n')}
    INSERT INTO players(id,first_name,last_name,position,eligible_positions)
      VALUES(${quote(p1)},'Hold','One','PG',ARRAY['PG']),(${quote(p2)},'Hold','Two','PG',ARRAY['PG']),(${quote(p3)},'Hold','Three','PG',ARRAY['PG']);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(${quote(league)},${quote(season)},${quote(members[0])},${quote(p1)},'verification'),
            (${quote(league)},${quote(season)},${quote(members[1])},${quote(p2)},'verification'),
            (${quote(league)},${quote(season)},${quote(members[1])},${quote(p3)},'verification');
    COMMIT;`)

  const iterations = 24
  for (let index = 0; index < iterations; index++) {
    const tradeId = await propose()
    const results = await race([
      `SELECT public.accept_trade_atomic(${quote(tradeId)},${quote(members[1])});`,
      `SELECT public.retract_trade_acceptance_atomic(${quote(tradeId)},${quote(members[0])},${quote(users[0])});`,
    ])
    const accepted = results[0]
    const retracted = results[1]
    assert.ok(
      accepted.code === 0 || /league is busy|already accepted|no longer pending|Every team has accepted/i.test(accepted.error),
      `iteration ${index}: unexpected acceptance failure ${accepted.error}`,
    )
    assert.ok(
      retracted.code === 0 || /league is busy|Every team has accepted|You have not accepted/i.test(retracted.error),
      `iteration ${index}: unexpected retraction failure ${retracted.error}`,
    )
    await assertLegal(tradeId, `iteration ${index}`)()
    await one(`DELETE FROM trades WHERE id=${quote(tradeId)}`)
  }

  const reverseIterations = 24
  for (let index = 0; index < reverseIterations; index++) {
    const tradeId = await propose()
    const results = await race([
      `SELECT public.retract_trade_acceptance_atomic(${quote(tradeId)},${quote(members[0])},${quote(users[0])});`,
      `SELECT public.accept_trade_atomic(${quote(tradeId)},${quote(members[1])});`,
    ])
    const retracted = results[0]
    const accepted = results[1]
    assert.ok(
      retracted.code === 0 || /league is busy|Every team has accepted|You have not accepted/i.test(retracted.error),
      `reverse iteration ${index}: unexpected retraction failure ${retracted.error}`,
    )
    assert.ok(
      accepted.code === 0 || /league is busy|already accepted|no longer pending|Every team has accepted/i.test(accepted.error),
      `reverse iteration ${index}: unexpected acceptance failure ${accepted.error}`,
    )
    await assertLegal(tradeId, `reverse iteration ${index}`)()
    await one(`DELETE FROM trades WHERE id=${quote(tradeId)}`)
  }

  console.log(`PASS: ${iterations + reverseIterations} acceptance/retraction races end only in a unanimous accepted trade or a pending trade without a cleared unanimous acceptance`)
} finally {
  const cleanup = await query(`DELETE FROM leagues WHERE id=${quote(league)}; DELETE FROM trades WHERE league_id=${quote(league)}; DELETE FROM players WHERE id IN (${[p1, p2, p3].map(quote).join(',')}); DELETE FROM auth.users WHERE id IN (${users.map(quote).join(',')});`)
  assert.equal(cleanup.code, 0, cleanup.error)
}
