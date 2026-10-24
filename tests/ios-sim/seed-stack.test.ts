import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'vitest'
import { localUrl, run } from '../../scripts/ios-sim/common.mjs'
import { seed } from '../../scripts/ios-sim/seed.mjs'

const privateStack = process.env.IOS_SIM_PRIVATE_STACK

test.skipIf(!privateStack)('the private stack keeps existing fixtures and validates the pending trade roster plan', async () => {
  assert.ok(privateStack)
  const project = 'pancake_ios_harness_fixture'
  assert.match(await readFile(path.join(privateStack, 'supabase/config.toml'), 'utf8'), new RegExp(`project_id = "${project}"`))
  const status = JSON.parse(await run('supabase', ['status', '--workdir', privateStack, '-o', 'json']))
  localUrl(status.API_URL, 57621)
  const stack = { project, url: status.API_URL, anonKey: status.PUBLISHABLE_KEY ?? status.ANON_KEY, serviceKey: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY }
  const fixture = await seed({ stack, snapshot: process.cwd(), directory: path.join(privateStack, 'seed') })
  const sql = (statement: string) => run('docker', ['exec', `supabase_db_${project}`, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres', '--set', 'ON_ERROR_STOP=1', '-Atc', statement])
  const uuid = (value: string) => { assert.match(value, /^[a-f0-9-]{36}$/); return `'${value}'` }
  const trade = fixture.rosterPlanTrade
  assert.ok(trade)
  assert.deepEqual(fixture.users.map((user: { email: string }) => user.email), Array.from({ length: 10 }, (_, index) => `pancake-e2e-iossim2027-${index + 1}@example.com`))
  assert.equal(fixture.password, 'Pancake-e2e-iossim2027!')
  const league = uuid(fixture.leagueId), season = uuid(fixture.seasonId), id = uuid(trade.id)
  assert.equal(await sql(`SELECT allow_inactive_trades FROM leagues WHERE id=${league}`), 't')
  assert.equal(await sql(`SELECT count(*) FROM trades WHERE league_id=${league} AND status='pending'`), '6')
  assert.equal(await sql(`SELECT count(*) FROM players WHERE sportsdata_id LIKE 'ios-sim-%'`), '260')
  const rosters = await sql(`SELECT count(*), count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi), count(*) FILTER (WHERE is_on_ir), count(*) FILTER (WHERE is_on_taxi) FROM roster_players WHERE league_season_id=${season} GROUP BY member_id`)
  assert.equal(rosters.split('\n').length, 10)
  assert.ok(rosters.split('\n').every((row: string) => row === '22|20|1|1'))
  assert.equal(await sql(`SELECT private.taxi_player_eligible(${league},${uuid(trade.rookiePlayerId)})`), 't')
  await assert.rejects(sql(`SELECT private.validate_trade_rosters(${id})`), /active roster limit/)
  const member = fixture.members[trade.manager]
  await sql(`BEGIN; SELECT public.set_trade_roster_plan_atomic(${id},${uuid(member.id)},${uuid(member.user_id)},ARRAY[${uuid(trade.rookiePlayerId)}]::uuid[],ARRAY[]::uuid[],ARRAY[${uuid(trade.dropPlayerId)}]::uuid[]); SELECT private.validate_trade_rosters(${id}); ROLLBACK;`)
  assert.equal(await sql(`SELECT status FROM trades WHERE id=${id}`), 'pending')
  const legacy = { ...fixture }
  delete legacy.rosterPlanTrade
  await writeFile(path.join(privateStack, 'seed/complete.json'), JSON.stringify(legacy))
  const upgraded = await seed({ stack, snapshot: process.cwd(), directory: path.join(privateStack, 'seed') })
  assert.deepEqual(upgraded, fixture)
  assert.equal(await sql(`SELECT count(*) FROM trades WHERE league_id=${league} AND status='pending'`), '6')
  assert.deepEqual(await seed({ stack, snapshot: process.cwd(), directory: path.join(privateStack, 'seed') }), fixture)
}, 180000)
