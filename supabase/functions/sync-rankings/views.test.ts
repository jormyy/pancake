import { RANKING_VIEWS_IN_WRITE_ORDER, rankingViewForRequest } from './views.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('ranking views contain only 3-year, rookie, and canonical 5-year sources', () => {
  expect(RANKING_VIEWS_IN_WRITE_ORDER.map((view) => view.type).join(',') === 'POINT_3,ROOKIE,POINT_5', 'unexpected view order')
  expect(new Set(RANKING_VIEWS_IN_WRITE_ORDER.map((view) => view.source)).size === 3, 'sources must be unique')
  expect(RANKING_VIEWS_IN_WRITE_ORDER[0].forecastSeasons === 3, '3-year view must request three seasons')
  expect(RANKING_VIEWS_IN_WRITE_ORDER.at(-1)?.forecastSeasons === 5, '5-year view must request five seasons')
  expect(RANKING_VIEWS_IN_WRITE_ORDER.at(-1)?.source === 'hashtagbasketball.com', '5-year view must use the canonical source')
  expect(rankingViewForRequest('POINT')?.type === 'POINT', 'rollback POINT alias is missing')
  expect(rankingViewForRequest('CONTEND')?.type === 'CONTEND', 'rollback CONTEND alias is missing')
  expect(rankingViewForRequest('REBUILD')?.type === 'REBUILD', 'rollback REBUILD alias is missing')
})
