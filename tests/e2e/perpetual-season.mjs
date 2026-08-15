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
const PUBLIC_KEY = process.env.PERPETUAL_SUPABASE_PUBLISHABLE_KEY ?? status.PUBLISHABLE_KEY ?? status.ANON_KEY

// Some manager RPCs (adds, drops, claims) authorize via auth.uid(); the
// offseason scenario calls them as real signed-in users, not service role.
async function signedInClient(email) {
  const client = createClient(SUPABASE_URL, PUBLIC_KEY, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password: 'perpetual-season-pass-1' })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
  return client
}

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

// Shared rookie pool for the auto-complete backstop: auto_pick selects the
// lowest nba_draft_number not yet rostered in the league.
async function seedRookiePool() {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    sportsdata_id: `perpetual-rookie-${index + 1}`,
    first_name: 'Rookie',
    last_name: `Prospect ${index + 1}`,
    position: 'SG',
    eligible_positions: ['SG'],
    status: 'Active',
    nba_team: 'SIM',
    years_exp: 0,
    nba_draft_number: index + 1,
  }))
  const { error } = await supabase.from('players').insert(rows)
  throwOn(error, 'rookie pool seed')
}

async function cleanupPreviousRuns() {
  const { data: leagues, error } = await supabase
    .from('leagues')
    .select('id')
    .like('slug', 'pancake-perpetual-%')
  throwOn(error, 'cleanup league lookup')
  for (const league of leagues ?? []) {
    const { error: pickRefError } = await supabase.from('draft_picks')
      .update({ rookie_draft_id: null }).eq('league_id', league.id)
    throwOn(pickRefError, 'cleanup draft pick refs')
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

  const { error: priorityError } = await supabase.from('waiver_priorities').insert(
    members.map((member, index) => ({
      league_id: league.id,
      league_season_id: season.id,
      member_id: member.id,
      priority: index + 1,
    })),
  )
  throwOn(priorityError, `${name} waiver priorities seed`)

  // Five-year pick bank, as create_league seeds for real leagues; the rookie
  // draft backstop consumes these at each new season's week 1.
  const pickRows = []
  for (const member of members) {
    for (let year = baseYear + 1; year <= baseYear + 3; year += 1) {
      for (let round = 1; round <= 3; round += 1) {
        pickRows.push({
          league_id: league.id,
          season_year: year,
          round,
          original_owner_id: member.id,
          current_owner_id: member.id,
        })
      }
    }
  }
  const { error: pickError } = await supabase.from('draft_picks').insert(pickRows)
  throwOn(pickError, `${name} draft_picks seed`)

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
    users: users.slice(0, memberCount),
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
  const result = await callEdge('season-boundary', { date: tickDate, leagueId: ctx.league.id })
  for (const report of result?.leagues ?? []) {
    if (report.error) fail(`${ctx.name}: boundary tick error: ${report.error}`)
  }
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
    if (week === 1 && ctx.seasonIndex > 0 && BOUNDARY_ENABLED) {
      await assertRookieDraftBackstop(ctx)
    }

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
  await assertRolloverCompleteness(ctx, previousSeason, currentSeason)
  if (ctx.offseasonScenario) await runOffseasonOpenScenario(ctx, currentSeason)

  // Rollover carries roster_players over; the harness only updates its own
  // bookkeeping here. The league stays 'offseason' until the rookie-draft
  // backstop completes at the new season's week 1.
  ctx.season = currentSeason
  ctx.seasonIndex += 1
  log(`${ctx.name}: rolled over to season ${currentSeason.season_year} (${newMatchups} matchups generated)`)
  return true
}

// AC: rookie-draft backstop. A league whose rookie draft never ran reaches
// new-season week 1 with the draft auto-completed best-available: every team
// holds its picks' players on its roster, nothing dumped to waivers, and the
// league is active again with no commissioner.
async function assertRookieDraftBackstop(ctx) {
  const { data: leagueRow } = await supabase.from('leagues').select('status').eq('id', ctx.league.id).single()
  if (leagueRow?.status !== 'active') {
    fail(`${ctx.name}: league status ${leagueRow?.status} after week-1 backstop; expected active`)
    return
  }
  const { data: drafts } = await supabase.from('drafts')
    .select('id, status, completed_at')
    .eq('league_season_id', ctx.season.id)
    .eq('draft_type', 'snake')
    .eq('is_mock', false)
  if ((drafts ?? []).length !== 1 || drafts[0].status !== 'completed') {
    fail(`${ctx.name}: rookie draft not auto-completed at week 1 (${drafts?.[0]?.status ?? 'missing'})`)
    return
  }
  const { data: picks } = await supabase.from('snake_draft_picks')
    .select('member_id, player_id, picked_at')
    .eq('draft_id', drafts[0].id)
  const unfilled = (picks ?? []).filter((pick) => !pick.player_id || !pick.picked_at)
  if (unfilled.length > 0) {
    fail(`${ctx.name}: ${unfilled.length} rookie draft slots unfilled after backstop`)
    return
  }
  for (const pick of picks ?? []) {
    const rostered = await count('roster_players', {
      league_season_id: ctx.season.id, member_id: pick.member_id, player_id: pick.player_id,
    })
    if (rostered !== 1) {
      fail(`${ctx.name}: rookie pick ${pick.player_id} not on the picking team's roster`)
      return
    }
  }
  const { count: waived } = await supabase.from('waiver_wire_log')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', ctx.league.id)
    .in('player_id', (picks ?? []).map((pick) => pick.player_id))
  if ((waived ?? 0) > 0) {
    fail(`${ctx.name}: ${waived} drafted rookies were dumped to waivers`)
  }
  log(`${ctx.name}: rookie draft auto-completed best-available at week 1 (${picks?.length} picks)`)
}

// AC: rollover completeness. Waiver priority reflects inverse final
// standings, FAAB budgets equal the configured amount, add-limit counters are
// fresh, and the rookie draft has a default scheduled date.
async function assertRolloverCompleteness(ctx, previousSeason, currentSeason) {
  const { data: seasonRow } = await supabase.from('league_seasons')
    .select('rookie_draft_scheduled_at').eq('id', currentSeason.id).single()
  if (!seasonRow?.rookie_draft_scheduled_at) {
    fail(`${ctx.name}: rollover did not stamp a default rookie_draft_scheduled_at`)
  }

  const { data: faab } = await supabase.from('faab_balances')
    .select('member_id, balance').eq('league_season_id', currentSeason.id)
  if ((faab ?? []).length !== ctx.members.length) {
    fail(`${ctx.name}: ${faab?.length ?? 0} FAAB balances in new season; expected ${ctx.members.length}`)
  } else if ((faab ?? []).some((row) => Number(row.balance) !== Number(ctx.league.faab_starting_budget))) {
    fail(`${ctx.name}: new-season FAAB balances not reset to configured ${ctx.league.faab_starting_budget}`)
  }

  const { count: addCounts } = await supabase.from('weekly_add_counts')
    .select('id', { count: 'exact', head: true })
    .eq('league_season_id', currentSeason.id)
    .gt('add_count', 0)
  if ((addCounts ?? 0) !== 0) {
    fail(`${ctx.name}: new season starts with ${addCounts} nonzero weekly add counters`)
  }

  const { data: standings } = await supabase.from('standings')
    .select('member_id, wins, points_for, week_number')
    .eq('league_season_id', previousSeason.id)
    .order('week_number', { ascending: false })
  const finalByMember = new Map()
  for (const row of standings ?? []) {
    if (!finalByMember.has(row.member_id)) finalByMember.set(row.member_id, row)
  }
  const expectedWorstFirst = [...finalByMember.values()]
    .sort((a, b) => a.wins - b.wins || a.points_for - b.points_for)
  const { data: priorities } = await supabase.from('waiver_priorities')
    .select('member_id, priority').eq('league_season_id', currentSeason.id)
  const priorityOne = (priorities ?? []).find((row) => row.priority === 1)
  if (expectedWorstFirst.length > 0 && priorityOne?.member_id !== expectedWorstFirst[0]?.member_id) {
    fail(`${ctx.name}: waiver priority 1 is not the worst final-standings team`)
  }
}

// AC: offseason fully open. Between the bracket final and new-season week 1
// (league status 'offseason'), an add, a drop, a waiver claim, and a trade
// all succeed, and the trade lands in rosters and the pick ledger.
async function runOffseasonOpenScenario(ctx, currentSeason) {
  const label = `${ctx.name} offseason`
  const suffix = `${ctx.seasonIndex}-${currentSeason.season_year}`
  const mkPlayer = async (tag) => {
    const { data, error } = await supabase.from('players').insert({
      sportsdata_id: `perpetual-offseason-${tag}-${suffix}`,
      first_name: 'Offseason',
      last_name: `${tag} ${suffix}`,
      position: 'SF',
      eligible_positions: ['SF'],
      status: 'Active',
      nba_team: 'SIM',
    }).select('id').single()
    throwOn(error, `${label} player ${tag}`)
    return data
  }
  const [adder, claimer] = [ctx.members[2], ctx.members[3]]
  // Trade the first two original starters between their CURRENT owners (a
  // prior season's offseason trade may already have moved them).
  const ownerOf = async (playerId) => {
    const { data, error } = await supabase.from('roster_players')
      .select('member_id').eq('league_season_id', currentSeason.id).eq('player_id', playerId).single()
    throwOn(error, `${label} owner lookup`)
    return ctx.members.find((member) => member.id === data.member_id)
  }
  const proposer = await ownerOf(ctx.players[0].id)
  let recipient = await ownerOf(ctx.players[1].id)
  if (recipient.id === proposer.id) recipient = ctx.members.find((member) => member.id !== proposer.id)

  // Add, as the signed-in manager (RPC authorizes via auth.uid())
  const addTarget = await mkPlayer('add')
  const adderIndex = ctx.members.indexOf(adder)
  const adderClient = await signedInClient(ctx.users[adderIndex].email)
  const { error: addError } = await adderClient.rpc('add_free_agent_atomic', {
    p_member_id: adder.id, p_league_id: ctx.league.id, p_player_id: addTarget.id,
  })
  if (addError) {
    fail(`${label}: free-agent add failed: ${addError.message}`)
    return
  }

  // Drop (puts the player on the waiver wire)
  const { data: rosterRow } = await supabase.from('roster_players')
    .select('id').eq('league_season_id', currentSeason.id)
    .eq('member_id', adder.id).eq('player_id', addTarget.id).single()
  const { error: dropError } = await adderClient.rpc('drop_player_atomic', {
    p_roster_player_id: rosterRow?.id,
  })
  if (dropError) {
    fail(`${label}: drop failed: ${dropError.message}`)
    return
  }
  await adderClient.auth.signOut()

  // Waiver claim on the dropped player by another member
  const { error: claimError } = await supabase.rpc('create_waiver_claim_atomic', {
    p_league_id: ctx.league.id, p_member_id: claimer.id, p_player_id: addTarget.id,
  })
  if (claimError) {
    fail(`${label}: waiver claim failed: ${claimError.message}`)
    return
  }
  // Simulate the waiver window elapsing: clears_at is stamped ~2 real days
  // out; the harness clock is far past that.
  const { error: clearsError } = await supabase.from('waiver_wire_log')
    .update({ clears_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('league_id', ctx.league.id).eq('player_id', addTarget.id)
  throwOn(clearsError, `${label} waiver clears_at`)
  const { data: processed, error: processError } = await supabase.rpc('process_due_waiver_claims_atomic', {
    p_process_date: '2199-01-01', p_limit: 100,
  })
  throwOn(processError, `${label} waiver processing`)
  const claimedCount = await count('roster_players', {
    league_season_id: currentSeason.id, member_id: claimer.id, player_id: addTarget.id,
  })
  if (claimedCount !== 1) {
    const rows = (processed ?? []).map((row) => `${row.status}:${row.failure_reason ?? ''}`).join(', ')
    fail(`${label}: processed waiver claim did not roster the player (results: ${rows || 'none'})`)
  }

  // Trade: proposer's original starter + a future pick for recipient's starter
  const { data: proposerPick } = await supabase.from('draft_picks')
    .select('id').eq('league_id', ctx.league.id)
    .eq('current_owner_id', proposer.id).eq('is_used', false)
    .order('season_year', { ascending: false }).limit(1).single()
  const { data: trade, error: tradeError } = await supabase.from('trades').insert({
    league_id: ctx.league.id,
    league_season_id: currentSeason.id,
    proposer_member_id: proposer.id,
    recipient_member_id: recipient.id,
    status: 'pending',
    notes: 'perpetual offseason trade',
  }).select('id').single()
  throwOn(tradeError, `${label} trade insert`)
  const { error: participantError } = await supabase.from('trade_participants').insert([
    { trade_id: trade.id, member_id: proposer.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() },
    { trade_id: trade.id, member_id: recipient.id, sort_order: 1, is_initiator: false, accepted_at: null },
  ])
  throwOn(participantError, `${label} trade participants`)
  const recipientOwnsSecondStarter = (await count('roster_players', {
    league_season_id: currentSeason.id, member_id: recipient.id, player_id: ctx.players[1].id,
  })) === 1
  const { error: itemError } = await supabase.from('trade_items').insert([
    { trade_id: trade.id, side: 'proposer', player_id: ctx.players[0].id, pick_id: null, from_member_id: proposer.id, to_member_id: recipient.id },
    { trade_id: trade.id, side: 'proposer', player_id: null, pick_id: proposerPick?.id, from_member_id: proposer.id, to_member_id: recipient.id },
    ...(recipientOwnsSecondStarter
      ? [{ trade_id: trade.id, side: 'recipient', player_id: ctx.players[1].id, pick_id: null, from_member_id: recipient.id, to_member_id: proposer.id }]
      : []),
  ])
  throwOn(itemError, `${label} trade items`)
  const { error: acceptError } = await supabase.rpc('accept_trade_atomic', {
    p_trade_id: trade.id, p_accepting_member_id: recipient.id,
  })
  if (acceptError) {
    fail(`${label}: trade accept failed: ${acceptError.message}`)
    return
  }
  const { error: windowError } = await supabase.from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('id', trade.id)
  throwOn(windowError, `${label} veto window expiry`)
  await callEdge('process-trades', {})
  const { data: tradedRoster } = await supabase.from('roster_players')
    .select('member_id').eq('league_season_id', currentSeason.id)
    .eq('player_id', ctx.players[0].id).single()
  if (tradedRoster?.member_id !== recipient.id) {
    fail(`${label}: traded player did not move to the recipient's new-season roster`)
  }
  const { data: tradedPick } = await supabase.from('draft_picks')
    .select('current_owner_id').eq('id', proposerPick?.id).single()
  if (tradedPick?.current_owner_id !== recipient.id) {
    fail(`${label}: traded pick did not change owners in the pick ledger`)
  }
  log(`${label}: add, drop, waiver claim, and trade all succeeded in the offseason window`)
}

// AC: stat-correction safety. A correction inside the 48h grace window
// re-decides the matchup before the bracket advances; a correction after
// advancement updates stat rows but never re-decides the closed matchup.
async function runGraceCorrectionScenario(users) {
  const ctx = await createLeague({ name: 'Grace', users, memberCount: 4, playoffStartWeek: 18, baseYear: 4250 })
  const psw = ctx.playoffStartWeek
  await seedSeasonWeeks(ctx.season.season_year, 0, psw + 2)
  for (let week = 1; week < psw; week += 1) {
    await seedWeekGameAndStats(ctx, week)
    const { tick } = weekDates(0, week)
    await callEdge('sync-scores', { date: tick, leagueId: ctx.league.id })
    await boundaryTick(ctx, tick)
  }
  await seedWeekGameAndStats(ctx, psw)
  const sfTick = weekDates(0, psw).tick
  await callEdge('sync-scores', { date: sfTick, leagueId: ctx.league.id })

  const readSemis = async () => {
    const { data, error } = await supabase.from('matchups')
      .select('id, home_member_id, away_member_id, winner_member_id, home_points, away_points')
      .eq('league_season_id', ctx.season.id)
      .eq('matchup_type', 'playoff_semifinal')
      .order('id')
    throwOn(error, 'Grace semifinal readback')
    return data ?? []
  }
  const pinFinalizedAt = async () => {
    const { error } = await supabase.from('matchups')
      .update({ finalized_at: sfTick })
      .eq('league_season_id', ctx.season.id)
      .eq('matchup_type', 'playoff_semifinal')
    throwOn(error, 'Grace finalized_at pin')
  }
  await pinFinalizedAt()

  const insideGrace = new Date(Date.parse(sfTick) + 3_600_000).toISOString()
  await callEdge('season-boundary', { date: insideGrace, leagueId: ctx.league.id })
  if (await count('matchups', { league_season_id: ctx.season.id, matchup_type: 'playoff_final' }) !== 0) {
    fail('Grace: final was created inside the 48h stat-correction grace window')
    return
  }
  log('Grace: boundary correctly waited inside the 48h grace window')

  const semis = await readSemis()
  const target = semis[0]
  const originalWinner = target.winner_member_id
  const flippedWinner = originalWinner === target.home_member_id ? target.away_member_id : target.home_member_id
  const flippedIndex = ctx.members.findIndex((member) => member.id === flippedWinner)
  const correctStats = async (points) => {
    const { error } = await supabase.from('player_game_stats')
      .update({ points, updated_at: new Date().toISOString() })
      .eq('player_id', ctx.players[flippedIndex].id)
      .eq('season_year', ctx.season.season_year)
      .eq('week_number', psw)
    throwOn(error, 'Grace stat correction')
  }
  await correctStats(500)
  await callEdge('sync-scores', { date: sfTick, leagueId: ctx.league.id })
  const correctedSemis = await readSemis()
  const corrected = correctedSemis.find((m) => m.id === target.id)
  if (corrected?.winner_member_id !== flippedWinner) {
    fail(`Grace: in-window correction did not re-decide the matchup (winner ${corrected?.winner_member_id}, expected ${flippedWinner})`)
    return
  }
  log('Grace: in-window stat correction re-decided the semifinal before advancement')
  await pinFinalizedAt()

  const afterGrace = new Date(Date.parse(sfTick) + 49 * 3_600_000).toISOString()
  await callEdge('season-boundary', { date: afterGrace, leagueId: ctx.league.id })
  const { data: finals } = await supabase.from('matchups')
    .select('home_member_id, away_member_id')
    .eq('league_season_id', ctx.season.id)
    .eq('matchup_type', 'playoff_final')
  if ((finals ?? []).length !== 1) {
    fail('Grace: final was not created after the grace window elapsed')
    return
  }
  const finalists = [finals[0].home_member_id, finals[0].away_member_id]
  if (!finalists.includes(flippedWinner)) {
    fail('Grace: bracket advanced with the pre-correction winner')
  }

  // Post-advancement correction: stat rows update, closed matchup does not.
  await correctStats(1)
  await callEdge('sync-scores', { date: afterGrace, leagueId: ctx.league.id })
  const lockedSemis = await readSemis()
  const locked = lockedSemis.find((m) => m.id === target.id)
  if (locked?.winner_member_id !== flippedWinner) {
    fail(`Grace: post-advancement correction re-decided a closed playoff matchup (winner ${locked?.winner_member_id})`)
  } else {
    log('Grace: post-advancement correction left the closed semifinal immutable')
  }
  const { data: statRow } = await supabase.from('player_game_stats')
    .select('points')
    .eq('player_id', ctx.players[flippedIndex].id)
    .eq('season_year', ctx.season.season_year)
    .eq('week_number', psw)
    .single()
  if (Number(statRow?.points) !== 1) {
    fail(`Grace: post-advancement correction did not persist to stat rows (points ${statRow?.points})`)
  }
}

// AC: 150+ due waiver claims across leagues all drain in ONE processor run.
async function runWaiverDrainScenario(users) {
  const leagues = []
  for (let index = 0; index < 4; index += 1) {
    leagues.push(await createLeague({
      name: `Drain${index}`, users, memberCount: 2, playoffStartWeek: 20, baseYear: 4260 + index * 2,
    }))
  }
  const pastDate = new Date(Date.now() - 86_400_000).toISOString()
  let totalClaims = 0
  for (const ctx of leagues) {
    const playerRows = Array.from({ length: 40 }, (_, index) => ({
      sportsdata_id: `perpetual-drain-${ctx.name}-${index}`.toLowerCase(),
      first_name: 'Drain',
      last_name: `${ctx.name} ${index}`,
      position: 'C',
      eligible_positions: ['C'],
      status: 'Active',
      nba_team: 'SIM',
    }))
    const { data: players, error: playersError } = await supabase.from('players')
      .insert(playerRows).select('id')
    throwOn(playersError, `${ctx.name} drain players`)
    const { error: wireError } = await supabase.from('waiver_wire_log').insert(players.map((player) => ({
      league_id: ctx.league.id,
      league_season_id: ctx.season.id,
      player_id: player.id,
      clears_at: pastDate,
    })))
    throwOn(wireError, `${ctx.name} wire log`)
    // A trigger stamps clears_at from league waiver rules on insert; simulate
    // the waiver window having elapsed.
    const { error: clearsError } = await supabase.from('waiver_wire_log')
      .update({ clears_at: pastDate })
      .eq('league_id', ctx.league.id)
    throwOn(clearsError, `${ctx.name} wire log clears_at`)
    const { error: claimError } = await supabase.from('waiver_claims').insert(players.map((player, index) => ({
      league_id: ctx.league.id,
      league_season_id: ctx.season.id,
      member_id: ctx.members[1].id,
      player_id: player.id,
      priority_at_submission: 1,
      process_date: pastDate.slice(0, 10),
      bid_amount: 0,
      claim_order: index + 1,
    })))
    throwOn(claimError, `${ctx.name} claims`)
    totalClaims += players.length
  }

  await callEdge('process-waivers', {})

  let pending = 0
  for (const ctx of leagues) {
    pending += await count('waiver_claims', { league_id: ctx.league.id, status: 'pending' })
  }
  if (pending > 0) {
    fail(`waiver drain: ${pending} of ${totalClaims} due claims still pending after one processor run`)
  } else {
    log(`waiver drain: all ${totalClaims} due claims across ${leagues.length} leagues drained in one run`)
  }
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

  await seedRookiePool()
  const contexts = [
    Object.assign(
      await createLeague({ name: 'Default', users, memberCount: 4, playoffStartWeek: 20, baseYear: 4210 }),
      { offseasonScenario: true },
    ),
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

  if (BOUNDARY_ENABLED) await runGraceCorrectionScenario(users)
  if (BOUNDARY_ENABLED) await runWaiverDrainScenario(users)
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
