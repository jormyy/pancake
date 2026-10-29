import { projectGrowth } from '../db-health/index.mjs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'

export async function clearDatabaseWindowReports(root) {
  for (const name of ['database-growth.json','database-window-result.json']) {
    await unlink(path.join(root,'evidence',name)).catch(error=>{if(error.code!=='ENOENT')throw error})
  }
}

export function projectReplayGrowth(before, after, seasonDays, simulatedDays) {
  try {
    return projectGrowth(before, after, seasonDays, simulatedDays)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'STATEMENT_COUNTER_DECREASED') throw error
    return {
      ...projectGrowth({ ...before, statements: undefined }, { ...after, statements: undefined }, seasonDays, simulatedDays),
      workload: {
        complete: false,
        reason: 'Statement counters decreased; statement totals and throughput are unavailable.',
        beforeDeallocations: before.statementStatsDeallocations ?? null,
        afterDeallocations: after.statementStatsDeallocations ?? null,
      },
    }
  }
}
