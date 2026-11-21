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
const caseName = flag('case', 'three-team')
assert.ok(['three-team', 'overlapping', 'waiver-before-hold', 'free-agent-pool'].includes(caseName), '--case=three-team|overlapping|waiver-before-hold|free-agent-pool')
assert.equal(new Set([proposerTeam, middleTeam, fullTeam]).size, 3, 'Use three different teams')

const q = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = (statement) =>
  execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()

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
sql(`UPDATE trades SET status='withdrawn' WHERE league_id=${q(ctx.leagueId)} AND status IN ('pending','accepted');`)

const freePlayers = (memberId, limit) => `
  SELECT player.id
    FROM players player
   WHERE NOT EXISTS (
     SELECT 1 FROM roster_players roster
      WHERE roster.league_id = ${q(ctx.leagueId)}
        AND roster.league_season_id = ${q(ctx.seasonId)}
        AND roster.player_id = player.id)
     AND NOT private.is_reserved_trade_asset(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(memberId)}, player.id)
   ORDER BY player.id
   LIMIT ${limit}`

const fillRoster = (memberId, target) => sql(`
  WITH free_players AS (${freePlayers(memberId, 50)}),
  current AS (
    SELECT count(*)::int AS held
      FROM roster_players
     WHERE league_id = ${q(ctx.leagueId)}
       AND league_season_id = ${q(ctx.seasonId)}
       AND member_id = ${q(memberId)}
       AND NOT is_on_ir AND NOT is_on_taxi)
  INSERT INTO roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  SELECT ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(memberId)}, id, 'verification'
    FROM free_players
   LIMIT GREATEST(0, ${target} - (SELECT held FROM current));`)

const held = (memberId) => Number(sql(`SELECT count(*) FROM roster_players
  WHERE league_id = ${q(ctx.leagueId)}
    AND league_season_id = ${q(ctx.seasonId)}
    AND member_id = ${q(memberId)};`))

const freeOn = (memberId, exclude = null) => `
  SELECT roster.player_id
    FROM roster_players roster
   WHERE roster.league_id = ${q(ctx.leagueId)}
     AND roster.league_season_id = ${q(ctx.seasonId)}
     AND roster.member_id = ${q(memberId)}
     AND NOT roster.is_on_ir AND NOT roster.is_on_taxi
     AND NOT private.is_reserved_trade_asset(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(memberId)}, roster.player_id)
     ${exclude ? `AND roster.player_id <> ${q(exclude)}` : ''}
   ORDER BY roster.player_id
   LIMIT 1`

const summary = (extra) => {
  console.log(JSON.stringify({
    case: caseName,
    leagueId: ctx.leagueId,
    seasonId: ctx.seasonId,
    rosterSize: Number(sql(`SELECT roster_size FROM leagues WHERE id = ${q(ctx.leagueId)};`)),
    proposerTeam,
    middleTeam,
    fullTeam,
    fullRosterCount: held(ctx.full.memberId),
    ...extra,
  }))
}

if (caseName === 'free-agent-pool') {
  const pool = sql(`SELECT count(*) FROM (${freePlayers(ctx.proposer.memberId, 25)}) pool;`)
  summary({ freeAgentPool: Number(pool) })
  console.log('Next: open the waiver wire and confirm the free agent pool is visible.')
} else if (caseName === 'three-team') {
  fillRoster(ctx.full.memberId, Number(sql(`SELECT roster_size FROM leagues WHERE id = ${q(ctx.leagueId)};`)))
  const incoming = sql(freeOn(ctx.proposer.memberId))
  assert.ok(incoming, `${proposerTeam} needs one unlocked roster player`)
  const items = [
    { fromMemberId: ctx.proposer.memberId, toMemberId: ctx.full.memberId, playerId: incoming },
    { fromMemberId: ctx.full.memberId, toMemberId: ctx.middle.memberId, faabAmount: 5 },
    { fromMemberId: ctx.middle.memberId, toMemberId: ctx.proposer.memberId, faabAmount: 5 },
  ]
  const tradeId = sql(`SELECT public.propose_multi_team_trade_atomic(
    ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.proposer.memberId)},
    ARRAY[${q(ctx.middle.memberId)}, ${q(ctx.full.memberId)}]::uuid[],
    ${q(JSON.stringify(items))}::jsonb);`)
  assert.ok(tradeId, 'Proposal must return a trade id')
  sql(`SELECT public.accept_trade_atomic(${q(tradeId)}, ${q(ctx.middle.memberId)});`)
  summary({ tradeId, acceptedBy: middleTeam, fullRosterCount: held(ctx.full.memberId) })
  console.log('Next: sign in as the full team, open the offer, and confirm the roster-hold warning names the accepted trade.')
} else if (caseName === 'overlapping') {
  const incomingOne = sql(freeOn(ctx.middle.memberId))
  assert.ok(incomingOne, `${proposerTeam} needs two unlocked roster players`)
  const first = sql(`SELECT public.propose_trade_atomic(
    ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.middle.memberId)}, ${q(ctx.proposer.memberId)},
    '{}'::uuid[], ARRAY[${q(incomingOne)}]::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);`)
  const incomingTwo = sql(freeOn(ctx.middle.memberId, incomingOne))
  assert.ok(incomingTwo, `${proposerTeam} needs two unlocked roster players`)
  const second = sql(`SELECT public.propose_trade_atomic(
    ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.middle.memberId)}, ${q(ctx.proposer.memberId)},
    '{}'::uuid[], ARRAY[${q(incomingTwo)}]::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);`)
  sql(`SELECT public.accept_trade_atomic(${q(first)}, ${q(ctx.proposer.memberId)});`)
  sql(`SELECT public.accept_trade_atomic(${q(second)}, ${q(ctx.proposer.memberId)});`)
  summary({ firstTradeId: first, secondTradeId: second, acceptedBy: proposerTeam })
  console.log('Next: confirm both offers show the same team accepted and neither hold adds to the other.')
} else {
  const rosterSize = Number(sql(`SELECT roster_size FROM leagues WHERE id = ${q(ctx.leagueId)};`))
  fillRoster(ctx.proposer.memberId, Math.max(0, rosterSize - 1))
  sql(`UPDATE waiver_claims SET status='cancelled', processed_at=now()
    WHERE league_id=${q(ctx.leagueId)} AND member_id=${q(ctx.proposer.memberId)} AND status='pending';`)
  const claimPlayer = sql(freePlayers(ctx.proposer.memberId, 1))
  assert.ok(claimPlayer, 'A free agent must be available for the claim')
  sql(`INSERT INTO waiver_wire_log(league_id, league_season_id, player_id, placed_on_waivers_at)
    VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(claimPlayer)}, now() - interval '5 days');`)
  const claimId = sql(`SELECT public.create_waiver_claim_atomic(
    ${q(ctx.leagueId)}, ${q(ctx.proposer.memberId)}, ${q(claimPlayer)}, NULL, ${q(ctx.proposer.userId)}, 0, 1);`)
  const incoming = sql(freeOn(ctx.middle.memberId))
  assert.ok(incoming, `${proposerTeam} needs one unlocked roster player`)
  const tradeId = sql(`SELECT public.propose_trade_atomic(
    ${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.proposer.memberId)}, ${q(ctx.middle.memberId)},
    '{}'::uuid[], ARRAY[${q(incoming)}]::uuid[], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);`)
  sql(`SELECT public.accept_trade_atomic(${q(tradeId)}, ${q(ctx.middle.memberId)});`)
  summary({ claimId, tradeId, claimPlayer, acceptedBy: proposerTeam })
  console.log('Next: run the waiver processor and confirm the claim fails cleanly with the roster-hold message.')
}
