import { resolvePlayerImports } from '../_shared/playerImports.ts'
import { errorMessage } from '../_shared/responses.ts'
import type { Json } from '../_shared/database.ts'

type SourceRecord = { provider_id: string; first_name: string; last_name: string; metadata: Json }

export async function importPlayerChunk(source: 'espn' | 'sleeper', records: SourceRecord[], offset: number) {
  const totals = { updated: 0, inserted: 0, ambiguousSkipped: 0, failures: [] as string[] }
  const conflictPattern = new RegExp(`^Resolve ${source} players: Conflicting provider identity for player ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$`, 'i')
  const importSlice = async (rows: SourceRecord[], start: number): Promise<void> => {
    try {
      const { results } = await resolvePlayerImports(source, rows)
      for (const row of results) {
        if (row.action === 'updated') totals.updated++
        else if (row.action === 'inserted') totals.inserted++
        else if (row.action === 'ambiguous') {
          totals.ambiguousSkipped++
          totals.failures.push(`import record ${start + row.index} ${source} provider ${rows[row.index].provider_id}: ambiguous identity`)
        }
      }
    } catch (error) {
      const message = errorMessage(error)
      const conflict = message.match(conflictPattern)
      if (!conflict) {
        totals.failures.push(`import chunk ${start}: ${message}`)
      } else if (rows.length === 1) {
        totals.failures.push(`import record ${start} ${source} provider ${rows[0].provider_id}: Conflicting provider identity for player ${conflict[1]}`)
      } else {
        const middle = Math.floor(rows.length / 2)
        await importSlice(rows.slice(0, middle), start)
        await importSlice(rows.slice(middle), start + middle)
      }
    }
  }
  await importSlice(records, offset)
  return totals
}
