import assert from 'node:assert/strict'
import { copyFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cellKey } from './layout-stability-analysis.mjs'
import { saveSweepReport } from './layout-stability-report.mjs'

export function mergeRerun(report, rerun, prefix) {
  assert.equal(report.release.commitSha, rerun.release.commitSha, 'Rerun must use the same release')
  assert.equal(report.release.bundleDigest, rerun.release.bundleDigest, 'Rerun must use the same built bundle')
  assert.ok(!rerun.error && rerun.cells.every((row) => row.reason !== 'Run has not reached this cell'), 'Rerun must be complete')
  const keys = new Set(report.cells.map(cellKey))
  const replacements = new Map()
  for (const row of rerun.cells) {
    const key = cellKey(row)
    assert.ok(keys.has(key) && !replacements.has(key), `Unknown or duplicate rerun cell: ${key}`)
    const replacement = { ...row, harnessDigest: rerun.harness.digest }
    for (const name of ['evidence', 'video', 'screenshot']) if (replacement[name]) replacement[name] = path.join(prefix, replacement[name])
    replacements.set(key, replacement)
  }
  return { ...report,
    cells: report.cells.map((row) => replacements.get(cellKey(row)) ?? row),
    reruns: [...report.reruns ?? [], { command: rerun.command, harness: rerun.harness,
      generatedAt: rerun.generatedAt, fixture: rerun.fixture, options: rerun.options,
      prefix, cells: [...replacements.keys()] }],
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const index = arg.indexOf('=')
    return [arg.slice(2, index < 0 ? undefined : index), index < 0 ? true : arg.slice(index + 1)]
  }))
  if (args.help) {
    process.stdout.write('Usage: node tests/e2e/layout-stability-merge.mjs --output-dir=PATH --rerun-dir=PATH\nRerun directory must be inside the report directory. Original reports are retained.\n')
    return
  }
  assert.equal(typeof args['output-dir'], 'string')
  assert.equal(typeof args['rerun-dir'], 'string')
  const output = path.resolve(/** @type {string} */ (args['output-dir']))
  const rerunDir = path.resolve(/** @type {string} */ (args['rerun-dir']))
  assert.ok(output !== process.cwd() && !output.startsWith(`${process.cwd()}/`), 'Evidence must stay outside the checkout')
  assert.ok(rerunDir.startsWith(`${output}/`), 'Keep rerun evidence inside the report directory')
  const report = JSON.parse(await readFile(path.join(output, 'sweep.json'), 'utf8'))
  const rerun = JSON.parse(await readFile(path.join(rerunDir, 'sweep.json'), 'utf8'))
  const merged = mergeRerun(report, rerun, path.relative(output, rerunDir))
  const backup = `sweep-before-rerun-${report.reruns?.length ?? 0}`
  await copyFile(path.join(output, 'sweep.json'), path.join(output, `${backup}.json`))
  await copyFile(path.join(output, 'sweep.md'), path.join(output, `${backup}.md`))
  await saveSweepReport(merged, output)
  process.stdout.write(`Replaced ${rerun.cells.length} cells; retained ${backup}.json and every raw capture\n`)
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
