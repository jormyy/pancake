import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { advanceCron, cronMatches } from './cron.mjs'
import { cronDispatcher } from './cron-dispatcher.mjs'
import { miniRoot, writeJson } from './common.mjs'
import { setClock } from './clock.mjs'
import { startRuntime } from './runtime.mjs'
import { sql } from './local-stack.mjs'
import { draftSourceUnavailable } from './two-checks.mjs'
import { officialCompression } from './official-compression.mjs'

export async function officialRuntime(at, report, inputPlan, sample = async () => {}, resume = false) {
  process.env.SEASON_SIM_PRODUCTION_ONLY = '1'
  process.env.SEASON_SIM_DISCRETE_CLOCK = '1'
  const catalog = JSON.parse(await readFile(path.join(miniRoot, 'cron-jobs.json'), 'utf8'))
  assert.ok(catalog.length > 0, 'Installed cron catalog cannot be empty')
  assert.equal(new Set(catalog.map(row => row.jobname)).size, catalog.length, 'Installed cron job names must be unique')
  for (const job of catalog) {
    assert.ok(!/ceeytbfmwsnzalxlkalc|https?:\/\/[^']*supabase\.co/i.test(job.command), 'Cron catalog must not reference production')
    cronMatches(job.schedule, Date.parse(at))
  }
  report.triggerFidelity = { verified: false, catalog, counts: {}, unsupportedInputs: [], expectedUnavailable: [] }
  report.compression = {}
  const compression = process.env.SEASON_SIM_STRICT_TICKS === '1' ? null : await officialCompression(inputPlan, report.compression)
  let clock = Date.parse(at)
  const runtime = await startRuntime(at, { resume })
  const dispatcher = cronDispatcher(async outcome => {
    if (outcome.status_code === 200 && outcome.worker_status === 'success') return
    if (['sync-rankings', 'sync-projections', 'sync-sleeper-projections'].includes(outcome.function_name)) {
      report.triggerFidelity.unsupportedInputs.push(outcome)
      return
    }
    if (outcome.function_name === 'sync-players') {
      const body = JSON.parse(outcome.content ?? '{}')
      if (body.failure === 'sync-players had 1 failure(s): Sleeper identities: Sleeper players 503') {
        report.triggerFidelity.unsupportedInputs.push(outcome)
        return
      }
    }
    if (outcome.function_name === 'sync-player-injuries') {
      const body = JSON.parse(outcome.content ?? '{}')
      if (body.failure === 'ESPN injuries has no mapped statuses; injury_status unchanged') {
        report.triggerFidelity.unsupportedInputs.push(outcome)
        return
      }
    }
    const sourceError = outcome.function_name === 'sync-draft-order' ? await sql(`SELECT coalesce(error,'') FROM sync_runs WHERE id=(SELECT sync_run_id FROM edge_invocations WHERE id=${Number(outcome.id)})`) : ''
    if (draftSourceUnavailable(outcome.function_name, clock, inputPlan.draft.availableAt, sourceError)) {
      report.triggerFidelity.expectedUnavailable.push({ function: outcome.function_name, at: clock, sourceError })
      return
    }
    assert.fail(`Official replay dispatch failed: ${JSON.stringify(outcome)}`)
  })
  const move = async value => {
    const target = typeof value === 'number' ? value : Date.parse(value)
    await advanceCron({ from: clock, to: target, catalog, counts: report.triggerFidelity.counts,
      move: async instant => { clock = instant; await setClock({ at: new Date(instant).toISOString(), rate: 0, quiet: true }) },
      invoke: dispatcher.enqueue, settle: dispatcher.settle, sample, compression,
    })
    clock = target
  }
  const close = async () => {
    try { await dispatcher.close() } finally { await runtime.close() }
    await writeJson(path.join(miniRoot, 'evidence/official-dispatch.json'), report.triggerFidelity)
  }
  return { ...runtime, move, now: () => clock, drain: () => dispatcher.drain(clock), close }
}
