import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const url = process.env.SUPABASE_DB_URL
assert(url && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Use an isolated local database')
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

const race = (statements) => Promise.all(statements.map((statement) =>
  query(`BEGIN; SET LOCAL statement_timeout='20s'; ${statement} SELECT pg_sleep(0.25); COMMIT;`)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const setup = async (year) => {
  const league = randomUUID()
  const season = randomUUID()
  const user = randomUUID()
  const member = randomUUID()
  const healthy = randomUUID()
  const injured = randomUUID()
  const healthyRoster = randomUUID()
  const injuredRoster = randomUUID()
  await one(`BEGIN;
    INSERT INTO auth.users(id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES(${quote(user)},'authenticated','authenticated',${quote(user + '@example.test')},'x',now(),'{}','{}',now(),now());
    INSERT INTO leagues(id,name,slug,commissioner_id,status,roster_size,ir_slots,taxi_slots)
      VALUES(${quote(league)},'Auto IR race',${quote(league)},${quote(user)},'active',1,1,0);
    INSERT INTO league_seasons(id,league_id,season_year,is_current) VALUES(${quote(season)},${quote(league)},${year},true);
    INSERT INTO league_members(id,league_id,user_id,role,team_name)
      VALUES(${quote(member)},${quote(league)},${quote(user)},'commissioner','Race team');
    INSERT INTO lineup_optimizer_settings(league_id,league_season_id,member_id,enabled)
      VALUES(${quote(league)},${quote(season)},${quote(member)},true)
      ON CONFLICT ON CONSTRAINT lineup_optimizer_settings_pkey DO UPDATE SET enabled=true;
    INSERT INTO players(id,first_name,last_name,position,eligible_positions,injury_status,injury_expected_return) VALUES
      (${quote(healthy)},'Race','Healthy','PG',ARRAY['PG'],'Healthy','unknown'),
      (${quote(injured)},'Race','Injured','PG',ARRAY['PG'],'Out','2026-12-01');
    INSERT INTO roster_players(id,league_id,league_season_id,member_id,player_id,acquired_via,is_on_ir) VALUES
      (${quote(healthyRoster)},${quote(league)},${quote(season)},${quote(member)},${quote(healthy)},'draft',true),
      (${quote(injuredRoster)},${quote(league)},${quote(season)},${quote(member)},${quote(injured)},'draft',false);
    COMMIT;`)
  return { league, season, user, member, healthy, injured, healthyRoster, injuredRoster }
}

const assertLegal = async (fixture) => {
  const counts = JSON.parse(await one(`SELECT jsonb_build_object(
    'ir', count(*) FILTER (WHERE is_on_ir),
    'active', count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi),
    'taxi', count(*) FILTER (WHERE is_on_taxi),
    'both', count(*) FILTER (WHERE is_on_ir AND is_on_taxi),
    'rows', count(*))
    FROM roster_players WHERE member_id=${quote(fixture.member)}`))
  assert.ok(counts.ir <= 1, `IR over capacity: ${JSON.stringify(counts)}`)
  assert.ok(counts.active <= 1, `Active over capacity: ${JSON.stringify(counts)}`)
  assert.equal(counts.taxi, 0, `Taxi changed: ${JSON.stringify(counts)}`)
  assert.equal(counts.both, 0, `Player on IR and taxi: ${JSON.stringify(counts)}`)
  assert.equal(counts.rows, 2, `Roster membership changed: ${JSON.stringify(counts)}`)
  const transactions = JSON.parse(await one(`SELECT jsonb_build_object(
    'designate', count(*) FILTER (WHERE transaction_type='ir_designate'),
    'return', count(*) FILTER (WHERE transaction_type='ir_return'))
    FROM roster_transactions WHERE member_id=${quote(fixture.member)}`))
  const injuredOnIr = await one(`SELECT is_on_ir FROM roster_players WHERE id=${quote(fixture.injuredRoster)}`)
  const healthyOnIr = await one(`SELECT is_on_ir FROM roster_players WHERE id=${quote(fixture.healthyRoster)}`)
  assert.notEqual(injuredOnIr, healthyOnIr, 'Exactly one of the two players must be on IR')
  if (injuredOnIr === 't') {
    assert.equal(transactions.designate, 1, `Expected one designate: ${JSON.stringify(transactions)}`)
    assert.equal(transactions.return, 1, `Expected one return: ${JSON.stringify(transactions)}`)
  } else {
    assert.equal(transactions.designate, 0, `Unexpected designate: ${JSON.stringify(transactions)}`)
    assert.equal(transactions.return, 0, `Unexpected return: ${JSON.stringify(transactions)}`)
  }
}

try {
  const overflow = await setup(9701)
  const overflowRace = await race([
    `SELECT public.auto_manage_ir_service(${quote(overflow.league)},${quote(overflow.season)},${quote(overflow.member)});`,
    `SELECT set_config('request.jwt.claim.sub',${quote(overflow.user)},true);
     SELECT public.activate_roster_player_with_overflow_atomic(
       ${quote(overflow.healthyRoster)},'ir',${quote(overflow.injuredRoster)},'ir');`,
  ])
  assert.ok(overflowRace.some((result) => result.code === 0), JSON.stringify(overflowRace))
  assert.ok(overflowRace.every((result) => result.code === 0 ||
    /no longer on IR|IR slot|active roster is full|league is busy|roster changed/i.test(result.error)), JSON.stringify(overflowRace))
  await assertLegal(overflow)

  const toggle = await setup(9702)
  const toggleRace = await race([
    `SELECT public.auto_manage_ir_service(${quote(toggle.league)},${quote(toggle.season)},${quote(toggle.member)});`,
    `SELECT set_config('request.jwt.claim.sub',${quote(toggle.user)},true);
     SELECT public.toggle_ir_atomic(${quote(toggle.injuredRoster)},true,${quote(toggle.user)});`,
  ])
  assert.ok(toggleRace.some((result) => result.code === 0), JSON.stringify(toggleRace))
  assert.ok(toggleRace.every((result) => result.code === 0 ||
    /IR slot|active roster is full|league is busy|roster changed/i.test(result.error)), JSON.stringify(toggleRace))
  await assertLegal(toggle)

  const disabled = await setup(9703)
  const lock = query(`BEGIN; SELECT pg_advisory_xact_lock(hashtext(${quote(disabled.league)}), hashtext(${quote(disabled.member)})); SELECT pg_sleep(1.5); COMMIT;`)
  await sleep(300)
  const queued = query(`SELECT public.auto_manage_ir_service(${quote(disabled.league)},${quote(disabled.season)},${quote(disabled.member)})`)
  await sleep(300)
  await one(`UPDATE lineup_optimizer_settings SET enabled=false
    WHERE league_id=${quote(disabled.league)} AND league_season_id=${quote(disabled.season)} AND member_id=${quote(disabled.member)}`)
  const [lockResult, queuedResult] = await Promise.all([lock, queued])
  assert.equal(lockResult.code, 0, lockResult.error)
  assert.equal(queuedResult.code, 0, queuedResult.error)
  const disabledOutcome = JSON.parse(queuedResult.output)
  assert.equal(disabledOutcome.moves.length, 0, `Disabled queued call moved: ${queuedResult.output}`)
  assert.equal(disabledOutcome.skipped.length, 0, `Disabled queued call skipped: ${queuedResult.output}`)
  assert.equal(disabledOutcome.notices.length, 0, `Disabled queued call noticed: ${queuedResult.output}`)
  const disabledCounts = JSON.parse(await one(`SELECT jsonb_build_object(
    'ir', count(*) FILTER (WHERE is_on_ir),
    'active', count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi),
    'rows', count(*))
    FROM roster_players WHERE member_id=${quote(disabled.member)}`))
  assert.equal(disabledCounts.ir, 1, `Disabled queued call changed IR: ${JSON.stringify(disabledCounts)}`)
  assert.equal(disabledCounts.active, 1, `Disabled queued call changed active: ${JSON.stringify(disabledCounts)}`)
  assert.equal(disabledCounts.rows, 2, `Disabled queued call changed membership: ${JSON.stringify(disabledCounts)}`)
  assert.equal(await one(`SELECT count(*) FROM roster_transactions WHERE member_id=${quote(disabled.member)}`), '0',
    'Disabled queued call wrote transactions')
  assert.equal(await one(`SELECT is_on_ir FROM roster_players WHERE id=${quote(disabled.healthyRoster)}`), 't',
    'Disabled queued call moved the healthy occupant')
  assert.equal(await one(`SELECT is_on_ir FROM roster_players WHERE id=${quote(disabled.injuredRoster)}`), 'f',
    'Disabled queued call moved the injured player')

  const enabled = await setup(9704)
  const enabledResult = await query(`SELECT public.auto_manage_ir_service(${quote(enabled.league)},${quote(enabled.season)},${quote(enabled.member)})`)
  assert.equal(enabledResult.code, 0, enabledResult.error)
  assert.equal(JSON.parse(enabledResult.output).moves.length, 1, `Enabled call did not move: ${enabledResult.output}`)
  await assertLegal(enabled)

  console.log('auto-manage-ir concurrency: pass')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
