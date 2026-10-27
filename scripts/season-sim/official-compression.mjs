import assert from 'node:assert/strict'
import { productionJobs } from './cron.mjs'

export function compressionPolicy(receipt) {
  receipt.mode = 'work-queue-all-ticks'
  receipt.scope = 'The work queue keeps every production minute and worker deadline'
  receipt.inspectedSources = []
  receipt.coalesced = {}
  receipt.queueProofs = 0
  return {
    begin() {},
    async refresh(..._args) {},
    select(jobs, ..._args) { return jobs },
  }
}

export async function officialCompression(_input, receipt) {
  assert.ok(productionJobs.some(job => job.jobname === 'work-dispatcher'), 'The replay requires the work dispatcher')
  return compressionPolicy(receipt)
}
