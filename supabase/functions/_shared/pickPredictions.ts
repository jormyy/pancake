export const PICK_PREDICTION_VERSION = 'pick-finish-v1'
const PICK_PREDICTION_RULES = {
  fullRosterPlaces: 10,
  halfRosterPlaces: 15,
  halfRosterWeight: 0.5,
  benchWeight: 0.1,
  logisticSpread: 0.25,
  thirdNormalQuantile: 0.43072729929545756,
  futureMidYears: 2,
  fallbackGames: 18,
} as const

export type PickTierOdds = { early: number; mid: number; late: number }
export type PickPredictionTeam = { id: string; wins: number; ties: number; players: { value: number; age: number | null }[] }
export type PickPredictionGame = { home: string; away: string }

export function pickAgeFactor(age: number | null): number {
  if (age == null || !Number.isFinite(age)) return 1
  const knots = [[18, 0.65], [24, 0.95], [27, 1], [29, 1], [40, 0.2]]
  if (age <= knots[0][0]) return knots[0][1]
  for (let index = 1; index < knots.length; index++) {
    const [upperAge, upperValue] = knots[index]
    const [lowerAge, lowerValue] = knots[index - 1]
    if (age <= upperAge) return lowerValue + (upperValue - lowerValue) * (age - lowerAge) / (upperAge - lowerAge)
  }
  return knots[knots.length - 1][1]
}

export function projectedPickStrength(players: PickPredictionTeam['players'], years = 0): number {
  return players.map(player => Math.max(0, player.value) * pickAgeFactor(player.age == null ? null : player.age + years))
    .sort((a, b) => b - a).reduce((sum, value, index) => sum + value * (index < PICK_PREDICTION_RULES.fullRosterPlaces ? 1
      : index < PICK_PREDICTION_RULES.halfRosterPlaces ? PICK_PREDICTION_RULES.halfRosterWeight : PICK_PREDICTION_RULES.benchWeight), 0)
}

function pickNormalCdf(z: number): number {
  if (z === 0) return 0.5
  const x = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * x)
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
    * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z > 0 ? 1 - tail : tail
}

export function predictPickFinishes(teams: PickPredictionTeam[], games: PickPredictionGame[], years = 0, seasonGames: number = PICK_PREDICTION_RULES.fallbackGames) {
  const strengths = new Map(teams.map(team => [team.id, projectedPickStrength(team.players, years)]))
  const scale = Math.max(1, teams.reduce((sum, team) => sum + strengths.get(team.id)!, 0) / Math.max(1, teams.length) * PICK_PREDICTION_RULES.logisticSpread)
  const moments = teams.map(team => {
    let expectedWins = years > 0 ? 0 : team.wins + team.ties / 2
    let variance = 0
    if (years > 0) {
      const gamesPerOpponent = Math.max(1, seasonGames) / Math.max(1, teams.length - 1)
      for (const opponent of teams) {
        if (opponent.id === team.id) continue
        const probability = 1 / (1 + Math.exp(-(strengths.get(team.id)! - strengths.get(opponent.id)!) / scale))
        expectedWins += gamesPerOpponent * probability
        variance += gamesPerOpponent * probability * (1 - probability)
      }
    } else {
      for (const game of games) {
        if (game.home !== team.id && game.away !== team.id) continue
        const opponent = game.home === team.id ? game.away : game.home
        if (!strengths.has(opponent)) throw new Error('A remaining matchup has an unknown team.')
        const probability = 1 / (1 + Math.exp(-(strengths.get(team.id)! - strengths.get(opponent)!) / scale))
        expectedWins += probability
        variance += probability * (1 - probability)
      }
    }
    return { memberId: team.id, strength: strengths.get(team.id)!, expectedWins, variance }
  })
  const mean = moments.reduce((sum, team) => sum + team.expectedWins, 0) / Math.max(1, moments.length)
  const spread = Math.sqrt(moments.reduce((sum, team) => sum + team.variance + (team.expectedWins - mean) ** 2, 0) / Math.max(1, moments.length))
  const earlyCutoff = mean - PICK_PREDICTION_RULES.thirdNormalQuantile * spread
  const lateCutoff = mean + PICK_PREDICTION_RULES.thirdNormalQuantile * spread
  const retained = Math.exp(-Math.max(0, years) / PICK_PREDICTION_RULES.futureMidYears)
  return moments.map(team => {
    const sd = Math.sqrt(team.variance)
    const early = sd > 0 ? pickNormalCdf((earlyCutoff - team.expectedWins) / sd) : team.expectedWins < earlyCutoff ? 1 : spread === 0 ? 1 / 3 : 0
    const late = sd > 0 ? 1 - pickNormalCdf((lateCutoff - team.expectedWins) / sd) : team.expectedWins > lateCutoff ? 1 : spread === 0 ? 1 / 3 : 0
    const odds = { early: early * retained, mid: 1 - (early + late) * retained, late: late * retained }
    return { ...team, odds }
  })
}

export function predictedPickValue(odds: PickTierOdds, bands: PickTierOdds): number {
  const sum = odds.early + odds.mid + odds.late
  if (Object.values(odds).some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(sum - 1) > 1e-8) throw new Error('Pick odds must sum to one.')
  return odds.early * bands.early + odds.mid * bands.mid + odds.late * bands.late
}
