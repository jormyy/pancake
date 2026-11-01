export function scoreMessage(value) {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(scoreMessage)
  if (['score','game','stat'].includes(value.topic)) return true
  if (['matchups','matchup_totals','player_game_stats','nba_games'].includes(value.table)) return true
  if (Array.isArray(value.sources) && value.sources.some(source => ['matchups','player_game_stats','nba_games'].includes(source))) return true
  return Object.values(value).some(scoreMessage)
}

export function qualityGrade({ actions, freshness, realtime, policies, liveForecasts, observedAt = Date.now(), requireLimits = false, requirePolicies = false }) {
  const gates = {}
  for (const name of ['rosterMove','lineupSave','tradeOffer','tradeAccept','waiverResult']) {
    const row = actions?.records.find(record => record.name === name)
    gates[name] = { passed: Boolean(row?.passed && (!requireLimits || Number.isFinite(row.limitMs))), latencyMs: row?.latencyMs ?? null, limitMs: row?.limitMs ?? null, error: row?.error ?? null }
  }
  gates.scoreFreshness = { passed: freshness.samples > 0 && freshness.p95Ms != null && freshness.p95Ms <= 45000, p95Ms: freshness.p95Ms, limitMs: 45000 }
  gates.realtimeScores = { passed: Boolean(realtime.subscribed && realtime.scoreMessages > 0), messages: realtime.scoreMessages ?? 0 }
  for (const name of ['injuries','forecasts']) gates[name] = { passed: Boolean(policies?.[name]?.passed), required: requirePolicies }
  gates.forecastDelivery = { passed: liveForecasts?.length === 5 && liveForecasts.every(row => Date.parse(row.valid_until) > observedAt && observedAt - Date.parse(row.calculated_at) <= 1800000), required: requirePolicies, rows: liveForecasts?.length ?? 0 }
  return { passed: Object.values(gates).every(gate => gate.passed || gate.required === false), gates }
}
