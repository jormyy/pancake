import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { labRoot } from './common.mjs'

export function isKnownProjectionGap(outcome, requests) {
  const source = { 'sync-sleeper-projections': 'sleeper-projections', 'sync-fantasy-projections': 'fantasypros-projections', 'sync-rankings': 'hashtag-rankings' }[outcome.function_name]
  if (!source) return false
  if (outcome.status_code !== 500 || outcome.worker_status !== 'failed') return false
  return requests.some(row => row.invocation === outcome.invocation_key && row.function === outcome.function_name
    && row.status === 503 && row.unavailable?.code === 'HISTORICAL_UNAVAILABLE'
    && row.unavailable.source === source)
}

export async function historicalProjectionGap(outcome) {
  const lines = await readFile(path.join(labRoot, 'state/provider-requests.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  return isKnownProjectionGap(outcome, lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
}
