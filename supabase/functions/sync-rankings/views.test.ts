import { RANKING_VIEWS_IN_WRITE_ORDER } from './views.ts'

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

Deno.test('ranking views use unique sources and write Points last', () => {
  expect(new Set(RANKING_VIEWS_IN_WRITE_ORDER.map((view) => view.source)).size === 4, 'sources must be unique')
  expect(RANKING_VIEWS_IN_WRITE_ORDER.at(-1)?.type === 'POINT', 'Points must write last')
  expect(RANKING_VIEWS_IN_WRITE_ORDER.at(-1)?.source === 'hashtagbasketball.com', 'Points must use the canonical source')
})
