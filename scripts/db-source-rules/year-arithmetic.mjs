const converters = new Set([
  'private/draft_year_for_season.sql',
  'private/future_pick_window.sql',
  'private/season_year_after.sql',
  'private/setup_season_year_et.sql',
  'private/trade_deadline_for_season.sql',
  'public/current_season_year_et.sql',
])

const pickScope = /(pick|draft|trade|season)[a-z_]*\.sql$/
const pickTables = /\b(draft_picks|drafts|trade_items)\b/
const offByOne = /\b(?:[a-z_]+\.)?(?![a-z_]*draft_year\b)[a-z_]*year\s*[-+]\s*1(?![0-9.])/gi

const message = 'Convert between league season years and draft years only with private.draft_year_for_season, private.future_pick_window or private.season_year_after; inline year +/- 1 put picks one year off in 57aa5917 and 8a8ed53b.'

export function yearArithmetic(relativePath, source) {
  if (converters.has(relativePath)) return []
  const body = source.replace(/--[^\n]*/g, '')
  if (!pickScope.test(relativePath) && !pickTables.test(body)) return []
  const failures = []
  const lines = body.split('\n')
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(offByOne)) failures.push(`${relativePath}:${index + 1}: ${match[0]}: ${message}`)
  }
  return failures
}
