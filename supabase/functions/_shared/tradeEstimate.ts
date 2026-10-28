import { analyzeDynastyTrade, valueDynastyAsset, type DynastyPlayerAsset, type DynastyTradeRoute } from './dynastyEngine.ts'

type PlayerInput = {
  player_id: string
  display_name: string
  ranking_fetched_at: string | null
  projection_fetched_at: string | null
  projection_source: string | null
  age: number | null
  five_year_rank: number | null
  three_year_rank: number | null
  rank_change: number | null
  injury_status: string | null
  avg_fantasy_points: number | null
  projection_fantasy_points: number | null
  years_exp: number | null
  ranking_source: string | null
  trade_value?: number | null
}
export type EstimateTerm = {
  fromMemberId: string
  toMemberId: string
  playerId: string | null
  pickId: string | null
  faabAmount: number
}
export type TradeEstimateInputs = {
  leagueId: string
  seasonId: string
  seasonYear: number
  teams: number
  rosterSize: number
  scoringSettings: Record<string, number>
  faabBudget: number
  terms: EstimateTerm[]
  players: PlayerInput[]
  replacementPlayers: PlayerInput[]
  picks: { id: string; seasonYear: number; round: number; ownerId: string; originalOwnerId: string; originalTeamName: string; slot: number | null; valueBands?: { early: number; mid: number; late: number } | null; valueFetchedAt?: string | null }[]
}

function playerAsset(row: PlayerInput, observedAt: number): DynastyPlayerAsset {
  const rankingAt = Date.parse(row.ranking_fetched_at ?? '')
  const rankingFresh = Number.isFinite(rankingAt) && rankingAt <= observedAt && observedAt - rankingAt <= 90 * 86400000
  const projectionAt = Date.parse(row.projection_fetched_at ?? '')
  const projectionFresh = row.projection_source === 'season_avg' || Number.isFinite(projectionAt) &&
    projectionAt <= observedAt && observedAt - projectionAt <= (row.projection_source === 'internal' ? 8 * 86400000 : 36 * 3600000)
  return {
    kind: 'player', id: row.player_id, label: row.display_name, age: rankingFresh ? row.age : null,
    dynastyRank: rankingFresh ? row.five_year_rank : null, rankMovement: rankingFresh ? row.rank_change : null,
    tradeValue: row.trade_value,
    marketRanks: { overall: rankingFresh ? row.five_year_rank : null, contend: rankingFresh ? row.three_year_rank : null },
    healthStatus: row.injury_status, productionFantasyPoints: row.avg_fantasy_points,
    projectionFantasyPoints: projectionFresh ? row.projection_fantasy_points : null, isRookie: row.years_exp === 0,
    sources: [
      ...(row.ranking_source ? [{ name: rankingFresh ? row.ranking_source : `${row.ranking_source} (stale or unavailable)`, fetchedAt: row.ranking_fetched_at }] : []),
      ...(row.projection_source ? [{ name: projectionFresh ? row.projection_source : `${row.projection_source} (stale or unavailable)`, fetchedAt: row.projection_fetched_at }] : []),
      ...(row.avg_fantasy_points !== null ? [{ name: 'league season averages', fetchedAt: null }] : []),
    ],
  }
}

export function analyzeTradeEstimate(input: TradeEstimateInputs, observedAt: number) {
  const context = { leagueId: input.leagueId, seasonYear: input.seasonYear, scoringSettings: input.scoringSettings }
  const replacements = input.replacementPlayers.map(row => playerAsset(row, observedAt))
  const replacementValue = replacements.length
    ? Math.min(500, replacements.reduce((sum, asset) => sum + valueDynastyAsset(context, asset).values.overall, 0) / replacements.length)
    : Math.min(500, Math.max(50, 180 * 200 / Math.max(1, input.teams * input.rosterSize)))
  const qualityRows = input.replacementPlayers.filter(row => row.avg_fantasy_points !== null)
  const freeAgentQuality = qualityRows.length
    ? Math.min(1, Math.max(0, qualityRows.reduce((sum, row) => sum + (row.avg_fantasy_points ?? 0), 0) / qualityRows.length / 65)) : 0.5
  const routes: DynastyTradeRoute[] = input.terms.map(term => {
    const route = { fromMemberId: term.fromMemberId, toMemberId: term.toMemberId }
    if (term.playerId) {
      const row = input.players.find(player => player.player_id === term.playerId)
      if (!row) throw new Error('A selected player is missing from the frozen valuation inputs.')
      return { ...route, asset: playerAsset(row, observedAt) }
    }
    if (term.pickId) {
      const pick = input.picks.find(pick => pick.id === term.pickId)
      if (!pick) throw new Error('A selected pick is missing from the frozen valuation inputs.')
      return { ...route, asset: { kind: 'pick', id: pick.id, label: `${pick.seasonYear - 1} Round ${pick.round} · ${pick.originalTeamName}`,
        seasonYear: pick.seasonYear, round: pick.round, slot: pick.slot, teams: input.teams,
        valueBands: pick.valueBands,
        sources: [{ name: 'league draft picks', fetchedAt: null }] } }
    }
    return { ...route, asset: { kind: 'faab', id: `faab:${term.fromMemberId}:${term.toMemberId}`, label: `$${term.faabAmount} FAAB`,
      amount: term.faabAmount, budget: input.faabBudget, freeAgentQuality,
      sources: [{ name: 'league FAAB settings', fetchedAt: null }] } }
  })
  const analysis = analyzeDynastyTrade({ ...context, replacementValue }, 'overall', routes)
  analysis.assumptions.push(replacements.length
    ? `Replacement value uses ${replacements.length} available players in this league.`
    : `Replacement value uses a fallback for ${input.teams} teams and ${input.rosterSize} regular roster places.`)
  if (!replacements.length) analysis.missingInputs.push('replacement-player sample')
  if (!qualityRows.length && input.terms.some(term => term.faabAmount > 0)) analysis.missingInputs.push('free-agent production sample')
  return analysis
}
