export const DATA_LATENCY_STEP_KEYS = Object.freeze({
  'home-live-lineup': Object.freeze([
    'current-matchup',
    'week-matchups',
    'my-roster',
    'opponent-roster',
    'today-games',
  ]),
  'lineup-day-change': Object.freeze([
    'slot-templates',
    'lineup-assignments',
    'lock-context-games',
  ]),
  'player-search-filter': Object.freeze([
    'search-page',
    'owned-players',
    'waiver-players',
  ]),
  'player-detail-open': Object.freeze([
    'player',
    'seasons',
    'season-averages',
    'game-log',
    'projection',
  ]),
  'roster-review-manage': Object.freeze([
    'roster',
    'draft-picks',
    'waiver-claims',
    'waiver-priority',
  ]),
  'waiver-add-claim': Object.freeze([
    'waiver-wire',
    'transaction-state',
    'roster-choices',
  ]),
  'trade-review-act': Object.freeze([
    'trades',
    'roster-assets',
    'pick-assets',
  ]),
  'auction-draft-room': Object.freeze([
    'draft',
    'order',
    'budgets',
    'nominations',
  ]),
  'rookie-draft-room': Object.freeze([
    'draft',
    'pick-board',
    'player-board',
  ]),
  'dynasty-hub': Object.freeze([
    'rankings',
    'news',
    'roster-news-scope',
  ]),
})

export const assertDataLatencyStepDefinitions = (workflowId, steps) => {
  const expectedKeys = DATA_LATENCY_STEP_KEYS[workflowId]
  const actualKeys = steps.map((step) => step?.key)
  if (!expectedKeys || JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${workflowId} executable step keys do not match the canonical data latency contract`)
  }
}
