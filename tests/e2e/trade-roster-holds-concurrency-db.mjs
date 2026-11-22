import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
const [league, season, p1, p2, p3, ...rest] = Array.from({ length: 9 }, () => randomUUID())
const users = rest.slice(0, 2)
const members = rest.slice(2, 4)
const sharedLeague = randomUUID()
const sharedSeason = randomUUID()
const sharedUsers = Array.from({ length: 3 }, () => randomUUID())
const sharedMembers = Array.from({ length: 3 }, () => randomUUID())
const [sx, sy, sz, su, sv] = Array.from({ length: 5 }, () => randomUUID())
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

  await one(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      SELECT id::uuid,'authenticated','authenticated',id||'@example.test','x',now(),'{}','{}',now(),now() FROM unnest(ARRAY[${sharedUsers.map(quote).join(',')}]) id;
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots,trade_veto_mode,allow_inactive_trades)
      VALUES(${quote(sharedLeague)},'Shared race',${quote(sharedLeague)},${quote(sharedUsers[0])},'active',2,0,0,'disabled',true);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(sharedSeason)},${quote(sharedLeague)},9811,true);
    ${sharedMembers.map((id, index) => `INSERT INTO league_members(id,league_id,user_id,role,team_name) VALUES(${quote(id)},${quote(sharedLeague)},${quote(sharedUsers[index])},'${index === 0 ? 'commissioner' : 'manager'}','Shared race team ${index + 1}');`).join('\n')}
    INSERT INTO players(id,first_name,last_name,position,eligible_positions)
      VALUES(${quote(sx)},'Shared','X','PG',ARRAY['PG']),(${quote(sy)},'Shared','Y','PG',ARRAY['PG']),(${quote(sz)},'Shared','Z','PG',ARRAY['PG']),(${quote(su)},'Shared','U','PG',ARRAY['PG']),(${quote(sv)},'Shared','V','PG',ARRAY['PG']);
    INSERT INTO roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
      VALUES(${quote(sharedLeague)},${quote(sharedSeason)},${quote(sharedMembers[0])},${quote(sx)},'verification'),
            (${quote(sharedLeague)},${quote(sharedSeason)},${quote(sharedMembers[1])},${quote(sy)},'verification'),
            (${quote(sharedLeague)},${quote(sharedSeason)},${quote(sharedMembers[1])},${quote(sz)},'verification'),
            (${quote(sharedLeague)},${quote(sharedSeason)},${quote(sharedMembers[2])},${quote(su)},'verification'),
            (${quote(sharedLeague)},${quote(sharedSeason)},${quote(sharedMembers[2])},${quote(sv)},'verification');
    COMMIT;`)

  const proposeShared = (to, request) => one(`SELECT public.propose_trade_atomic(${quote(sharedLeague)},${quote(sharedSeason)},${quote(sharedMembers[0])},${quote(to)},
    ARRAY[${quote(sx)}]::uuid[], ARRAY[${request.map(quote).join(',')}]::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 0, 0)`)

  const assertSharedLegal = async (t1, t2, label) => {
    const current = JSON.parse(await one(`SELECT json_build_object(
      'accepted', (SELECT count(*) FROM trades WHERE id IN (${quote(t1)},${quote(t2)}) AND status='accepted'),
      'over', (SELECT count(*) FROM league_members m WHERE m.league_id=${quote(sharedLeague)} AND (
        (SELECT count(*) FROM roster_players r WHERE r.league_id=${quote(sharedLeague)} AND r.member_id=m.id AND NOT r.is_on_ir AND NOT r.is_on_taxi)
        + (SELECT count(*) FROM trade_items i JOIN trades t ON t.id=i.trade_id WHERE t.league_id=${quote(sharedLeague)} AND t.status='accepted' AND i.to_member_id=m.id AND i.player_id IS NOT NULL)
        - (SELECT count(*) FROM trade_items i JOIN trades t ON t.id=i.trade_id WHERE t.league_id=${quote(sharedLeague)} AND t.status='accepted' AND i.from_member_id=m.id AND i.player_id IS NOT NULL)
      ) > 2))`))
    assert.ok(current.accepted <= 1, `${label}: two accepted trades move the shared player`)
    assert.equal(current.over, 0, `${label}: an accepted trade leaves a roster over the limit`)
  }

  const sharedIterations = 12
  for (let index = 0; index < sharedIterations; index++) {
    const t1 = await proposeShared(sharedMembers[1], [sy, sz])
    const t2 = await proposeShared(sharedMembers[2], [su, sv])
    const results = await race([
      `SELECT public.accept_trade_atomic(${quote(t1)},${quote(sharedMembers[1])});`,
      `SELECT public.retract_trade_acceptance_atomic(${quote(t2)},${quote(sharedMembers[0])},${quote(sharedUsers[0])});`,
    ])
    assert.ok(
      results[0].code === 0 || /league is busy|already accepted|no longer pending|Every team has accepted|needs the roster spot/i.test(results[0].error),
      `shared retract iteration ${index}: unexpected acceptance failure ${results[0].error}`,
    )
    assert.ok(
      results[1].code === 0 || /league is busy|Every team has accepted|You have not accepted|no longer pending/i.test(results[1].error),
      `shared retract iteration ${index}: unexpected retraction failure ${results[1].error}`,
    )
    await assertSharedLegal(t1, t2, `shared retract iteration ${index}`)
    await one(`DELETE FROM trades WHERE id IN (${quote(t1)},${quote(t2)})`)
  }

  for (let index = 0; index < sharedIterations; index++) {
    const t1 = await proposeShared(sharedMembers[1], [sy, sz])
    const t2 = await proposeShared(sharedMembers[2], [su, sv])
    const results = await race([
      `SELECT public.accept_trade_atomic(${quote(t1)},${quote(sharedMembers[1])});`,
      `SELECT public.accept_trade_atomic(${quote(t2)},${quote(sharedMembers[2])});`,
    ])
    assert.ok(
      results[0].code === 0 || /league is busy|already accepted|no longer pending|Every team has accepted|needs the roster spot/i.test(results[0].error),
      `shared accept iteration ${index}: unexpected first acceptance failure ${results[0].error}`,
    )
    assert.ok(
      results[1].code === 0 || /league is busy|already accepted|no longer pending|Every team has accepted|needs the roster spot/i.test(results[1].error),
      `shared accept iteration ${index}: unexpected second acceptance failure ${results[1].error}`,
    )
    await assertSharedLegal(t1, t2, `shared accept iteration ${index}`)
    await one(`DELETE FROM trades WHERE id IN (${quote(t1)},${quote(t2)})`)
  }

  console.log(`PASS: ${iterations + reverseIterations} acceptance/retraction races end only in a unanimous accepted trade or a pending trade without a cleared unanimous acceptance; ${sharedIterations * 2} shared-asset races never accept two trades moving the same player or leave a roster over the limit`)
} finally {
  const cleanup = await query(`DELETE FROM leagues WHERE id IN (${quote(league)},${quote(sharedLeague)}); DELETE FROM trades WHERE league_id IN (${quote(league)},${quote(sharedLeague)}); DELETE FROM players WHERE id IN (${[p1, p2, p3, sx, sy, sz, su, sv].map(quote).join(',')}); DELETE FROM auth.users WHERE id IN (${[...users, ...sharedUsers].map(quote).join(',')});`)
  assert.equal(cleanup.code, 0, cleanup.error)
}
