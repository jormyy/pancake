import { RANKINGS_SOURCE } from './match.ts'

type RankingViewType = 'POINT_5' | 'POINT_3' | 'ROOKIE' | 'POINT' | 'CONTEND' | 'REBUILD'

export type RankingViewDefinition = {
  type: RankingViewType
  hashtagType: 'POINT' | 'ROOKIE' | 'CONTEND' | 'REBUILD'
  forecastSeasons: 3 | 5
  source: string
  minimumRows: number
}

// Write the five-year list last so players.dynasty_rank uses the canonical forecast.
export const RANKING_VIEWS_IN_WRITE_ORDER: RankingViewDefinition[] = [
  { type: 'POINT_3', hashtagType: 'POINT', forecastSeasons: 3, source: `${RANKINGS_SOURCE}/points-3`, minimumRows: 300 },
  { type: 'ROOKIE', hashtagType: 'ROOKIE', forecastSeasons: 5, source: `${RANKINGS_SOURCE}/rookie`, minimumRows: 30 },
  { type: 'POINT_5', hashtagType: 'POINT', forecastSeasons: 5, source: RANKINGS_SOURCE, minimumRows: 300 },
]

const LEGACY_RANKING_VIEWS: RankingViewDefinition[] = [
  { type: 'POINT', hashtagType: 'POINT', forecastSeasons: 5, source: RANKINGS_SOURCE, minimumRows: 300 },
  { type: 'CONTEND', hashtagType: 'CONTEND', forecastSeasons: 5, source: `${RANKINGS_SOURCE}/contend`, minimumRows: 300 },
  { type: 'REBUILD', hashtagType: 'REBUILD', forecastSeasons: 5, source: `${RANKINGS_SOURCE}/rebuild`, minimumRows: 300 },
]

export const rankingViewForRequest = (type: string): RankingViewDefinition | undefined =>
  [...RANKING_VIEWS_IN_WRITE_ORDER, ...LEGACY_RANKING_VIEWS].find((view) => view.type === type)
