import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { providerEvidence } from './provider-evidence.mjs'
import { randomUUID } from 'node:crypto'
import { catalogIdentity, classifyOutcome, fidelityPass, sourceGapReference } from './official-outcomes.mjs'
import { advanceCron, cronMatches, verifyCronCatalog } from './cron.mjs'
import { cronDispatcher } from './cron-dispatcher.mjs'
import { miniRoot, writeJson, originUrl } from './common.mjs'
import { setClock } from './clock.mjs'
import { startRuntime } from './runtime.mjs'
import { sql, sqlJson } from './local-stack.mjs'
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
  verifyCronCatalog(catalog)
  const prior = resume ? report.triggerFidelity : null
  if (resume) assert.ok(fidelityPass(prior), 'Continuation requires repaired outcome history')
  report.triggerFidelity = prior ?? { version: 2, catalog, counts: {}, phases: [], outcomes: [], unsupportedInputs: [], expectedUnavailable: [], unexpected: [] }
  const fidelity = report.triggerFidelity
  fidelity.verified = false
  fidelity.reconciled = false
  const phase = randomUUID()
  const before = Number(await sql('SELECT coalesce(max(id),0) FROM edge_invocations'))
  const initialCounts = { ...fidelity.counts }
  const inventory = { phase, catalogHash: catalogIdentity(catalog), before, through: before, nativeCount: 0, invocations: [], counts: {} }
  fidelity.phases.push(inventory)
  let reconciledThrough = before
  const seen = new Set()
  const readProviders = providerEvidence()
  report.compression = {}
  const compression = process.env.SEASON_SIM_STRICT_TICKS === '1' ? null : await officialCompression(inputPlan, report.compression)
  let clock = Date.parse(at)
  const runtime = await startRuntime(at, { resume })
  const classify = async outcome => {
    if (seen.has(outcome.invocation_key)) return
    const evidence = await readProviders(outcome.invocation_key)
    const classification = classifyOutcome({ ...outcome, providerOrigin: originUrl('replay') }, { providers: evidence, at: clock, draftAvailableAt: inputPlan.draft.availableAt })
    const receipt = { phase, draftAvailableAt: inputPlan.draft.availableAt, at: new Date(clock).toISOString(), outcome: { ...outcome, providerOrigin: originUrl('replay') }, providers: evidence, classification }
    fidelity.outcomes.push(receipt)
    seen.add(outcome.invocation_key)
    if (classification.kind === 'known-source-gap') fidelity.unsupportedInputs.push(sourceGapReference(receipt))
    if (classification.kind === 'unexpected') {
      fidelity.unexpected.push(receipt)
      assert.fail(`Official replay dispatch failed: ${JSON.stringify(receipt)}`)
    }
  }
  const dispatcher = cronDispatcher(classify)
  const verifyFidelity = async () => {
    await dispatcher.drain(clock)
    const rows = await sqlJson(`SELECT coalesce(json_agg(r),'[]') FROM (SELECT i.id,i.invocation_key,i.function_name,i.worker_status,i.error_message,s.status AS sync_status,s.error AS sync_error,s.rows_affected,n.status_code,n.timed_out,n.error_msg,n.content FROM edge_invocations i LEFT JOIN sync_runs s ON s.id=i.sync_run_id LEFT JOIN net._http_response n ON n.id=i.request_id WHERE i.id>${reconciledThrough} ORDER BY i.id) r`, 'Reconcile every native invocation')
    for (const row of rows) {
      inventory.invocations.push({ id: Number(row.id), invocation_key: row.invocation_key, function_name: row.function_name })
      await classify(row)
    }
    const count = inventory.nativeCount + Number(await sql(`SELECT count(*) FROM edge_invocations WHERE id>${reconciledThrough}`))
    assert.equal(count, seen.size, 'Every invocation must have one outcome')
    assert.equal(count, inventory.invocations.length, 'Native inventory must include every invocation')
    reconciledThrough = Math.max(reconciledThrough, ...rows.map(row => Number(row.id)))
    inventory.through = reconciledThrough
    inventory.nativeCount = count
    inventory.counts = Object.fromEntries(Object.entries(fidelity.counts).map(([name, total]) => [name, total - (initialCounts[name] ?? 0)]).filter(([, total]) => total > 0))
    fidelity.catalogVerified = true
    fidelity.coverage = { invoked: { ...fidelity.counts }, coalesced: { ...report.compression.coalesced } }
    fidelity.reconciled = true
    fidelity.verified = true
    assert.ok(fidelityPass(fidelity), 'Reconciled worker fidelity must pass')
    return fidelity
  }
  const move = async value => {
    fidelity.verified = false
    fidelity.reconciled = false
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
  return { ...runtime, move, verifyFidelity, now: () => clock, drain: () => dispatcher.drain(clock), close }
}
