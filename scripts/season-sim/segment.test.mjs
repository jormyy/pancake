import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('official continuation records the verified restored snapshot and rejects a failed replay result', () => {
  for (const failed of [false, true]) {
    const stack = `export const restoreSnapshot = async () => ({ name: 'pre-playoffs', createdAt: 'frozen', dumpSha256: 'pinned', quiescence: { polls: 1 }, cursor: { evidence: { kind: 'official', snapshots: [] } }, fixtures: { manifestSha256: 'fixtures' }, restore: { definitionsAfter: 'definitions' } }); export const segmentNames = ['pre-playoffs']; export const snapshotRoot = () => '/scratch'`
    const replay = `export const replay = async options => { const rows = options.resume.evidence.snapshots; if (rows.length !== 1 || rows[0].dumpSha256 !== 'pinned') throw new Error('Restored checkpoint proof missing'); return { complete: true, error: ${failed ? "'injected failed continuation'" : 'null'}, days: ['returned report'], source: { committed: true } } }`
    const common = `export const miniRoot = '/scratch'; export const writeJson = async (_, value) => console.log(JSON.stringify(value))`
    const replacements = { './checkpoints.mjs': stack, './replay.mjs': replay, './common.mjs': common }
    const program = `import { registerHooks } from 'node:module'; const replacements = ${JSON.stringify(replacements)}; registerHooks({ resolve(specifier, context, next) { return replacements[specifier] ? { url: 'data:text/javascript,' + encodeURIComponent(replacements[specifier]), shortCircuit: true } : next(specifier, context) } }); const { runSegment } = await import(${JSON.stringify(new URL('./segment.mjs', import.meta.url).href)}); await runSegment('pre-playoffs')`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    const proof = JSON.parse(child.stdout)
    assert.equal(proof.passed, !failed)
    assert.deepEqual(proof.assertions, ['returned report'])
    assert.equal(proof.snapshotDumpSha256, 'pinned')
  }
})

test('official continuation refuses an SQL overlay before reading scenario or database state', async () => {
  const { officialReplay } = await import('./official-replay.mjs')
  await assert.rejects(() => officialReplay({ afterRestoreSql: '/scratch/injected.sql' }, undefined), /unchanged application SQL/)
})
