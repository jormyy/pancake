const allocator = 'private/reconcile_future_picks.sql'
const insertPicks = /\bINSERT\s+INTO\s+(?:public\.)?draft_picks\b/i

const message = 'Create draft picks only by calling private.reconcile_future_picks(league_id); separate pick writers missed members in cb476d00 and drifted their year window in acb61d41, 57aa5917 and 8a8ed53b.'

function pickAllocator(relativePath, source) {
  if (relativePath === allocator) return []
  const body = source.replace(/--[^\n]*/g, '')
  return body.split('\n').flatMap((line, index) =>
    insertPicks.test(line) ? [`${relativePath}:${index + 1}: ${message}`] : [])
}

const sourceName = (key) => `${key.replace(/\(.*$/, '').replace('.', '/')}.sql`

/** @param {{ definitions: Map<string, string> }} input */
export default function ({ definitions }) {
  return [...definitions].flatMap(([key, definition]) => pickAllocator(sourceName(key), definition))
}
