import { PICK_PREDICTION_VERSION, predictedPickValue, predictPickFinishes, type PickPredictionGame, type PickPredictionTeam, type PickTierOdds } from './pickPredictions.ts'

type PickInput = { id: string; draftYear: number; round: number; originalOwnerId: string; slot: number | null; bands: PickTierOdds | null }
export type PickPredictionInput = { leagueId: string; seasonYear: number; sourceVersion: string; seasonGames: number; teams: PickPredictionTeam[]; games: PickPredictionGame[]; picks: PickInput[] }

export function buildPickPredictions(input: PickPredictionInput) {
  const horizons = new Map<number, ReturnType<typeof predictPickFinishes>>()
  return input.picks.flatMap(pick => {
    if (!pick.bands) return []
    const years = Math.max(0, pick.draftYear - input.seasonYear)
    if (!horizons.has(years)) horizons.set(years, predictPickFinishes(input.teams, input.games, years, input.seasonGames || undefined))
    const team = horizons.get(years)!.find(team => team.memberId === pick.originalOwnerId)
    if (!team) throw new Error('A pick has no original league team.')
    const known = pick.slot != null && pick.slot >= 1 && pick.slot <= input.teams.length
    const tier = !known ? null : pick.slot! <= Math.ceil(input.teams.length / 3) ? 'early' : pick.slot! <= Math.ceil(input.teams.length * 2 / 3) ? 'mid' : 'late'
    const odds = tier ? { early: Number(tier === 'early'), mid: Number(tier === 'mid'), late: Number(tier === 'late') } : team.odds
    return [{ id: pick.id, odds, bands: pick.bands, value: predictedPickValue(odds, pick.bands),
      details: { expectedWins: team.expectedWins, variance: team.variance, strength: team.strength, years, model: PICK_PREDICTION_VERSION } }]
  })
}
