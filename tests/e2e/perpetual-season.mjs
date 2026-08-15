// Perpetual-season simulation harness.
//
// Fast-forwards leagues through full seasons against the LOCAL Supabase stack
// and asserts every season-boundary step happens with zero manual
// commissioner actions: weekly finalization, playoff bracket auto-generation,
// round-by-round auto-advancement, season rollover, and new-season matchup
// generation, repeated across consecutive rollovers.
//
// The harness controls the clock: every sync/boundary tick receives an
// explicit simulated date; nothing here depends on wall-clock "now" for
// simulation decisions.
//
// Run (requires `supabase start` and `supabase functions serve`):
//   npm run e2e:perpetual                 # 2 rollovers (season N -> N+1 -> N+2)
//   npm run e2e:perpetual -- --rollovers=1
//   npm run e2e:perpetual -- --disable-boundary   # proof the check can go red
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'

const ROOT = process.cwd()
const ARTIFACT_DIR = path.join(ROOT, 'tests/artifacts/perpetual-season')

// Synthetic season-year ranges owned by this harness. Each league gets its own
// base year so per-year tables (season_weeks, nba_games, player_game_stats)
// never interleave across leagues; rollovers advance +1 within the gap.
const HARNESS_YEAR_MIN = 4200
const HARNESS_YEAR_MAX = 4299
// Synthetic calendar anchor: all simulated week dates live here.
const CALENDAR_ANCHOR_UTC = Date.UTC(2101, 0, 4)

const args = Object.fromEntries(process.argv.slice(2).flatMap((arg) => {
  const match = arg.match(/^--([a-z-]+)(?:=(.*))?$/)
  return match ? [[match[1], match[2] ?? 'true']] : []
}))
const ROLLOVERS = Number(args.rollovers ?? 2)
const BOUNDARY_ENABLED = args['disable-boundary'] !== 'true'

const localStatus = () => {
  try {
    return JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' }))
  } catch {
    return {}
  }
}
const status = localStatus()
const SUPABASE_URL = process.env.PERPETUAL_SUPABASE_URL ?? status.API_URL ?? 'http://127.0.0.1:54321'
const SERVICE_KEY = process.env.PERPETUAL_SERVICE_KEY ?? status.SECRET_KEY ?? status.SERVICE_ROLE_KEY
const INTERNAL_TOKEN = process.env.PERPETUAL_EDGE_INTERNAL_TOKEN ?? 'pancake-local-edge-auth-probe-token'

const url = new URL(SUPABASE_URL)
if (!['127.0.0.1', 'localhost'].includes(url.hostname) && process.env.PERPETUAL_ALLOW_REMOTE !== '1') {
  throw new Error(`perpetual-season only runs against a local Supabase stack (got ${url.hostname}); set PERPETUAL_ALLOW_REMOTE=1 to override`)
}
if (!SERVICE_KEY) throw new Error('No local service key found; run `supabase start` first')

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } })

const failures = []
const transcript = []
const log = (line) => {
  transcript.push(line)
  console.log(line)
}
const fail = (message) => {
  failures.push(message)
  log(`FAIL: ${message}`)
}

const throwOn = (error, label) => {
  if (error) throw new Error(`${label}: ${error.message ?? error}`)
}

async function callEdge(name, body = {}) {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-function-token': INTERNAL_TOKEN,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${name} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const isoDate = (dayOffset) => new Date(CALENDAR_ANCHOR_UTC + dayOffset * 86_400_000)
  .toISOString().slice(0, 10)

// Global simulated-day cursor: every league season occupies its own slice of
// the synthetic calendar so a season's week dates never collide with another
// simulated season's dates for the same league.
const weekStartDay = (seasonIndex, weekNumber) => seasonIndex * 400 + (weekNumber - 1) * 7
const weekDates = (seasonIndex, weekNumber) => ({
  start: isoDate(weekStartDay(seasonIndex, weekNumber)),
  end: isoDate(weekStartDay(seasonIndex, weekNumber) + 6),
  tick: `${isoDate(weekStartDay(seasonIndex, weekNumber) + 6)}T18:00:00.000Z`,
})

function roundRobin(ids) {
  const teams = ids.length % 2 === 0 ? [...ids] : [...ids, null]
  const n = teams.length
  const rounds = []
  for (let r = 0; r < n - 1; r += 1) {
    const rotating = teams.slice(1)
    const rotated = [...rotating.slice(r), ...rotating.slice(0, r)]
    const circle = [teams[0], ...rotated]
    const pairings = []
    for (let i = 0; i < n / 2; i += 1) {
      const home = circle[i]
      const away = circle[n - 1 - i]
      if (home != null && away != null) pairings.push({ home, away })
    }
    rounds.push(pairings)
  }
  return rounds
}

async function ensureUsers(count) {
  const users = []
  for (let index = 1; index <= count; index += 1) {
    const email = `pancake-perpetual-${index}@pancake.test`
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password: 'perpetual-season-pass-1',
      email_confirm: true,
    })
    if (!error) {
      users.push(data.user)
      continue
    }
    const { data: list, error: listError } = await supabase.auth.admin.listUsers({ perPage: 1000 })
    throwOn(listError, 'listUsers')
    /** @type {Array<{ id: string, email?: string }>} */
    const candidates = list?.users ?? []
    const existing = candidates.find((user) => user.email === email)
    if (!existing) throw new Error(`Could not create or find user ${email}: ${error.message}`)
    users.push(existing)
  }
  return users
}

async function cleanupPreviousRuns() {
  const { data: leagues, error } = await supabase
    .from('leagues')
    .select('id')
    .like('slug', 'pancake-perpetual-%')
  throwOn(error, 'cleanup league lookup')
  for (const league of leagues ?? []) {
    const { error: draftError } = await supabase.from('drafts').delete().eq('league_id', league.id)
    throwOn(draftError, 'cleanup drafts')
    const { error: deleteError } = await supabase.from('leagues').delete().eq('id', league.id)
    throwOn(deleteError, 'cleanup league')
  }
  for (const table of ['player_game_stats', 'nba_games', 'season_weeks']) {
    const { error: tableError } = await supabase
      .from(table)
      .delete()
      .gte('season_year', HARNESS_YEAR_MIN)
      .lte('season_year', HARNESS_YEAR_MAX)
    throwOn(tableError, `cleanup ${table}`)
  }
  const { error: playerError } = await supabase
    .from('players')
    .delete()
    .like('sportsdata_id', 'perpetual-%')
  throwOn(playerError, 'cleanup players')
}

async function createLeague({ name, users, memberCount, playoffStartWeek, baseYear }) {
  const slugTag = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const { data: league, error: leagueError } = await supabase.from('leagues').insert({
    name: `Pancake Perpetual ${name}`,
    slug: `pancake-perpetual-${slugTag}`,
    invite_code: `${slugTag.replace(/[^a-z0-9]/g, '').toUpperCase()}0000000000000000`.slice(0, 16),
    commissioner_id: users[0].id,
    status: 'active',
    playoff_start_week: playoffStartWeek,
    scoring_settings: { points: 1, rebounds: 1, assists: 1 },
  }).select('id, faab_starting_budget, weekly_add_limit').single()
  throwOn(leagueError, `${name} league insert`)

  const { data: season, error: seasonError } = await supabase.from('league_seasons').insert({
    league_id: league.id,
    season_year: baseYear,
    is_current: true,
  }).select('id, season_year').single()
  throwOn(seasonError, `${name} season insert`)

  const { data: members, error: membersError } = await supabase.from('league_members')
    .insert(users.slice(0, memberCount).map((user, index) => ({
      league_id: league.id,
      user_id: user.id,
      role: index === 0 ? 'commissioner' : 'manager',
      team_name: `${name} Team ${index + 1}`,
    })))
    .select('id, user_id')
  throwOn(membersError, `${name} members insert`)

  const players = []
  for (const [index, member] of members.entries()) {
    const { data: player, error: playerError } = await supabase.from('players').insert({
      sportsdata_id: `perpetual-${slugTag}-${index}`,
      first_name: 'Perpetual',
      last_name: `${name} ${index + 1}`,
      position: 'PG',
      eligible_positions: ['PG'],
      status: 'Active',
      nba_team: 'SIM',
    }).select('id').single()
    throwOn(playerError, `${name} player insert`)
    players.push(player)
    const { error: rosterError } = await supabase.from('roster_players').insert({
      league_id: league.id,
      league_season_id: season.id,
      member_id: member.id,
      player_id: player.id,
      acquired_via: 'draft',
    })
    throwOn(rosterError, `${name} roster insert`)
  }

  // Season-1 schedule stands in for the commissioner's one-time initial
  // schedule generation; every later season must come from the automation.
  const rounds = roundRobin(members.map((member) => member.id))
  const rows = []
  for (let week = 1; week < playoffStartWeek; week += 1) {
    for (const { home, away } of rounds[(week - 1) % rounds.length]) {
      rows.push({
        league_id: league.id,
        league_season_id: season.id,
        week_number: week,
        home_member_id: home,
        away_member_id: away,
        matchup_type: 'regular_season',
      })
    }
  }
  const { error: matchupError } = await supabase.rpc('replace_regular_season_matchups_atomic', {
    p_league_id: league.id,
    p_league_season_id: season.id,
    p_force: false,
    p_matchups: rows,
  })
  throwOn(matchupError, `${name} initial matchups`)

  return {
    name,
    league,
    members,
    players,
    playoffStartWeek,
    playoffWeeks: memberCount >= 10 ? 3 : 2,
    season,
    seasonIndex: 0,
  }
}

async function seedSeasonWeeks(seasonYear, seasonIndex, throughWeek) {
  const rows = Array.from({ length: throughWeek }, (_, index) => ({
    season_year: seasonYear,
    week_number: index + 1,
    week_start: weekDates(seasonIndex, index + 1).start,
    week_end: weekDates(seasonIndex, index + 1).end,
  }))
  const { error } = await supabase.from('season_weeks')
    .upsert(rows, { onConflict: 'season_year,week_number' })
  throwOn(error, `season_weeks seed ${seasonYear}`)
}

async function seedWeekGameAndStats(ctx, weekNumber) {
  const { start } = weekDates(ctx.seasonIndex, weekNumber)
  const seasonYear = ctx.season.season_year
  const gameTag = `perpetual-${ctx.name}-${seasonYear}-w${weekNumber}`.toLowerCase().replace(/[^a-z0-9-]+/g, '')
  const { data: game, error: gameError } = await supabase.from('nba_games').insert({
    sportsdata_game_id: gameTag,
    nba_game_id: `SIM${seasonYear}W${weekNumber}`,
    season_year: seasonYear,
    game_date: start,
    week_number: weekNumber,
    home_team: 'SIM',
    away_team: 'ULA',
    status: 'Final',
    home_score: 100,
    away_score: 90,
  }).select('id').single()
  throwOn(gameError, `${ctx.name} game seed w${weekNumber}`)

  const statsRows = ctx.members.map((member, index) => ({
    player_id: ctx.players[index].id,
    game_id: game.id,
    season_year: seasonYear,
    week_number: weekNumber,
    game_date: start,
    // Deterministic member strength: earlier members score more, with a
    // week-parity wobble so records are not all-or-nothing.
    points: 20 + (ctx.members.length - index) * 2 + ((weekNumber + index) % 2),
    rebounds: 5,
    assists: 5,
  }))
  const { error: statsError } = await supabase.from('player_game_stats').insert(statsRows)
  throwOn(statsError, `${ctx.name} stats seed w${weekNumber}`)

  const lineupRows = ctx.members.map((member, index) => ({
    league_id: ctx.league.id,
    league_season_id: ctx.season.id,
    member_id: member.id,
    player_id: ctx.players[index].id,
    week_number: weekNumber,
    game_date: start,
    slot_type: 'PG',
  }))
  const { error: lineupError } = await supabase.from('weekly_lineups').insert(lineupRows)
  throwOn(lineupError, `${ctx.name} lineup seed w${weekNumber}`)
}

const count = async (table, filters) => {
  let query = supabase.from(table).select('id', { count: 'exact', head: true })
  for (const [key, value] of Object.entries(filters)) query = query.eq(key, value)
  const { count: total, error } = await query
  throwOn(error, `count ${table}`)
  return total ?? 0
}

async function matchupTypeCounts(ctx) {
  const { data, error } = await supabase
    .from('matchups')
    .select('matchup_type, week_number, is_finalized, winner_member_id')
    .eq('league_season_id', ctx.season.id)
  throwOn(error, `${ctx.name} matchup readback`)
  const byType = { regular_season: [], playoff_quarterfinal: [], playoff_semifinal: [], playoff_final: [] }
  for (const row of data ?? []) byType[row.matchup_type]?.push(row)
  return byType
}

async function boundaryTick(ctx, tickDate) {
  if (!BOUNDARY_ENABLED) return
  await callEdge('season-boundary', { date: tickDate, leagueId: ctx.league.id })
}

// Commissioner override: performs the manual button actions (bracket
// generation / advancement) the moment they become available, always ahead of
// the automation tick, mirroring a commissioner who never waits.
async function manualCommissionerActs(ctx) {
  const byType = await matchupTypeCounts(ctx)
  const bracketExists = byType.playoff_quarterfinal.length > 0 ||
    byType.playoff_semifinal.length > 0 || byType.playoff_final.length > 0
  const regularDone = byType.regular_season.length > 0 &&
    byType.regular_season.every((m) => m.is_finalized)
  if (!bracketExists && regularDone) {
    const { error } = await supabase.rpc('generate_playoff_bracket_atomic', { p_league_id: ctx.league.id })
    throwOn(error, `${ctx.name} manual bracket generate`)
    const { error: statusError } = await supabase.from('leagues')
      .update({ status: 'playoffs' }).eq('id', ctx.league.id)
    throwOn(statusError, `${ctx.name} manual status playoffs`)
    return
  }
  if (bracketExists && byType.playoff_final.length === 0) {
    const round = byType.playoff_semifinal.length > 0 ? byType.playoff_semifinal : byType.playoff_quarterfinal
    if (round.length > 0 && round.every((m) => m.is_finalized && m.winner_member_id != null)) {
      const { error } = await supabase.rpc('advance_playoff_bracket_atomic', { p_league_id: ctx.league.id })
      throwOn(error, `${ctx.name} manual bracket advance`)
    }
    return
  }
  const finals = byType.playoff_final
  if (finals.length > 0 && finals.every((m) => m.is_finalized && m.winner_member_id != null)) {
    // Commissioner advances the season first; the automation tick after must
    // only backfill missing matchups, never create a second season.
    const { error } = await supabase.rpc('advance_season_atomic', { p_league_id: ctx.league.id })
    throwOn(error, `${ctx.name} manual season advance`)
  }
}

async function assertBoundaryIdempotent(ctx, tickDate, label) {
  if (!BOUNDARY_ENABLED) return
  const before = {
    matchups: await count('matchups', { league_id: ctx.league.id }),
    seasons: await count('league_seasons', { league_id: ctx.league.id }),
  }
  await callEdge('season-boundary', { date: tickDate, leagueId: ctx.league.id })
  const after = {
    matchups: await count('matchups', { league_id: ctx.league.id }),
    seasons: await count('league_seasons', { league_id: ctx.league.id }),
  }
  if (before.matchups !== after.matchups || before.seasons !== after.seasons) {
    fail(`${ctx.name} ${label}: boundary re-run changed rows (matchups ${before.matchups}->${after.matchups}, seasons ${before.seasons}->${after.seasons})`)
  }
}

async function playSeason(ctx) {
  const psw = ctx.playoffStartWeek
  const finalWeek = psw + ctx.playoffWeeks - 1
  await seedSeasonWeeks(ctx.season.season_year, ctx.seasonIndex, finalWeek + 1)

  for (let week = 1; week <= finalWeek; week += 1) {
    await seedWeekGameAndStats(ctx, week)
    const { tick } = weekDates(ctx.seasonIndex, week)
    await callEdge('sync-scores', { date: tick, leagueId: ctx.league.id })
    if (ctx.manual) await manualCommissionerActs(ctx)
    await boundaryTick(ctx, tick)

    const byType = await matchupTypeCounts(ctx)
    if (week === 1) {
      const { data: weekOne, error: weekOneError } = await supabase
        .from('matchups')
        .select('home_points, away_points')
        .eq('league_season_id', ctx.season.id)
        .eq('week_number', 1)
      throwOn(weekOneError, `${ctx.name} week-1 readback`)
      if (!(weekOne ?? []).some((m) => Number(m.home_points) > 0 || Number(m.away_points) > 0)) {
        fail(`${ctx.name} season ${ctx.season.season_year}: week 1 did not score (no matchup points)`)
        return false
      }
    }
    if (week === psw - 1) {
      const unfinalized = byType.regular_season.filter((m) => !m.is_finalized)
      if (unfinalized.length > 0) {
        fail(`${ctx.name} season ${ctx.season.season_year}: ${unfinalized.length} regular-season matchups unfinalized after week ${week}`)
        return false
      }
      const regularWeeks = new Set(byType.regular_season.map((m) => m.week_number))
      if (Math.max(...regularWeeks) !== psw - 1 || Math.min(...regularWeeks) !== 1) {
        fail(`${ctx.name}: regular season spans weeks ${Math.min(...regularWeeks)}..${Math.max(...regularWeeks)}; expected 1..${psw - 1}`)
      }
      const firstRound = ctx.playoffWeeks === 3 ? byType.playoff_quarterfinal : byType.playoff_semifinal
      if (firstRound.length === 0) {
        fail(`${ctx.name} season ${ctx.season.season_year}: playoff bracket was not auto-generated after the last regular-season week finalized`)
        return false
      }
      const { data: leagueRow } = await supabase.from('leagues').select('status').eq('id', ctx.league.id).single()
      if (leagueRow?.status !== 'playoffs') {
        fail(`${ctx.name}: league status ${leagueRow?.status}; expected playoffs after bracket generation`)
      }
      if (firstRound.some((m) => m.week_number !== psw)) {
        fail(`${ctx.name}: first playoff round not at configured week ${psw}`)
      }
      await assertBoundaryIdempotent(ctx, tick, `bracket week ${week}`)
    }
    if (ctx.playoffWeeks === 3 && week === psw) {
      if (byType.playoff_semifinal.length === 0) {
        fail(`${ctx.name}: semifinals not auto-created after quarterfinal week finalized`)
        return false
      }
    }
    if (week === finalWeek - 1) {
      if (byType.playoff_final.length === 0) {
        fail(`${ctx.name}: final not auto-created after semifinal week finalized`)
        return false
      }
      await assertBoundaryIdempotent(ctx, tick, 'final created')
    }
  }
  return true
}

async function assertRollover(ctx) {
  const tickAfterFinal = weekDates(ctx.seasonIndex, ctx.playoffStartWeek + ctx.playoffWeeks).tick
  await boundaryTick(ctx, tickAfterFinal)

  const previousSeason = ctx.season
  const { data: currentSeason, error } = await supabase
    .from('league_seasons')
    .select('id, season_year, is_current')
    .eq('league_id', ctx.league.id)
    .eq('is_current', true)
    .single()
  throwOn(error, `${ctx.name} current season readback`)

  if (currentSeason.season_year !== previousSeason.season_year + 1) {
    fail(`${ctx.name}: season did not auto-roll (current year ${currentSeason.season_year}, was ${previousSeason.season_year})`)
    return false
  }
  const { data: leagueRow } = await supabase.from('leagues').select('status').eq('id', ctx.league.id).single()
  if (leagueRow?.status !== 'offseason') {
    fail(`${ctx.name}: league status ${leagueRow?.status}; expected offseason after rollover`)
  }
  const expectedMatchups = Math.floor(ctx.members.length / 2) * (ctx.playoffStartWeek - 1)
  const newMatchups = await count('matchups', { league_season_id: currentSeason.id })
  if (newMatchups !== expectedMatchups) {
    fail(`${ctx.name}: new season has ${newMatchups} matchups; expected ${expectedMatchups}`)
    return false
  }
  const waiverRows = await count('waiver_priorities', { league_season_id: currentSeason.id })
  if (waiverRows !== ctx.members.length) {
    fail(`${ctx.name}: new season waiver_priorities ${waiverRows}; expected ${ctx.members.length}`)
  }
  const totalSeasons = await count('league_seasons', { league_id: ctx.league.id })
  if (totalSeasons !== ctx.seasonIndex + 2) {
    fail(`${ctx.name}: ${totalSeasons} total seasons after rollover; expected ${ctx.seasonIndex + 2} (duplicate rollover?)`)
  }

  await assertBoundaryIdempotent(ctx, tickAfterFinal, 'post-rollover')

  // Carry rostered players into the new season context. Rollover carries
  // roster_players over, so only the harness bookkeeping updates here.
  ctx.season = currentSeason
  ctx.seasonIndex += 1

  // TODO(wave 3): replace with the rookie-draft week-1 auto-complete backstop;
  // the backstop is what flips offseason -> active with no commissioner.
  const { error: statusError } = await supabase
    .from('leagues')
    .update({ status: 'active' })
    .eq('id', ctx.league.id)
  throwOn(statusError, `${ctx.name} interim status flip`)
  log(`${ctx.name}: rolled over to season ${currentSeason.season_year} (${newMatchups} matchups generated)`)
  return true
}

async function runDbIntegrityChecks(contexts) {
  for (const ctx of contexts) {
    const { data: seasons, error } = await supabase
      .from('league_seasons')
      .select('id, season_year, is_current')
      .eq('league_id', ctx.league.id)
    throwOn(error, 'integrity seasons')
    const current = (seasons ?? []).filter((season) => season.is_current)
    if (current.length !== 1) fail(`${ctx.name}: ${current.length} current seasons; expected exactly 1`)
    const years = (seasons ?? []).map((season) => season.season_year)
    if (new Set(years).size !== years.length) fail(`${ctx.name}: duplicate league_seasons years ${years}`)

    const { data: matchups, error: matchupError } = await supabase
      .from('matchups')
      .select('id, league_season_id, matchup_type, week_number')
      .eq('league_id', ctx.league.id)
    throwOn(matchupError, 'integrity matchups')
    const seasonIds = new Set((seasons ?? []).map((season) => season.id))
    const orphans = (matchups ?? []).filter((m) => !seasonIds.has(m.league_season_id))
    if (orphans.length > 0) fail(`${ctx.name}: ${orphans.length} orphan matchups`)
    for (const season of seasons ?? []) {
      const finals = (matchups ?? []).filter((m) =>
        m.league_season_id === season.id && m.matchup_type === 'playoff_final')
      if (finals.length > 1) fail(`${ctx.name}: season ${season.season_year} has ${finals.length} playoff finals`)
    }

    for (const table of ['weekly_lineups', 'standings']) {
      const { data: rows, error: rowsError } = await supabase
        .from(table)
        .select('league_season_id')
        .eq('league_id', ctx.league.id)
      throwOn(rowsError, `integrity ${table}`)
      const orphanRows = (rows ?? []).filter((row) => !seasonIds.has(row.league_season_id))
      if (orphanRows.length > 0) fail(`${ctx.name}: ${orphanRows.length} orphan ${table} rows`)
    }

    // Every simulated nba_game must fall inside a season_weeks window for its
    // season year (schedule/week consistency).
    for (const season of seasons ?? []) {
      const { data: weeks } = await supabase.from('season_weeks')
        .select('week_number, week_start, week_end').eq('season_year', season.season_year)
      const { data: games } = await supabase.from('nba_games')
        .select('game_date').eq('season_year', season.season_year)
      const uncovered = (games ?? []).filter((game) =>
        !(weeks ?? []).some((week) => game.game_date >= week.week_start && game.game_date <= week.week_end))
      if (uncovered.length > 0) {
        fail(`${ctx.name}: season ${season.season_year} has ${uncovered.length} nba_games outside season_weeks`)
      }
    }
  }
}

const main = async () => {
  log(`perpetual-season: rollovers=${ROLLOVERS} boundary=${BOUNDARY_ENABLED ? 'enabled' : 'DISABLED (forced-red)'}`)
  log(`target: ${SUPABASE_URL}`)

  await callEdge('season-boundary', {}).catch((error) => {
    throw new Error(`season-boundary edge function is not reachable; run \`supabase functions serve\` (${error.message})`)
  })

  await cleanupPreviousRuns()
  const users = await ensureUsers(10)

  const contexts = [
    await createLeague({ name: 'Default', users, memberCount: 4, playoffStartWeek: 20, baseYear: 4210 }),
    await createLeague({ name: 'Custom', users, memberCount: 4, playoffStartWeek: 22, baseYear: 4220 }),
    await createLeague({ name: 'Sixseed', users, memberCount: 10, playoffStartWeek: 18, baseYear: 4230 }),
    Object.assign(
      await createLeague({ name: 'Manual', users, memberCount: 4, playoffStartWeek: 20, baseYear: 4240 }),
      { manual: true },
    ),
  ]

  for (let seasonNumber = 0; seasonNumber <= ROLLOVERS; seasonNumber += 1) {
    for (const ctx of contexts) {
      if (ctx.dead) continue
      log(`--- ${ctx.name}: playing season ${ctx.season.season_year} (season ${seasonNumber + 1}/${ROLLOVERS + 1}) ---`)
      const seasonComplete = await playSeason(ctx)
      if (!seasonComplete) {
        ctx.dead = true
        continue
      }
      if (seasonNumber < ROLLOVERS) {
        if (!await assertRollover(ctx)) ctx.dead = true
      } else {
        log(`${ctx.name}: final simulated season ${ctx.season.season_year} complete`)
      }
    }
    if (contexts.every((ctx) => ctx.dead)) break
  }

  await runDbIntegrityChecks(contexts)

  await mkdir(ARTIFACT_DIR, { recursive: true })
  const report = {
    finishedAt: new Date().toISOString(),
    rollovers: ROLLOVERS,
    boundaryEnabled: BOUNDARY_ENABLED,
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
    transcript,
  }
  await writeFile(path.join(ARTIFACT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)

  if (failures.length > 0) {
    log(`perpetual-season: FAIL (${failures.length} failure${failures.length === 1 ? '' : 's'})`)
    process.exitCode = 1
    return
  }
  log('perpetual-season: PASS — every boundary step ran with zero manual commissioner actions')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
