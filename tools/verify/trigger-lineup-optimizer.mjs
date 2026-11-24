#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '')
const flag = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const mode = flag('mode', '')
const date = flag('date', '')
const tipoff = flag('tipoff', '')
const candidateInjury = flag('candidate-injury', '')
assert.ok(['', 'daily', 'pre_tipoff', 'roster_refill'].includes(mode), '--mode=daily|pre_tipoff|roster_refill')
assert.ok(!(mode && date), 'Choose --mode or --date, not both')
assert.ok(!(tipoff && mode !== 'pre_tipoff'), '--tipoff requires --mode=pre_tipoff')
assert.ok(['', 'healthy', 'out'].includes(candidateInjury), '--candidate-injury=healthy|out')
assert.ok(!(candidateInjury && mode !== 'pre_tipoff'), '--candidate-injury requires --mode=pre_tipoff')
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
const seed = await readFile(path.join(dir, 'auto-ir-seed.json'), 'utf8').then(JSON.parse, () => null)

const q = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = (statement) =>
  execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
const json = (statement) => JSON.parse(sql(statement))

let body = mode ? { mode } : date ? { date } : {}
let dispatch = null
if (mode === 'daily') {
  body = { mode, date: date || sql("SELECT (now() AT TIME ZONE 'America/New_York')::date") }
}
if (mode === 'pre_tipoff') {
  const tipoffAt = tipoff || sql("SELECT to_char((clock_timestamp() + interval '60 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")
  const gameDate = sql(`SELECT (${q(tipoffAt)}::timestamptz AT TIME ZONE 'America/New_York')::date`)
  const today = sql("SELECT (now() AT TIME ZONE 'America/New_York')::date")
  assert.equal(gameDate, today, `Tipoff ${tipoffAt} is ${gameDate} in the Eastern league day, not today (${today})`)
  const policy = json(`
    SELECT json_build_object(
      'active', coalesce((SELECT auto_ir_all_members AND ir_activated_at IS NOT NULL
        FROM private.league_roster_policies WHERE league_id = ${q(fixture.leagueId)}), false),
      'seasonYear', (SELECT season_year FROM league_seasons WHERE league_id = ${q(fixture.leagueId)} AND is_current),
      'weekNumber', coalesce((SELECT week.week_number FROM season_weeks week
        WHERE week.season_year = (SELECT season_year FROM league_seasons WHERE league_id = ${q(fixture.leagueId)} AND is_current)
          AND week.week_start <= ${q(gameDate)}::date AND week.week_end >= ${q(gameDate)}::date
        ORDER BY week.week_number LIMIT 1), 1),
      'memberId', (SELECT id FROM league_members WHERE league_id = ${q(fixture.leagueId)} AND team_name = 'E2E Team 1'),
      'seasonId', (SELECT id FROM league_seasons WHERE league_id = ${q(fixture.leagueId)} AND is_current))`)
  assert.ok(policy.seasonYear, 'Fixture league needs a current season')
  assert.ok(policy.memberId, 'Fixture league needs E2E Team 1')
  const scope = policy.active ? fixture.leagueId : ''
  const claim = randomUUID()
  if (candidateInjury) {
    const candidate = seed?.involved?.find((entry) => entry.role === 'candidate')
    assert.ok(candidate, '--candidate-injury needs auto-ir-seed.json with a candidate')
    const injury = candidateInjury === 'out'
      ? `injury_status = 'Out', injury_expected_return = to_char((now() AT TIME ZONE 'America/New_York')::date + 14, 'YYYY-MM-DD')`
      : `injury_status = NULL, injury_expected_return = 'unknown'`
    sql(`UPDATE public.players SET ${injury} WHERE id = ${q(candidate.playerId)}`)
  }
  sql(`DELETE FROM public.nba_games WHERE nba_game_id LIKE 'verify-auto-ir-tipoff-%';
    INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    SELECT 'verify-auto-ir-tipoff-' || team, ${policy.seasonYear}, ${policy.weekNumber}, ${q(gameDate)}::date, ${q(tipoffAt)}::timestamptz,
      team, CASE WHEN team = 'ZZZ' THEN 'ZZY' ELSE 'ZZZ' END, 'Scheduled'
    FROM (SELECT DISTINCT player.nba_team AS team
      FROM public.roster_players roster JOIN public.players player ON player.id = roster.player_id
      WHERE roster.league_id = ${q(fixture.leagueId)} AND roster.league_season_id = ${q(policy.seasonId)}
        AND roster.member_id = ${q(policy.memberId)} AND player.nba_team IS NOT NULL) teams;
    INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    SELECT 'verify-auto-ir-tipoff-AAA', ${policy.seasonYear}, ${policy.weekNumber}, ${q(gameDate)}::date, ${q(tipoffAt)}::timestamptz,
      'AAA', 'BBB', 'Scheduled'
    WHERE NOT EXISTS (SELECT 1 FROM public.nba_games WHERE nba_game_id LIKE 'verify-auto-ir-tipoff-%');
    INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_revision)
    VALUES (${q(tipoffAt)}::timestamptz, ${q(scope)}, ${q(gameDate)}::date, ${q(claim)}, 'queued', now() + interval '2 minutes', 0)
    ON CONFLICT (tipoff_at, scope) DO UPDATE SET status = 'queued', token = EXCLUDED.token,
      lease_until = EXCLUDED.lease_until, error = NULL, finished_at = NULL, game_date = EXCLUDED.game_date;`)
  dispatch = json(`
    SELECT json_build_object('scope', scope, 'status', status, 'tokenMatches', token = ${q(claim)},
      'gameDate', game_date, 'leaseUntil', lease_until)
    FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${q(tipoffAt)}::timestamptz AND scope = ${q(scope)}`)
  body = { mode, tipoffAt, token: claim, ...(scope ? { leagueId: scope } : {}) }
}

const response = await fetch(`${env.E2E_SUPABASE_URL}/functions/v1/lineup-optimizer`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-internal-function-token': token,
    'x-request-id': `verify-auto-ir-${Date.now()}`,
  },
  body: JSON.stringify(body),
})
const text = await response.text()
let payload
try { payload = JSON.parse(text) } catch { payload = { raw: text } }
const request = { ...body }
delete request.token
const result = { status: response.status, ok: response.ok, request, response: payload }
if (dispatch) {
  const tipoffAt = body.tipoffAt
  const scope = dispatch.scope
  result.dispatch = dispatch
  result.stored = json(`
    SELECT json_build_object(
      'dispatch', (SELECT json_build_object('scope', scope, 'status', status, 'tokenMatches', token = ${q(body.token)},
          'error', error, 'finishedAt', finished_at)
        FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${q(tipoffAt)}::timestamptz AND scope = ${q(scope)}),
      'dispatches', (SELECT coalesce(json_agg(json_build_object('scope', scope, 'status', status, 'tokenMatches', token = ${q(body.token)})
          ORDER BY scope), '[]'::json)
        FROM public.lineup_tipoff_dispatches WHERE tipoff_at = ${q(tipoffAt)}::timestamptz),
      'members', (SELECT coalesce(json_agg(json_build_object('leagueId', league_id, 'memberId', member_id,
          'inputRevision', input_revision, 'error', error) ORDER BY member_id), '[]'::json)
        FROM public.lineup_tipoff_members WHERE tipoff_at = ${q(tipoffAt)}::timestamptz AND scope = ${q(scope)}),
      'rosterTransactions', (SELECT coalesce(json_agg(json_build_object('playerId', player_id, 'transactionType', transaction_type,
          'occurredAt', occurred_at) ORDER BY occurred_at), '[]'::json)
        FROM public.roster_transactions WHERE league_id = ${q(fixture.leagueId)}
          AND league_season_id = (SELECT id FROM league_seasons WHERE league_id = ${q(fixture.leagueId)} AND is_current)
          AND member_id = (SELECT id FROM league_members WHERE league_id = ${q(fixture.leagueId)} AND team_name = 'E2E Team 1')
          AND transaction_type IN ('ir_designate', 'ir_return')
          AND occurred_at > now() - interval '10 minutes'),
      'lineup', (SELECT coalesce(json_agg(json_build_object('playerId', player_id, 'slotType', slot_type, 'isAutoSet', is_auto_set)
          ORDER BY slot_type, player_id), '[]'::json)
        FROM public.weekly_lineups WHERE league_id = ${q(fixture.leagueId)}
          AND league_season_id = (SELECT id FROM league_seasons WHERE league_id = ${q(fixture.leagueId)} AND is_current)
          AND member_id = (SELECT id FROM league_members WHERE league_id = ${q(fixture.leagueId)} AND team_name = 'E2E Team 1')
          AND game_date = ${q(dispatch.gameDate)}::date),
      'ir', (SELECT coalesce(json_agg(json_build_object('playerId', player_id, 'isOnIr', is_on_ir) ORDER BY player_id), '[]'::json)
        FROM public.roster_players WHERE league_id = ${q(fixture.leagueId)}
          AND league_season_id = (SELECT id FROM league_seasons WHERE league_id = ${q(fixture.leagueId)} AND is_current)
          AND member_id = (SELECT id FROM league_members WHERE league_id = ${q(fixture.leagueId)} AND team_name = 'E2E Team 1')))`)
}
console.log(JSON.stringify(result, null, 2))
if (!response.ok) process.exitCode = 1
if (result.stored?.dispatch?.status !== undefined && result.stored.dispatch.status !== 'succeeded') {
  console.error(`Tipoff dispatch did not succeed: ${JSON.stringify(result.stored.dispatch)}`)
  process.exitCode = 1
}
