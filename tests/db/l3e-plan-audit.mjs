import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

export const scanTargets = new Set(['player_game_stats', 'players', 'player_season_totals', 'job_run_details', 'work_items', 'forecast_player_history', 'roster_players'])

export function scanPlans(source) {
  const rows = []
  const pattern = /duration: ([\d.]+) ms\s+plan:\s*/g
  for (let match; (match = pattern.exec(source));) {
    const start = pattern.lastIndex
    if (source[start] !== '{') continue
    let depth = 0, quoted = false, escaped = false, end = start
    for (; end < source.length; end++) {
      const char = source[end]
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{') depth++
      else if (char === '}' && --depth === 0) { end++; break }
    }
    const document = JSON.parse(source.slice(start, end))
    const scans = []
    const visit = node => {
      if (node['Node Type'] === 'Seq Scan' && scanTargets.has(node['Relation Name']) && node['Actual Loops'] > 0) {
        scans.push({ table: node['Relation Name'], loops: node['Actual Loops'], rowsRead: (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'], filter: node.Filter ?? null, buffers: (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0) })
      }
      for (const child of node.Plans ?? []) visit(child)
    }
    visit(document.Plan)
    if (scans.length) rows.push({ query: document['Query Text'], milliseconds: Number(match[1]), scans })
    pattern.lastIndex = end
  }
  return rows
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2]
  const bytes = await readFile(file)
  const rows = scanPlans((file.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString())
  const groups = new Map()
  for (const row of rows) for (const scan of row.scans) {
    const key = `${scan.table}/${row.query}`
    const group = groups.get(key) ?? { table: scan.table, query: row.query, capturedCalls: 0, scans: 0, rowsRead: 0, buffers: 0, milliseconds: 0 }
    group.capturedCalls++
    group.scans += scan.loops
    group.rowsRead += scan.rowsRead
    group.buffers += scan.buffers
    group.milliseconds += row.milliseconds
    groups.set(key, group)
  }
  const result = [...groups.values()].sort((a, b) => b.rowsRead - a.rowsRead)
  if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result.map(row => ({ ...row, query: row.query.slice(0, 350) })), null, 2))
}
