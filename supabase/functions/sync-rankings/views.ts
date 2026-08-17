import { RANKINGS_SOURCE } from './match.ts'

type RankingViewType = 'POINT' | 'CONTEND' | 'REBUILD' | 'ROOKIE'

export type RankingViewDefinition = {
  type: RankingViewType
  source: string
  minimumRows: number
}

// Write Points last so players.dynasty_rank uses the points-league source.
export const RANKING_VIEWS_IN_WRITE_ORDER: RankingViewDefinition[] = [
  { type: 'CONTEND', source: `${RANKINGS_SOURCE}/contend`, minimumRows: 300 },
  { type: 'REBUILD', source: `${RANKINGS_SOURCE}/rebuild`, minimumRows: 300 },
  { type: 'ROOKIE', source: `${RANKINGS_SOURCE}/rookie`, minimumRows: 30 },
  { type: 'POINT', source: RANKINGS_SOURCE, minimumRows: 300 },
]
