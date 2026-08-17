import { RANKINGS_SOURCE } from './match.ts'

type RankingViewType = 'OVERALL' | 'CONTEND' | 'REBUILD' | 'ROOKIE'

export type RankingViewDefinition = {
  type: RankingViewType
  source: string
  minimumRows: number
}

// Write Overall last. The replacement RPC then leaves players.dynasty_rank
// on the canonical source after it stores the strategy-specific views.
export const RANKING_VIEWS_IN_WRITE_ORDER: RankingViewDefinition[] = [
  { type: 'CONTEND', source: `${RANKINGS_SOURCE}/contend`, minimumRows: 300 },
  { type: 'REBUILD', source: `${RANKINGS_SOURCE}/rebuild`, minimumRows: 300 },
  { type: 'ROOKIE', source: `${RANKINGS_SOURCE}/rookie`, minimumRows: 30 },
  { type: 'OVERALL', source: RANKINGS_SOURCE, minimumRows: 300 },
]
