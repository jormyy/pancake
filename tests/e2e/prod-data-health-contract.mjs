const number = (value) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : NaN
}

/** @param {Date} now */
export const productionDataThresholds = (now = new Date()) => {
  const month = now.getUTCMonth()
  const activeSeason = month <= 5 || month >= 9
  return {
    minPlayers: 100,
    minCurrentSeasonGames: 1,
    minProjections: 1,
    maxProjectionAgeDays: activeSeason ? 7 : 45,
  }
}

/** @param {any} sourceHealth @param {Date} now */
export const evaluateProductionDataHealth = (sourceHealth, now = new Date()) => {
  const thresholds = productionDataThresholds(now)
  const failures = []
  const players = number(sourceHealth?.players)
  const games = number(sourceHealth?.nba_games)
  const projections = number(sourceHealth?.projections)
  if (!Number.isFinite(players) || players < thresholds.minPlayers) {
    failures.push(`players ${sourceHealth?.players ?? 'missing'} is below ${thresholds.minPlayers}`)
  }
  if (!Number.isFinite(games) || games < thresholds.minCurrentSeasonGames) {
    failures.push(`current-season games ${sourceHealth?.nba_games ?? 'missing'} is below ${thresholds.minCurrentSeasonGames}`)
  }
  if (!Number.isFinite(projections) || projections < thresholds.minProjections) {
    failures.push(`projections ${sourceHealth?.projections ?? 'missing'} is below ${thresholds.minProjections}`)
  }

  const fetchedAt = new Date(sourceHealth?.latest_projection_fetch ?? '')
  if (!Number.isFinite(fetchedAt.getTime())) {
    failures.push('latest projection fetch is missing or invalid')
  } else {
    const ageDays = (now.getTime() - fetchedAt.getTime()) / 86_400_000
    if (ageDays < -1 || ageDays > thresholds.maxProjectionAgeDays) {
      failures.push(`latest projection fetch is ${Math.round(ageDays * 10) / 10} days old; maximum is ${thresholds.maxProjectionAgeDays}`)
    }
  }

  for (const [field, label] of [
    ['final_games_without_stats', 'final games are missing stats'],
    ['final_missing_stats_rpc', 'final games are missing stats according to RPC'],
    ['games_missing_nba_game_id', 'current-season games are missing nba_game_id'],
    ['open_sync_jobs', 'sync jobs are still open'],
  ]) {
    const count = number(sourceHealth?.[field])
    if (!Number.isFinite(count) || count !== 0) failures.push(`${sourceHealth?.[field] ?? 'missing'} ${label}`)
  }

  return { failures, thresholds }
}

/** @param {boolean} enabled @param {any} result */
export const evaluateCrudReadiness = (enabled, result) => {
  if (!enabled) return { pass: false, evidence: 'Cleanup-backed production CRUD probe was not enabled.' }
  const pass = Number(result?.inserted) === 1 && Number(result?.updated) === 1 &&
    Number(result?.deleted) === 1 && Number(result?.residue) === 0
  return {
    pass,
    evidence: `inserted=${result?.inserted ?? 'missing'}, updated=${result?.updated ?? 'missing'}, deleted=${result?.deleted ?? 'missing'}, residue=${result?.residue ?? 'missing'}`,
  }
}
