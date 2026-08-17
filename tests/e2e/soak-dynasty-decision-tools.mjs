import { createRequire } from 'node:module'
import { signInSupabaseClient } from './soak-fixtures.mjs'

const require = createRequire(import.meta.url)
const { analyzeDynastyTrade, valueDynastyAssets } = require('../../core/cjs/dynasty/decisionEngine.js')
const clients = new Map()
const priorSeasonYear = new Map()

const stats = {
  points: 24,
  rebounds: 8,
  assists: 6,
  steals: 2,
  blocks: 1,
  turnovers: 3,
  threePointersMade: 3,
  fieldGoalsMade: 9,
  fieldGoalsAttempted: 18,
  freeThrowsMade: 3,
  freeThrowsAttempted: 4,
  doubleDouble: true,
  tripleDouble: false,
  didNotPlay: false,
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)
const player = (id, label, rank, points = stats) => ({
  kind: 'player', id, label, age: 24, dynastyRank: rank, rankMovement: 2,
  healthStatus: 'ACTIVE', productionStats: points, projectionStats: points,
  sources: [{ name: 'soak fixture', fetchedAt: new Date(0).toISOString() }],
})

const signedClient = async (env, user, password, season) => {
  if (clients.has(user.id)) return clients.get(user.id)
  const client = await signInSupabaseClient(env, user.email, password, `dynasty soak season ${season}`)
  clients.set(user.id, client)
  return client
}

export async function assertDynastyDecisionTools({ supabase, env, state, leagueId, season }) {
  const startedAt = performance.now()
  const failures = []
  const { data: league, error: leagueError } = await supabase.from('leagues')
    .select('id, scoring_settings, faab_starting_budget').eq('id', leagueId).single()
  if (leagueError || !league) throw new Error(`dynasty season ${season}: league read failed: ${leagueError?.message ?? 'missing row'}`)
  const { data: activeSeason, error: seasonError } = await supabase.from('league_seasons')
    .select('id, season_year').eq('league_id', leagueId).eq('is_current', true).single()
  if (seasonError || !activeSeason) throw new Error(`dynasty season ${season}: active season read failed: ${seasonError?.message ?? 'missing row'}`)
  const { data: members, error: memberError } = await supabase.from('league_members')
    .select('id, user_id').eq('league_id', leagueId).order('joined_at')
  if (memberError || !members || members.length < 3) throw new Error(`dynasty season ${season}: requires three league members`)

  const previousYear = priorSeasonYear.get(leagueId)
  if (previousYear != null && activeSeason.season_year <= previousYear) {
    failures.push(`active season did not advance: ${previousYear} -> ${activeSeason.season_year}`)
  }
  priorSeasonYear.set(leagueId, activeSeason.season_year)

  const memberByUser = new Map(members.map((member) => [member.user_id, member]))
  const firstUser = state.users[0]
  const secondUser = state.users[1]
  const firstMember = memberByUser.get(firstUser.id)
  const secondMember = memberByUser.get(secondUser.id)
  if (!firstMember || !secondMember) throw new Error(`dynasty season ${season}: seeded users are not target league members`)
  const firstClient = await signedClient(env, firstUser, state.password, season)
  const secondClient = await signedClient(env, secondUser, state.password, season)
  const rpcArgs = {
    p_league_id: leagueId,
    p_member_id: firstMember.id,
    p_season_year: activeSeason.season_year,
    p_player_ids: null,
    p_query: '',
    p_limit: 5,
    p_offset: 0,
  }
  const own = await firstClient.rpc('get_dynasty_decision_inputs', rpcArgs)
  if (own.error || !own.data?.length) failures.push(`authorized dynasty batch failed: ${own.error?.message ?? 'no rows'}`)
  if ((own.data?.length ?? 0) > 5) failures.push(`authorized dynasty batch exceeded limit: ${own.data.length}`)
  const wrongMember = await secondClient.rpc('get_dynasty_decision_inputs', rpcArgs)
  if (wrongMember.error || (wrongMember.data?.length ?? 0) !== 0) {
    failures.push(`cross-user dynasty read did not fail closed: ${wrongMember.error?.message ?? `${wrongMember.data.length} rows`}`)
  }

  const scoringSettings = league.scoring_settings && typeof league.scoring_settings === 'object'
    ? league.scoring_settings
    : {}
  const context = { leagueId, seasonYear: activeSeason.season_year, scoringSettings, replacementValue: 180 }
  const scoringProbe = player(`scoring-${season}`, 'Scoring probe', 20)
  const pick = {
    kind: 'pick', id: `pick-${season}`, label: `${activeSeason.season_year + 2} Round 1`,
    seasonYear: activeSeason.season_year + 2, round: 1, slot: null, teams: members.length,
  }
  const faab = {
    kind: 'faab', id: `faab-${season}`, label: '$25 FAAB', amount: 25,
    budget: league.faab_starting_budget ?? 100, freeAgentQuality: 0.5,
  }
  const rosterSlot = { kind: 'rosterSlot', id: `slot-${season}`, label: 'Roster slot', count: 1, replacementValue: 180 }
  const values = valueDynastyAssets(context, [scoringProbe, pick, faab, rosterSlot])
  for (const value of values) {
    for (const strategy of ['overall', 'contend', 'rebuild']) {
      if (!finite(value.values[strategy])) failures.push(`${value.kind} ${strategy} value is not finite`)
    }
  }
  const pickResult = values.find((value) => value.kind === 'pick')
  if (!pickResult?.ranges.overall || pickResult.ranges.overall.low >= pickResult.ranges.overall.high) {
    failures.push('unknown future pick did not retain an ordered value range')
  }
  const alternateContext = {
    ...context,
    scoringSettings: { ...scoringSettings, points: Number(scoringSettings.points ?? 1) + 2 },
  }
  const alternatePlayer = valueDynastyAssets(alternateContext, [scoringProbe])[0]
  if (alternatePlayer.components.shortTermPoints === values[0].components.shortTermPoints) {
    failures.push('player production ignored the season league scoring settings')
  }

  const [a, b, c] = members.slice(0, 3).map((member) => member.id)
  const twoTeam = analyzeDynastyTrade(context, 'overall', [
    { fromMemberId: a, toMemberId: b, asset: player(`a-${season}`, 'Player A', 15) },
    { fromMemberId: b, toMemberId: a, asset: pick },
    { fromMemberId: a, toMemberId: b, asset: faab },
  ])
  const multiTeam = analyzeDynastyTrade(context, 'rebuild', [
    { fromMemberId: a, toMemberId: b, asset: player(`a2-${season}`, 'Player A2', 10) },
    { fromMemberId: b, toMemberId: c, asset: player(`b-${season}`, 'Player B', 80) },
    { fromMemberId: c, toMemberId: a, asset: pick },
    { fromMemberId: a, toMemberId: c, asset: player(`a3-${season}`, 'Player A3', 300) },
  ])
  for (const { label, analysis, teamCount } of [
    { label: 'two-team', analysis: twoTeam, teamCount: 2 },
    { label: 'multi-team', analysis: multiTeam, teamCount: 3 },
  ]) {
    if (analysis.teams.length !== teamCount) failures.push(`${label} analysis returned ${analysis.teams.length} teams`)
    for (const team of analysis.teams) {
      for (const key of ['impact', 'shortTermPoints', 'longTermValue', 'packageEffect', 'replacementEffect', 'rosterSlotEffect']) {
        if (!finite(team[key])) failures.push(`${label} ${key} is not finite`)
      }
    }
  }

  const { data: picks, error: pickError } = await supabase.from('draft_picks')
    .select('id, season_year, round, current_owner_id, original_owner_id')
    .eq('league_id', leagueId).eq('is_used', false).limit(1000)
  if (pickError) throw new Error(`dynasty season ${season}: draft-pick read failed: ${pickError.message}`)
  const memberIds = new Set(members.map((member) => member.id))
  for (const row of picks ?? []) {
    if (!memberIds.has(row.current_owner_id) || !memberIds.has(row.original_owner_id)) {
      failures.push(`pick ${row.id} has an owner outside its league`)
    }
    if (!Number.isInteger(row.season_year) || !Number.isInteger(row.round)) failures.push(`pick ${row.id} has invalid year or round`)
  }

  return {
    failures,
    evidence: {
      season,
      activeSeasonYear: activeSeason.season_year,
      authorizedRows: own.data?.length ?? 0,
      unauthorizedRows: wrongMember.data?.length ?? 0,
      assetKinds: values.map((value) => value.kind),
      strategies: ['overall', 'contend', 'rebuild'],
      unknownPickRange: pickResult?.ranges.overall ?? null,
      twoTeamCount: twoTeam.teams.length,
      multiTeamCount: multiTeam.teams.length,
      draftPickCount: picks?.length ?? 0,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    },
  }
}
