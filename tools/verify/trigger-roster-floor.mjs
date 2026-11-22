#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '')
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(!run.cleanedAt, 'Trigger before cleanup')
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
assert.match(new URL(env.E2E_SUPABASE_URL).hostname, /^(127\.0\.0\.1|localhost)$/)
const functionsEnv = await readFile(path.join(dir, 'functions.env'), 'utf8')
const token = functionsEnv
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.startsWith('PANCAKE_EDGE_INTERNAL_TOKEN='))
  .map((line) => line.slice('PANCAKE_EDGE_INTERNAL_TOKEN='.length))[0]
assert.ok(token, 'functions.env must contain the generated internal token')

const q = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = (statement) =>
  execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
const json = (statement) => JSON.parse(sql(statement))
const counts = () => json(`
  SELECT json_build_object(
    'awards', (SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${q(fixture.leagueId)}),
    'transactions', (SELECT count(*) FROM roster_transactions
      WHERE league_id = ${q(fixture.leagueId)} AND transaction_type = 'fa_add'),
    'rosterPlayers', (SELECT count(*) FROM roster_players WHERE league_id = ${q(fixture.leagueId)}),
    'leagues', (SELECT coalesce(json_agg(json_build_object(
        'leagueId', league.id,
        'rosterPlayers', (SELECT count(*) FROM roster_players roster WHERE roster.league_id = league.id),
        'faAddTransactions', (SELECT count(*) FROM roster_transactions transaction
          WHERE transaction.league_id = league.id AND transaction.transaction_type = 'fa_add'))
      ORDER BY league.id), '[]'::json)
      FROM leagues league))
  FROM (SELECT 1) seed;`)
const delta = (before, after) => ({
  awards: after.awards - before.awards,
  transactions: after.transactions - before.transactions,
  rosterPlayers: after.rosterPlayers - before.rosterPlayers,
  leagues: after.leagues.map((entry) => {
    const prior = before.leagues.find((row) => row.leagueId === entry.leagueId) ?? { rosterPlayers: 0, faAddTransactions: 0 }
    return {
      leagueId: entry.leagueId,
      rosterPlayers: entry.rosterPlayers - prior.rosterPlayers,
      faAddTransactions: entry.faAddTransactions - prior.faAddTransactions,
    }
  }),
})

const before = counts()
const response = await fetch(`${env.E2E_SUPABASE_URL}/functions/v1/process-waivers`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-internal-function-token': token,
    'x-request-id': `verify-roster-floor-${Date.now()}`,
  },
  body: JSON.stringify({}),
})
const text = await response.text()
let payload
try { payload = JSON.parse(text) } catch { payload = { raw: text } }
const after = counts()

const state = json(`
  SELECT json_build_object(
    'week', (SELECT json_build_object('weekNumber', week.week_number, 'weekEnd', week.week_end,
        'status', week.status, 'teamOrder', week.team_order)
      FROM private.roster_floor_weeks week WHERE week.league_id = ${q(fixture.leagueId)} ORDER BY week.week_number DESC LIMIT 1),
    'awards', (SELECT count(*) FROM private.roster_floor_awards WHERE league_id = ${q(fixture.leagueId)}),
    'teams', (SELECT json_agg(json_build_object('teamName', member.team_name, 'active', counts.active) ORDER BY member.team_name)
      FROM league_members member
      CROSS JOIN LATERAL (SELECT count(*) AS active FROM roster_players roster
        WHERE roster.league_id = member.league_id
          AND roster.league_season_id = (SELECT season.id FROM league_seasons season
            WHERE season.league_id = member.league_id AND season.is_current)
          AND roster.member_id = member.id AND NOT roster.is_on_ir AND NOT roster.is_on_taxi) counts
      WHERE member.league_id = ${q(fixture.leagueId)}))
  FROM (SELECT 1) seed;`)

console.log(JSON.stringify({ status: response.status, ok: response.ok, response: payload, before, after, delta: delta(before, after), state }, null, 2))
if (!response.ok) process.exitCode = 1
if (response.ok && state.week?.status !== 'completed') {
  console.error(`Roster floor did not complete: ${JSON.stringify(payload)}`)
  process.exitCode = 1
}
