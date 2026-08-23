export const CONFIGURED_GAME_SOURCES = Object.freeze([
  { id: 'nba-cdn', label: 'NBA CDN' },
  { id: 'espn-public-json', label: 'ESPN public JSON' },
  { id: 'fantasypros', label: 'FantasyPros projections' },
  { id: 'hashtag-basketball', label: 'Hashtag Basketball rankings' },
  { id: 'nba-draft-order', label: 'NBA.com draft order with stats.nba.com fallback' },
  { id: 'sleeper-fallback', label: 'Sleeper player fallback', disabled: true },
])

const DIMENSIONS = ['freshness', 'completeness', 'failures', 'recovery']
const HEALTHY_DIMENSION_STATUSES = new Set(['pass', 'expected-unavailable', 'disabled'])

export function evaluateConfiguredSourceHealth(observations) {
  const failures = []
  const knownIds = new Set(CONFIGURED_GAME_SOURCES.map((source) => source.id))
  const seen = new Set()

  for (const observation of observations) {
    if (!knownIds.has(observation.id)) failures.push(`unknown source: ${observation.id}`)
    if (seen.has(observation.id)) failures.push(`duplicate source: ${observation.id}`)
    seen.add(observation.id)
  }

  for (const source of CONFIGURED_GAME_SOURCES) {
    const observation = observations.find((candidate) => candidate.id === source.id)
    if (!observation) {
      failures.push(`missing source: ${source.id}`)
      continue
    }

    if (source.disabled && !observation.disabledReason?.trim()) {
      failures.push(`${source.id}: disabled source needs a reason`)
    }

    for (const dimension of DIMENSIONS) {
      const result = observation[dimension]
      if (!result?.evidence?.trim()) {
        failures.push(`${source.id}: ${dimension} evidence is missing`)
        continue
      }
      if (!HEALTHY_DIMENSION_STATUSES.has(result.status)) {
        failures.push(`${source.id}: ${dimension} is ${result.status ?? 'missing'}`)
      }
      if (source.disabled && result.status !== 'disabled') {
        failures.push(`${source.id}: ${dimension} must report disabled`)
      }
    }
  }

  return { pass: failures.length === 0, failures }
}

