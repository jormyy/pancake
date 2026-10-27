import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { productionJobs } from './cron.mjs'

const replacements = {
  './provider-evidence.mjs': 'export const providerEvidence = () => async () => []',
  './clock.mjs': 'export const setClock = async () => {}',
  './runtime.mjs': 'export const startRuntime = async () => ({ close: async () => {} })',
  './official-compression.mjs': 'export const officialCompression = async () => null',
  './cron-dispatcher.mjs': `export const cronDispatcher = classify => ({
    drain: async () => { for (const row of globalThis.nativeState.pending.splice(0)) await classify(row) },
    close: async () => {}
  })`,
  './local-stack.mjs': String.raw`
    const selected = statement => {
      const after = Number(statement.match(/id>(\d+)/)?.[1] ?? 0)
      return globalThis.nativeState.rows.filter(row => row.id > after)
    }
    export const sql = async statement => statement.includes('max(id)')
      ? String(Math.max(0, ...globalThis.nativeState.rows.map(row => row.id)))
      : String(selected(statement).length)
    export const sqlJson = async statement => selected(statement)
  `,
}

for (const scenario of ['retained-receipts', 'missing-new-row', 'corrupt-prior-receipt']) {
  test(`native reconciliation after log retention: ${scenario}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pancake-retention-'))
    try {
      await writeFile(path.join(root, 'cron-jobs.json'), JSON.stringify(productionJobs))
      const runtimeUrl = new URL('./official-runtime.mjs', import.meta.url).href
      const program = `
        import assert from 'node:assert/strict'
        import { registerHooks } from 'node:module'
        const replacements = ${JSON.stringify(replacements)}
        registerHooks({ resolve(specifier, context, next) {
          return context.parentURL === ${JSON.stringify(runtimeUrl)} && replacements[specifier]
            ? { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true }
            : next(specifier, context)
        } })
        const state = globalThis.nativeState = { rows: [], pending: [] }
        const { officialRuntime } = await import(${JSON.stringify(runtimeUrl)})
        const report = {}
        const runtime = await officialRuntime('2024-11-04T10:00:00Z', report, { draft: { availableAt: '2025-06-27T00:00:00Z' } })
        const add = id => {
          const row = { id, invocation_key: 'worker-' + id, function_name: 'sync-schedule', worker_status: 'success', sync_status: 'success', status_code: 200, content: '{}' }
          state.rows.push(row)
          state.pending.push(row)
          report.triggerFidelity.counts['work-dispatcher'] = (report.triggerFidelity.counts['work-dispatcher'] ?? 0) + 1
        }
        add(10)
        await runtime.verifyFidelity()
        const phase = report.triggerFidelity.phases[0]
        assert.equal(phase.nativeCount, 1)
        add(20)
        if (${JSON.stringify(scenario)} === 'missing-new-row') {
          state.rows.pop()
          await assert.rejects(runtime.verifyFidelity, /Every invocation must have one outcome/)
        } else {
          state.rows.shift()
          if (${JSON.stringify(scenario)} === 'corrupt-prior-receipt') {
            phase.invocations[0].invocation_key = 'wrong'
            await assert.rejects(runtime.verifyFidelity, /Reconciled worker fidelity must pass/)
          } else {
            await runtime.verifyFidelity()
            assert.equal(state.rows.length, 1)
            assert.equal(phase.nativeCount, 2)
            assert.deepEqual(phase.invocations.map(row => row.id), [10, 20])
            assert.equal(report.triggerFidelity.outcomes.length, 2)
            const verified = JSON.stringify(report.triggerFidelity)
            await runtime.verifyFidelity()
            assert.equal(JSON.stringify(report.triggerFidelity), verified)
          }
        }
      `
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
        encoding: 'utf8',
        env: { ...process.env, SEASON_SIM_ROOT: root, SEASON_SIM_STRICT_TICKS: '1' },
      })
      assert.equal(child.status, 0, child.stderr)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
