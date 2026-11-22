#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const dir = path.resolve(process.argv[2] ?? '')
const flag = (name, fallback) => {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const cases = ['open-slot', 'bench-open-slot', 'starter-open-slot', 'full-bench-swap', 'no-legal-swap', 'swap-available', 'swap-locked', 'uncertain', 'locked', 'taxi-ineligible', 'incumbent-exchange', 'incumbent-tie', 'incumbent-boundary-tie', 'incumbent-unknown']
const caseName = flag('case', '')
assert.ok(cases.includes(caseName), `--case=${cases.join('|')}`)
const team = flag('team', 'E2E Team 1')
const autoLineup = flag('auto-lineup', 'on')
const leaguePolicy = flag('league-policy', 'off')
const starter = flag('starter', 'off')
const injury = flag('injury', 'out')
const locked = flag('locked', 'off')
assert.ok(['on', 'off'].includes(autoLineup), '--auto-lineup=on|off')
assert.ok(['on', 'off'].includes(leaguePolicy), '--league-policy=on|off')
assert.ok(['on', 'off'].includes(starter), '--starter=on|off')
assert.ok(['out', 'healthy'].includes(injury), '--injury=out|healthy')
assert.ok(['on', 'off'].includes(locked), '--locked=on|off')
assert.ok(injury === 'out' || caseName === 'open-slot', '--injury=healthy is only for --case=open-slot')
assert.ok(locked === 'off' || caseName === 'open-slot', '--locked=on is only for --case=open-slot')
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(!run.cleanedAt, 'Seed before cleanup')
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
assert.match(new URL(env.SUPABASE_DB_URL).hostname, /^(127\.0\.0\.1|localhost)$/)
assert.match(new URL(env.E2E_SUPABASE_URL).hostname, /^(127\.0\.0\.1|localhost)$/)

const q = (value) => `'${String(value).replaceAll("'", "''")}'`
const sql = (statement) =>
  execFileSync('psql', [env.SUPABASE_DB_URL, '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8' }).trim()
const json = (statement) => JSON.parse(sql(statement))
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)
const assignments = (fields) =>
  Object.entries(fields)
    .map(([column, value]) => `${column} = ${value === null ? 'NULL' : typeof value === 'boolean' || typeof value === 'number' ? String(value) : q(value)}`)
    .join(', ')

const ctx = json(`
  SELECT json_build_object(
    'leagueId', league.id,
    'seasonId', season.id,
    'seasonYear', season.season_year,
    'weekNumber', (SELECT week.week_number FROM season_weeks week
       WHERE week.season_year = season.season_year
         AND week.week_start <= (now() AT TIME ZONE 'America/New_York')::date
         AND week.week_end >= (now() AT TIME ZONE 'America/New_York')::date
       ORDER BY week.week_number LIMIT 1),
    'memberId', member.id,
    'teamName', member.team_name,
    'rosterSize', league.roster_size,
    'irSlots', league.ir_slots,
    'taxiSlots', league.taxi_slots,
    'today', to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD'))
  FROM leagues league
  JOIN league_seasons season ON season.league_id = league.id AND season.is_current
  JOIN league_members member ON member.league_id = league.id AND member.team_name = ${q(team)}
  WHERE league.id = ${q(fixture.leagueId)};`)
assert.ok(ctx, `Fixture league, current season and ${team} must exist`)

const roster = json(`
  SELECT coalesce(json_agg(json_build_object(
    'rosterPlayerId', roster.id,
    'playerId', player.id,
    'name', player.display_name,
    'injuryStatus', player.injury_status,
    'expectedReturn', player.injury_expected_return,
    'isOnIr', roster.is_on_ir,
    'isOnTaxi', roster.is_on_taxi,
    'nbaTeam', player.nba_team,
    'position', player.position,
    'eligiblePositions', player.eligible_positions,
    'yearsExp', player.years_exp,
    'careerGames', player.career_regular_season_games,
    'starter', EXISTS (SELECT 1 FROM weekly_lineups lineup
       WHERE lineup.member_id = roster.member_id
         AND lineup.league_season_id = roster.league_season_id
         AND lineup.player_id = roster.player_id
         AND lineup.game_date = ${q(ctx.today)}))
    ORDER BY player.sportsdata_id), '[]'::json) AS rows
  FROM roster_players roster
  JOIN players player ON player.id = roster.player_id
  WHERE roster.league_id = ${q(ctx.leagueId)}
    AND roster.league_season_id = ${q(ctx.seasonId)}
    AND roster.member_id = ${q(ctx.memberId)};`)
assert.ok(roster.length >= 3, `${team} needs at least three roster players`)

const originalTaxi = roster.find((player) => player.isOnTaxi) ?? null
const activePool = roster.filter((player) => player.playerId !== originalTaxi?.playerId)
const bench = activePool.filter((player) => !player.starter)
const lockedAssets = caseName === 'starter-open-slot'
  ? new Set(json(`SELECT coalesce(json_agg(asset_id), '[]'::json) FROM private.locked_assets(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}) WHERE asset_kind = 'player'`))
  : new Set()
const candidate = caseName === 'starter-open-slot'
  ? (activePool.find((player) => (player.eligiblePositions ?? []).includes('PG') && !lockedAssets.has(player.playerId)) ?? bench[0] ?? activePool[0])
  : (bench[0] ?? activePool[0])
const occupant = bench.find((player) => player.playerId !== candidate.playerId) ?? activePool.find((player) => player.playerId !== candidate.playerId)
assert.ok(candidate, `${team} needs an active player for this case`)
assert.ok(occupant, `${team} needs a second active player for this case`)
const pick = (count) => {
  const picked = []
  for (const player of [...bench, ...activePool]) {
    if (picked.length === count) break
    if (!picked.some((entry) => entry.playerId === player.playerId)) picked.push(player)
  }
  assert.equal(picked.length, count, `${team} needs ${count} distinct active players for ${caseName}`)
  return picked
}

const playerUpdates = new Map()
const rosterUpdates = new Map()
const leagueUpdates = {}
const statements = []
const expected = { moves: [], notices: [] }
const involved = []

if (caseName === 'starter-open-slot') {
  assert.ok((candidate.eligiblePositions ?? []).includes('PG'), `${team} needs a PG-eligible candidate for starter-open-slot`)
  let replacement = activePool.find((player) => player.playerId !== candidate.playerId
    && (player.eligiblePositions ?? []).includes('PG') && !player.isOnIr && !player.isOnTaxi && !lockedAssets.has(player.playerId))
  if (!replacement) {
    const replacementId = randomUUID()
    statements.push(`INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES (${q(replacementId)}, ${q(replacementId)}, 'Verify', 'PG', 'PG', ARRAY['PG'], NULL, 'ZZ');`)
    statements.push(`INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
      VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}, ${q(replacementId)}, 'draft');`)
    replacement = { playerId: replacementId, eligiblePositions: ['PG'], isOnIr: false, isOnTaxi: false }
  }
  playerUpdates.set(candidate.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 14), nba_team: 'ZZ' })
  playerUpdates.set(replacement.playerId, { nba_team: 'ZZ' })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = Math.max(20, roster.length + 1)
  statements.push(`DELETE FROM public.roster_transactions
    WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
      AND member_id = ${q(ctx.memberId)} AND transaction_type = 'ir_designate';`)
  statements.push(`INSERT INTO public.nba_games(season_year, week_number, game_date, game_time, home_team, away_team, status, nba_game_id)
    VALUES (${ctx.seasonYear}, ${ctx.weekNumber}, ${q(ctx.today)}, now() + interval '2 hours', 'ZZ', 'ZZZ', 'Scheduled', 'verify-auto-ir-starter');`)
  expected.moves.push({ kind: 'designate', designatePlayerId: candidate.playerId })
  involved.push({ role: 'candidate', playerId: candidate.playerId }, { role: 'replacement', playerId: replacement.playerId })
} else if (caseName === 'bench-open-slot') {
  const locked = new Set(json(`SELECT coalesce(json_agg(asset_id), '[]'::json) FROM private.locked_assets(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}) WHERE asset_kind = 'player'`))
  const todayLineup = json(`SELECT coalesce(json_agg(json_build_object('playerId', player_id, 'slotType', slot_type)), '[]'::json)
    FROM weekly_lineups
    WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
      AND member_id = ${q(ctx.memberId)} AND game_date = ${q(ctx.today)}`)
  const starterIds = new Set(todayLineup.map((row) => row.playerId))
  const benchCandidates = activePool.filter((player) => !starterIds.has(player.playerId) && !locked.has(player.playerId))
  assert.ok(benchCandidates.length, `${team} needs an unlocked bench player for bench-open-slot`)
  const chosen = benchCandidates[0]
  assert.ok(ctx.weekNumber, 'bench-open-slot needs a current season week')
  const slots = json(`SELECT coalesce(json_agg(slot_type ORDER BY slot_type), '[]'::json)
    FROM lineup_slot_templates WHERE league_id = ${q(ctx.leagueId)} AND slot_type NOT IN ('BE', 'IR')`)
  const occupied = new Set(todayLineup.map((row) => row.slotType))
  const fillers = activePool.filter((player) => player.playerId !== chosen.playerId && !starterIds.has(player.playerId))
  for (const slot of slots) {
    if (occupied.has(slot)) continue
    const filler = fillers.shift()
    if (!filler) break
    statements.push(`INSERT INTO weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
      VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}, ${q(filler.playerId)}, ${ctx.weekNumber}, ${q(ctx.today)}, ${q(slot)}, false);`)
    occupied.add(slot)
  }
  playerUpdates.set(chosen.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 14) })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = Math.max(20, roster.length + 1)
  statements.push(`DELETE FROM public.roster_transactions
    WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
      AND member_id = ${q(ctx.memberId)} AND transaction_type = 'ir_designate';`)
  expected.moves.push({ kind: 'designate', designatePlayerId: chosen.playerId })
  involved.push({ role: 'candidate', playerId: chosen.playerId })
} else if (caseName === 'open-slot') {
  playerUpdates.set(candidate.playerId, injury === 'out'
    ? { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 14) }
    : { injury_status: null, injury_expected_return: 'unknown' })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = Math.max(20, roster.length + 1)
  if (injury === 'out') expected.moves.push({ kind: 'designate', designatePlayerId: candidate.playerId })
  involved.push({ role: 'candidate', playerId: candidate.playerId })
  if (locked === 'on') {
    const lockedPlayer = activePool.find((player) => player.playerId !== candidate.playerId && player.nbaTeam)
    assert.ok(lockedPlayer, `${team} needs a second active player with an NBA team for --locked=on`)
    playerUpdates.set(lockedPlayer.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 30) })
    statements.push(`INSERT INTO nba_games(season_year, week_number, game_date, home_team, away_team, status, game_time, nba_game_id)
      VALUES (${ctx.seasonYear}, ${ctx.weekNumber}, ${q(ctx.today)}, ${q(lockedPlayer.nbaTeam)}, ${q(lockedPlayer.nbaTeam === 'BOS' ? 'NYK' : 'BOS')}, 'InProgress', now() - interval '1 hour', 'verify-auto-ir-locked');`)
    involved.push({ role: 'lockedInjured', playerId: lockedPlayer.playerId })
  }
} else if (caseName === 'full-bench-swap') {
  playerUpdates.set(candidate.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 10) })
  playerUpdates.set(occupant.playerId, { injury_status: 'Healthy' })
  rosterUpdates.set(occupant.rosterPlayerId, { is_on_ir: true })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = roster.length - 2
  expected.moves.push({ kind: 'swap', designatePlayerId: candidate.playerId, activatePlayerId: occupant.playerId })
  involved.push({ role: 'candidate', playerId: candidate.playerId }, { role: 'healthyIrOccupant', playerId: occupant.playerId })
} else if (caseName === 'no-legal-swap') {
  playerUpdates.set(occupant.playerId, { injury_status: 'Healthy' })
  rosterUpdates.set(occupant.rosterPlayerId, { is_on_ir: true })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = roster.length - 2
  expected.notices.push({ playerId: occupant.playerId, playerName: occupant.name, reason: 'healthy_ir_bench_full', action: `Drop a player, then activate ${occupant.name}` })
  involved.push({ role: 'healthyIrOccupant', playerId: occupant.playerId })
} else if (caseName === 'swap-available') {
  const [healthyOccupant, first, second] = pick(3)
  const tiedReturn = addDays(ctx.today, 20)
  playerUpdates.set(healthyOccupant.playerId, { injury_status: 'Healthy' })
  rosterUpdates.set(healthyOccupant.rosterPlayerId, { is_on_ir: true })
  playerUpdates.set(first.playerId, { injury_status: 'Out', injury_expected_return: tiedReturn })
  playerUpdates.set(second.playerId, { injury_status: 'Out', injury_expected_return: tiedReturn })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = roster.length - 2
  expected.notices.push({ playerId: healthyOccupant.playerId, playerName: healthyOccupant.name, reason: 'healthy_ir_swap_available', action: `Swap ${healthyOccupant.name} with an injured player` })
  involved.push(
    { role: 'healthyIrOccupant', playerId: healthyOccupant.playerId },
    { role: 'candidate', playerId: first.playerId },
    { role: 'candidate', playerId: second.playerId },
  )
} else if (caseName === 'swap-locked') {
  const [healthyOccupant, injuredPartner] = pick(2)
  assert.ok(injuredPartner.nbaTeam, `${injuredPartner.name} needs an NBA team for the swap-locked case`)
  assert.ok(ctx.weekNumber, 'The swap-locked case needs a current season week')
  playerUpdates.set(healthyOccupant.playerId, { injury_status: 'Healthy' })
  rosterUpdates.set(healthyOccupant.rosterPlayerId, { is_on_ir: true })
  playerUpdates.set(injuredPartner.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 20) })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = roster.length - 2
  statements.push(`INSERT INTO nba_games(season_year, week_number, game_date, home_team, away_team, status, game_time, nba_game_id)
    VALUES (${ctx.seasonYear}, ${ctx.weekNumber}, ${q(ctx.today)}, ${q(injuredPartner.nbaTeam)}, ${q(injuredPartner.nbaTeam === 'BOS' ? 'NYK' : 'BOS')}, 'InProgress', now() - interval '1 hour', 'verify-auto-ir-swap-locked');`)
  expected.notices.push({ playerId: healthyOccupant.playerId, playerName: healthyOccupant.name, reason: 'healthy_ir_swap_locked', action: `Swap ${healthyOccupant.name} with an injured player after their game or pending move clears` })
  involved.push(
    { role: 'healthyIrOccupant', playerId: healthyOccupant.playerId },
    { role: 'lockedInjuredPartner', playerId: injuredPartner.playerId },
  )
} else if (caseName === 'uncertain') {
  const first = bench[0] ?? activePool[0]
  const second = bench[1] ?? activePool.find((player) => player.playerId !== first.playerId)
  assert.ok(second, `${team} needs two active candidates for the uncertain case`)
  playerUpdates.set(first.playerId, { injury_status: 'Out', injury_expected_return: 'unknown' })
  playerUpdates.set(second.playerId, { injury_status: 'Out', injury_expected_return: 'unknown' })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = Math.max(20, roster.length + 1)
  for (const player of [first, second]) {
    expected.notices.push({ playerId: player.playerId, playerName: player.name, reason: 'ir_choice_uncertain', action: 'Choose who moves to IR' })
    involved.push({ role: 'candidate', playerId: player.playerId })
  }
} else if (caseName === 'locked') {
  assert.ok(candidate.nbaTeam, `${candidate.name} needs an NBA team for the locked case`)
  assert.ok(ctx.weekNumber, 'The locked case needs a current season week')
  playerUpdates.set(candidate.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 10) })
  leagueUpdates.ir_slots = 1
  leagueUpdates.roster_size = Math.max(20, roster.length + 1)
  statements.push(`INSERT INTO nba_games(season_year, week_number, game_date, home_team, away_team, status, game_time, nba_game_id)
    VALUES (${ctx.seasonYear}, ${ctx.weekNumber}, ${q(ctx.today)}, ${q(candidate.nbaTeam)}, ${q(candidate.nbaTeam === 'BOS' ? 'NYK' : 'BOS')}, 'InProgress', now() - interval '1 hour', 'verify-auto-ir-locked');`)
  involved.push({ role: 'lockedCandidate', playerId: candidate.playerId })
} else if (caseName === 'incumbent-boundary-tie') {
  const [incumbentOne, incumbentTwo, contender] = pick(3)
  const tiedReturn = addDays(ctx.today, 7)
  playerUpdates.set(incumbentOne.playerId, { injury_status: 'Out', injury_expected_return: tiedReturn })
  playerUpdates.set(incumbentTwo.playerId, { injury_status: 'Out', injury_expected_return: tiedReturn })
  playerUpdates.set(contender.playerId, { injury_status: 'Out', injury_expected_return: addDays(ctx.today, 60) })
  rosterUpdates.set(incumbentOne.rosterPlayerId, { is_on_ir: true })
  rosterUpdates.set(incumbentTwo.rosterPlayerId, { is_on_ir: true })
  leagueUpdates.ir_slots = 2
  leagueUpdates.roster_size = roster.length - 3
  involved.push(
    { role: 'incumbentOne', playerId: incumbentOne.playerId },
    { role: 'incumbentTwo', playerId: incumbentTwo.playerId },
    { role: 'contender', playerId: contender.playerId },
  )
  expected.notices.push(
    { playerId: incumbentOne.playerId, playerName: incumbentOne.name, reason: 'ir_choice_uncertain', action: 'Choose who moves to IR' },
    { playerId: incumbentTwo.playerId, playerName: incumbentTwo.name, reason: 'ir_choice_uncertain', action: 'Choose who moves to IR' },
  )
} else if (caseName === 'incumbent-exchange' || caseName === 'incumbent-tie' || caseName === 'incumbent-unknown') {
  const [incumbentSoon, incumbentLater, contender] = pick(3)
  const soonReturn = addDays(ctx.today, 7)
  const laterReturn = addDays(ctx.today, 30)
  const contenderReturn = caseName === 'incumbent-exchange' ? addDays(ctx.today, 60) : caseName === 'incumbent-tie' ? soonReturn : 'unknown'
  playerUpdates.set(incumbentSoon.playerId, { injury_status: 'Out', injury_expected_return: soonReturn })
  playerUpdates.set(incumbentLater.playerId, { injury_status: 'Out', injury_expected_return: laterReturn })
  playerUpdates.set(contender.playerId, { injury_status: 'Out', injury_expected_return: contenderReturn })
  rosterUpdates.set(incumbentSoon.rosterPlayerId, { is_on_ir: true })
  rosterUpdates.set(incumbentLater.rosterPlayerId, { is_on_ir: true })
  leagueUpdates.ir_slots = 2
  leagueUpdates.roster_size = roster.length - 3
  involved.push(
    { role: 'incumbentSoon', playerId: incumbentSoon.playerId },
    { role: 'incumbentLater', playerId: incumbentLater.playerId },
    { role: 'contender', playerId: contender.playerId },
  )
  if (caseName === 'incumbent-exchange') {
    expected.moves.push({ kind: 'swap', designatePlayerId: contender.playerId, activatePlayerId: incumbentSoon.playerId })
  } else {
    expected.notices.push({ playerId: contender.playerId, playerName: contender.name, reason: 'ir_choice_uncertain', action: 'Choose who moves to IR' })
  }
} else {
  assert.ok(originalTaxi, `${team} needs a taxi player for the taxi-ineligible case`)
  playerUpdates.set(originalTaxi.playerId, { years_exp: 2, career_regular_season_games: 100 })
  leagueUpdates.taxi_slots = Math.max(1, ctx.taxiSlots)
  leagueUpdates.roster_size = Math.max(20, roster.length + 1)
  expected.notices.push({ playerId: originalTaxi.playerId, playerName: originalTaxi.name, reason: 'taxi_ineligible', action: `Activate ${originalTaxi.name} from taxi or drop a player` })
  involved.push({ role: 'ineligibleTaxi', playerId: originalTaxi.playerId })
}

statements.unshift(
  `DELETE FROM nba_games WHERE nba_game_id LIKE 'verify-auto-ir-%';`,
  `UPDATE players SET injury_status = NULL, injury_expected_return = 'unknown'
     WHERE id IN (SELECT player_id FROM roster_players
       WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)} AND member_id = ${q(ctx.memberId)});`,
  `UPDATE roster_players SET is_on_ir = false, is_on_taxi = false
     WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)} AND member_id = ${q(ctx.memberId)}${originalTaxi ? ` AND id <> ${q(originalTaxi.rosterPlayerId)}` : ''};`,
)
if (originalTaxi) {
  statements.push(
    `UPDATE players SET years_exp = 0, career_regular_season_games = 0 WHERE id = ${q(originalTaxi.playerId)};`,
    `UPDATE roster_players SET is_on_ir = false WHERE id = ${q(originalTaxi.rosterPlayerId)};`,
  )
}
for (const [playerId, fields] of playerUpdates) statements.push(`UPDATE players SET ${assignments(fields)} WHERE id = ${q(playerId)};`)
for (const [rosterPlayerId, fields] of rosterUpdates) statements.push(`UPDATE roster_players SET ${assignments(fields)} WHERE id = ${q(rosterPlayerId)};`)
if (Object.keys(leagueUpdates).length) statements.push(`UPDATE leagues SET ${assignments(leagueUpdates)} WHERE id = ${q(ctx.leagueId)};`)
statements.push(`INSERT INTO lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at, last_daily_optimized_date, last_optimized_at)
  VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}, ${autoLineup === 'on'}, ${autoLineup === 'on' ? 'now()' : 'NULL'}, NULL, NULL)
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled = EXCLUDED.enabled, enabled_at = EXCLUDED.enabled_at,
    last_daily_optimized_date = NULL, last_optimized_at = NULL;`)
let starterSlot = null
if (starter === 'on') {
  const slots = json(`SELECT coalesce(json_agg(slot_type ORDER BY slot_type), '[]'::json) FROM lineup_slot_templates
    WHERE league_id = ${q(ctx.leagueId)} AND slot_type NOT IN ('BE', 'IR')`)
  assert.ok(slots.length, `${team} needs a starting slot for --starter=on`)
  assert.ok(ctx.weekNumber, '--starter=on needs a current season week')
  const occupied = json(`SELECT coalesce(json_agg(DISTINCT slot_type), '[]'::json) FROM weekly_lineups
    WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
      AND member_id = ${q(ctx.memberId)} AND game_date = ${q(ctx.today)}
      AND slot_type NOT IN ('BE', 'IR')`)
  const eligible = (slot) => slot === 'UTIL' ||
    (slot === 'G' && candidate.eligiblePositions.some((position) => ['PG', 'SG'].includes(position))) ||
    (slot === 'F' && candidate.eligiblePositions.some((position) => ['SF', 'PF'].includes(position))) ||
    candidate.eligiblePositions.includes(slot)
  const free = slots.filter((slot) => !occupied.includes(slot))
  starterSlot = free.find(eligible) ?? free[0] ?? slots[0]
  statements.push(`DELETE FROM weekly_lineups
    WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
      AND member_id = ${q(ctx.memberId)} AND game_date = ${q(ctx.today)}
      AND (player_id = ${q(candidate.playerId)} OR slot_type = ${q(starterSlot)});`)
  statements.push(`INSERT INTO weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES (${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)}, ${q(candidate.playerId)}, ${ctx.weekNumber}, ${q(ctx.today)}, ${q(starterSlot)}, false);`)
}
statements.push(leaguePolicy === 'on'
  ? `INSERT INTO private.league_roster_policies(league_id, auto_ir_all_members) VALUES (${q(ctx.leagueId)}, true)
     ON CONFLICT (league_id) DO UPDATE SET auto_ir_all_members = true;
     SELECT private.activate_league_roster_policy(${q(ctx.leagueId)});`
  : `DELETE FROM private.league_roster_policies WHERE league_id = ${q(ctx.leagueId)};`)
sql(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`)

const final = json(`
  SELECT json_build_object(
    'league', (SELECT json_build_object('rosterSize', roster_size, 'irSlots', ir_slots, 'taxiSlots', taxi_slots)
      FROM leagues WHERE id = ${q(ctx.leagueId)}),
    'counts', (SELECT json_build_object(
        'roster', count(*),
        'active', count(*) FILTER (WHERE NOT is_on_ir AND NOT is_on_taxi),
        'ir', count(*) FILTER (WHERE is_on_ir),
        'taxi', count(*) FILTER (WHERE is_on_taxi))
      FROM roster_players
      WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)} AND member_id = ${q(ctx.memberId)}),
    'players', (SELECT coalesce(json_agg(json_build_object(
        'playerId', player.id,
        'name', player.display_name,
        'injuryStatus', player.injury_status,
        'injuryExpectedReturn', player.injury_expected_return,
        'isOnIr', roster.is_on_ir,
        'isOnTaxi', roster.is_on_taxi,
        'gameLocked', private.roster_status_game_started(player.id),
        'irEligible', private.is_ir_designation(player.injury_status),
        'taxiEligible', private.taxi_player_eligible(${q(ctx.leagueId)}, player.id))
      ORDER BY player.sportsdata_id), '[]'::json)
      FROM roster_players roster
      JOIN players player ON player.id = roster.player_id
      WHERE roster.league_id = ${q(ctx.leagueId)} AND roster.league_season_id = ${q(ctx.seasonId)} AND roster.member_id = ${q(ctx.memberId)}),
    'optimizerEnabled', (SELECT enabled FROM lineup_optimizer_settings
      WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)} AND member_id = ${q(ctx.memberId)}),
    'leaguePolicy', (SELECT auto_ir_all_members FROM private.league_roster_policies
      WHERE league_id = ${q(ctx.leagueId)}),
    'starterRows', ${starterSlot ? `(SELECT count(*) FROM weekly_lineups
      WHERE league_id = ${q(ctx.leagueId)} AND league_season_id = ${q(ctx.seasonId)}
        AND member_id = ${q(ctx.memberId)} AND game_date = ${q(ctx.today)} AND slot_type = ${q(starterSlot)})` : 'NULL'});`)

const byId = new Map(final.players.map((player) => [player.playerId, player]))
const involvedPlayers = involved.map((entry) => {
  const player = byId.get(entry.playerId)
  assert.ok(player, `Final roster must contain ${entry.playerId}`)
  return { role: entry.role, ...player }
})
const openIrSlots = Math.max(0, final.league.irSlots - final.counts.ir)
const activeRoom = Math.max(0, final.league.rosterSize - final.counts.active)
const checks = {
  optimizerEnabled: final.optimizerEnabled === true,
  leaguePolicy: final.leaguePolicy === true,
}
const applied = {
  optimizerEnabled: final.optimizerEnabled === (autoLineup === 'on'),
  leaguePolicy: Boolean(final.leaguePolicy) === (leaguePolicy === 'on'),
}
if (starter === 'on') checks.starterSlotUnique = final.starterRows === 1

if (caseName === 'starter-open-slot') {
  checks.candidateIrEligible = involvedPlayers[0].irEligible === true
  checks.candidateOnBench = involvedPlayers[0].isOnIr === false && involvedPlayers[0].isOnTaxi === false
  checks.irEmpty = final.counts.ir === 0
  checks.openIrSlot = openIrSlots >= 1
  checks.replacementHealthy = involvedPlayers[1].irEligible === false
} else if (caseName === 'bench-open-slot') {
  checks.candidateIrEligible = involvedPlayers[0].irEligible === true
  checks.candidateOnBench = involvedPlayers[0].isOnIr === false && involvedPlayers[0].isOnTaxi === false
  checks.irEmpty = final.counts.ir === 0
  checks.openIrSlot = openIrSlots >= 1
} else if (caseName === 'open-slot') {
  checks.candidateInjury = injury === 'out'
    ? involvedPlayers[0].irEligible === true
    : involvedPlayers[0].irEligible === false
  checks.irEmpty = final.counts.ir === 0
  checks.openIrSlot = openIrSlots >= 1
  if (locked === 'on') {
    const lockedPlayer = involvedPlayers.find((player) => player.role === 'lockedInjured')
    checks.lockedInjured = lockedPlayer.gameLocked === true && lockedPlayer.irEligible === true
  }
} else if (caseName === 'full-bench-swap') {
  checks.candidateIrEligible = involvedPlayers[0].irEligible === true
  checks.occupantNotIrEligible = involvedPlayers[1].irEligible === false
  checks.occupantOnIr = involvedPlayers[1].isOnIr === true
  checks.activeFull = final.counts.active === final.league.rosterSize
  checks.noOpenIrSlot = openIrSlots === 0
} else if (caseName === 'no-legal-swap') {
  checks.occupantNotIrEligible = involvedPlayers[0].irEligible === false
  checks.occupantOnIr = involvedPlayers[0].isOnIr === true
  checks.noEligibleActive = final.players.every((player) => player.isOnIr || player.isOnTaxi || !player.irEligible)
  checks.activeFull = final.counts.active === final.league.rosterSize
  checks.noOpenIrSlot = openIrSlots === 0
} else if (caseName === 'swap-available') {
  const [healthyOccupant, first, second] = involvedPlayers
  checks.occupantHealthyOnIr = healthyOccupant.isOnIr === true && healthyOccupant.irEligible === false
  checks.twoTiedCandidates = first.isOnIr === false && second.isOnIr === false && first.irEligible === true && second.irEligible === true && first.injuryExpectedReturn === second.injuryExpectedReturn
  checks.activeFull = final.counts.active === final.league.rosterSize
  checks.noOpenIrSlot = openIrSlots === 0
} else if (caseName === 'swap-locked') {
  const [healthyOccupant, injuredPartner] = involvedPlayers
  checks.occupantHealthyOnIr = healthyOccupant.isOnIr === true && healthyOccupant.irEligible === false
  checks.partnerLocked = injuredPartner.isOnIr === false && injuredPartner.irEligible === true && injuredPartner.gameLocked === true
  checks.activeFull = final.counts.active === final.league.rosterSize
  checks.noOpenIrSlot = openIrSlots === 0
} else if (caseName === 'uncertain') {
  checks.twoUncertainCandidates = involvedPlayers.length === 2 && involvedPlayers.every((player) => player.irEligible && player.injuryExpectedReturn === 'unknown')
  checks.oneOpenIrSlot = openIrSlots === 1
} else if (caseName === 'locked') {
  checks.candidateLocked = involvedPlayers[0].gameLocked === true
  checks.candidateIrEligible = involvedPlayers[0].irEligible === true
  checks.openIrSlot = openIrSlots >= 1
} else if (caseName === 'incumbent-boundary-tie') {
  const [incumbentOne, incumbentTwo, contender] = involvedPlayers
  checks.incumbentsOnIr = incumbentOne.isOnIr === true && incumbentTwo.isOnIr === true && incumbentOne.irEligible === true && incumbentTwo.irEligible === true
  checks.incumbentReturns = incumbentOne.injuryExpectedReturn === addDays(ctx.today, 7) && incumbentTwo.injuryExpectedReturn === addDays(ctx.today, 7)
  checks.contenderActive = contender.isOnIr === false && contender.irEligible === true
  checks.activeFull = final.counts.active === final.league.rosterSize
  checks.noOpenIrSlot = openIrSlots === 0
  checks.contenderLater = contender.injuryExpectedReturn === addDays(ctx.today, 60)
} else if (caseName === 'incumbent-exchange' || caseName === 'incumbent-tie' || caseName === 'incumbent-unknown') {
  const [incumbentSoon, incumbentLater, contender] = involvedPlayers
  checks.incumbentsOnIr = incumbentSoon.isOnIr === true && incumbentLater.isOnIr === true && incumbentSoon.irEligible === true && incumbentLater.irEligible === true
  checks.incumbentReturns = incumbentSoon.injuryExpectedReturn === addDays(ctx.today, 7) && incumbentLater.injuryExpectedReturn === addDays(ctx.today, 30)
  checks.contenderActive = contender.isOnIr === false && contender.irEligible === true
  checks.activeFull = final.counts.active === final.league.rosterSize
  checks.noOpenIrSlot = openIrSlots === 0
  if (caseName === 'incumbent-exchange') checks.contenderLater = contender.injuryExpectedReturn === addDays(ctx.today, 60)
  if (caseName === 'incumbent-tie') checks.contenderTied = contender.injuryExpectedReturn === incumbentSoon.injuryExpectedReturn
  if (caseName === 'incumbent-unknown') checks.contenderUnknown = contender.injuryExpectedReturn === 'unknown'
} else {
  checks.taxiIneligible = involvedPlayers[0].taxiEligible === false
  checks.taxiOnTaxi = involvedPlayers[0].isOnTaxi === true
}
for (const [name, passed] of Object.entries(applied)) assert.ok(passed, `Seeder did not apply ${name}`)
for (const [name, passed] of Object.entries(checks)) {
  if (name === 'optimizerEnabled' || name === 'leaguePolicy') continue
  assert.ok(passed, `Case ${caseName} failed its ${name} check`)
}
const plan = json(`SELECT private.plan_auto_ir(${q(ctx.leagueId)}, ${q(ctx.seasonId)}, ${q(ctx.memberId)})`)
if (caseName === 'bench-open-slot' || caseName === 'starter-open-slot') {
  const moves = Array.isArray(plan.moves) ? plan.moves : []
  assert.ok(moves.some((move) => move.kind === 'designate' && move.designatePlayerId === involved[0].playerId),
    `${caseName} plan must designate the candidate: ${JSON.stringify(plan)}`)
}
if (caseName === 'open-slot') {
  const moves = Array.isArray(plan.moves) ? plan.moves : []
  if (injury === 'out') {
    assert.ok(moves.some((move) => move.kind === 'designate' && move.designatePlayerId === involved[0].playerId),
      `open-slot plan must designate the candidate: ${JSON.stringify(plan)}`)
  } else {
    assert.ok(!moves.some((move) => move.kind === 'designate'),
      `open-slot plan must not designate a healthy candidate: ${JSON.stringify(plan)}`)
  }
  if (locked === 'on') {
    const lockedPlayer = involved.find((entry) => entry.role === 'lockedInjured')
    assert.ok(!moves.some((move) => move.designatePlayerId === lockedPlayer.playerId),
      `open-slot plan must not designate the game-locked player: ${JSON.stringify(plan)}`)
  }
}

const output = {
  case: caseName,
  team: ctx.teamName,
  leagueId: ctx.leagueId,
  seasonId: ctx.seasonId,
  memberId: ctx.memberId,
  today: ctx.today,
  league: final.league,
  counts: { ...final.counts, openIrSlots, activeRoom },
  involved: involvedPlayers,
  expected,
  plan,
  checks,
  applied,
  optimizerEnabled: final.optimizerEnabled,
  leaguePolicy: final.leaguePolicy,
  autoLineup,
  leaguePolicyOption: leaguePolicy,
  starter,
  injury,
  locked,
  starterDate: starter === 'on' ? ctx.today : null,
  starterSlot,
}
await writeFile(path.join(dir, 'auto-ir-seed.json'), JSON.stringify(output, null, 2), { mode: 0o600 })
console.log(JSON.stringify(output, null, 2))
console.error(`Next: node tools/verify/trigger-lineup-optimizer.mjs ${q(dir)}`)
