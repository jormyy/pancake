#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '')
const flag = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(!run.cleanedAt, 'Seed before cleanup')
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
assert.match(new URL(env.SUPABASE_DB_URL).hostname, /^(127\.0\.0\.1|localhost)$/)

const proposerTeam = flag('proposer', fixture.proposerTeamName)
const middleTeam = flag('middle', fixture.recipientTeamName)
const fullTeam = flag('full', 'E2E Team 3')
const mode = flag('mode', 'net-plus-one')
const plan = flag('plan', 'drop')
assert.ok(['net-plus-one', 'net-neutral'].includes(mode), '--mode=net-plus-one|net-neutral')
assert.ok(['drop', 'none'].includes(plan), '--plan=drop|none')
assert.equal(new Set([proposerTeam, middleTeam, fullTeam]).size, 3, 'Use three different teams')

const q = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = (statement) => {
  const output = execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
  return output
}

const context = sql(`
  SELECT json_build_object(
    'leagueId', league.id,
    'seasonId', season.id,
    'rosterSize', league.roster_size,
    'proposer', json_build_object('memberId', proposer_member.id, 'userId', proposer_member.user_id),
    'middle', json_build_object('memberId', middle_member.id, 'userId', middle_member.user_id),
    'full', json_build_object('memberId', full_member.id, 'userId', full_member.user_id))
  FROM leagues league
  JOIN league_seasons season ON season.league_id = league.id AND season.is_current
  JOIN league_members proposer_member ON proposer_member.league_id = league.id AND proposer_member.team_name = ${q(proposerTeam)}
  JOIN league_members middle_member ON middle_member.league_id = league.id AND middle_member.team_name = ${q(middleTeam)}
  JOIN league_members full_member ON full_member.league_id = league.id AND full_member.team_name = ${q(fullTeam)}
  WHERE league.id = ${q(fixture.leagueId)};`)
assert.ok(context, 'Fixture league, current season and the three team names must exist')
const ctx = JSON.parse(context)

const fill = sql(`
  WITH free_players AS (
    SELECT player.id
      FROM players player
     WHERE NOT EXISTS (
       SELECT 1 FROM roster_players roster
        WHERE roster.league_id = ${q(ctx.leagueId)}
          AND roster.league_season_id = ${q(ctx.seasonId)}
          AND roster.player_id = player.id)
       AND NOT private.is_reserved_trade_asset(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.full.memberId)}, player.id)
     ORDER BY player.id
     LIMIT 50),
  current AS (
    SELECT count(*)::int AS held
      FROM roster_players
     WHERE league_id = ${q(ctx.leagueId)}
       AND league_season_id = ${q(ctx.seasonId)}
       AND member_id = ${q(ctx.full.memberId)}),
  added AS (
    INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    SELECT ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.full.memberId)}, id, 'verification'
      FROM free_players
     LIMIT GREATEST(0, ${ctx.rosterSize} - (SELECT held FROM current))
    RETURNING 1)
  SELECT json_build_object(
    'filled', (SELECT count(*) FROM added),
    'count', (SELECT count(*) FROM roster_players
               WHERE league_id = ${q(ctx.leagueId)}
                 AND league_season_id = ${q(ctx.seasonId)}
                 AND member_id = ${q(ctx.full.memberId)}));`)
const filled = JSON.parse(fill)
const limit = Math.max(1, filled.count)
sql(`UPDATE leagues SET roster_size = ${limit} WHERE id = ${q(ctx.leagueId)};`)
assert.equal(Number(sql(`SELECT roster_size FROM leagues WHERE id = ${q(ctx.leagueId)};`)), limit, 'Full team must sit exactly at the roster limit')

const freeOn = (memberId) => `
  SELECT roster.player_id
    FROM roster_players roster
   WHERE roster.league_id = ${q(ctx.leagueId)}
     AND roster.league_season_id = ${q(ctx.seasonId)}
     AND roster.member_id = ${q(memberId)}
     AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
     AND NOT private.is_reserved_trade_asset(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(memberId)}, roster.player_id)
   ORDER BY roster.player_id
   LIMIT 1`

const incoming = sql(freeOn(ctx.proposer.memberId))
assert.ok(incoming, `${proposerTeam} needs one unlocked roster player`)
const outgoing = mode === 'net-neutral' ? sql(freeOn(ctx.full.memberId)) : null
if (mode === 'net-neutral') assert.ok(outgoing, `${fullTeam} needs one unlocked roster player`)
const drop = plan === 'drop' ? sql(freeOn(ctx.full.memberId)) : null
if (plan === 'drop') assert.ok(drop, `${fullTeam} needs one unlocked player to drop`)

const items = [{ fromMemberId: ctx.proposer.memberId, toMemberId: ctx.full.memberId, playerId: incoming }]
if (outgoing) items.push({ fromMemberId: ctx.full.memberId, toMemberId: ctx.proposer.memberId, playerId: outgoing })
items.push({ fromMemberId: ctx.full.memberId, toMemberId: ctx.middle.memberId, faabAmount: 5 })
items.push({ fromMemberId: ctx.middle.memberId, toMemberId: ctx.proposer.memberId, faabAmount: 5 })

const tradeId = sql(`SELECT public.propose_multi_team_trade_atomic(
  ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.proposer.memberId)},
  ARRAY[${q(ctx.middle.memberId)}, ${q(ctx.full.memberId)}]::uuid[],
  ${q(JSON.stringify(items))}::jsonb);`)
assert.ok(tradeId, 'Proposal must return a trade id')

if (drop) {
  sql(`SELECT public.set_trade_roster_plan_atomic(
    ${q(tradeId)}, ${q(ctx.full.memberId)}, ${q(ctx.full.userId)},
    '{}'::uuid[], '{}'::uuid[], ARRAY[${q(drop)}]::uuid[]);`)
}

const summary = sql(`
  SELECT json_build_object(
    'tradeId', ${q(tradeId)},
    'leagueId', ${q(ctx.leagueId)},
    'seasonId', ${q(ctx.seasonId)},
    'rosterSize', (SELECT roster_size FROM leagues WHERE id = ${q(ctx.leagueId)}),
    'proposerTeam', ${q(proposerTeam)},
    'middleTeam', ${q(middleTeam)},
    'fullTeam', ${q(fullTeam)},
    'fullRosterCount', (SELECT count(*) FROM roster_players
      WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
        AND member_id = ${q(ctx.full.memberId)}),
    'mode', ${q(mode)},
    'plan', ${q(plan)},
    'items', (SELECT json_agg(json_build_object('fromMemberId', from_member_id,
      'toMemberId', to_member_id, 'playerId', player_id, 'faabAmount', faab_amount))
      FROM trade_items WHERE trade_id = ${q(tradeId)}),
    'fullPlanDropIds', (SELECT drop_player_ids FROM trade_participants
      WHERE trade_id = ${q(tradeId)} AND member_id = ${q(ctx.full.memberId)}));`)
console.log(summary)
console.log('Next: accept as the middle team, then the full team. Complete with SELECT public.process_due_accepted_trades_atomic();')
