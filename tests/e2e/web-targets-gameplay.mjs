import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { WEB_TARGETS } from './web-targets-browser.mjs'

const scenarios = [
  'league-lifecycle', 'auction', 'lineup', 'lineup-auto-set', 'lineup-locked', 'rookie-draft',
  'waiver', 'waiver-drop', 'waiver-ir-block', 'playoffs',
  'trade-proposal', 'trade-accept', 'trade-terminal',
  'trade-future-pick', 'trade-future-pick-accept', 'trade-overflow-accept', 'trade-post-deadline', 'trade-veto', 'trade-multi-team',
]

export async function runWebGameplayTargets({ artifactDir, season }) {
  const report = { status: 'FAIL', targets: [], generatedAt: new Date().toISOString() }
  const selected = WEB_TARGETS.filter((target) => !process.env.E2E_WEB_TARGET_FILTER || target.id.includes(process.env.E2E_WEB_TARGET_FILTER))
  const selectedScenarios = scenarios.filter((id) => !process.env.E2E_WEB_ACTION_SCENARIO || process.env.E2E_WEB_ACTION_SCENARIO.split(',').includes(id))
  assert.ok(selected.length && selectedScenarios.length)
  for (const target of selected) {
    for (const id of selectedScenarios) {
      const dir = path.join(artifactDir, target.id, id)
      await mkdir(dir, { recursive: true })
      const child = spawn(process.execPath, ['tests/e2e/browser-ci-scenario.mjs', `--scenario=${id}`], {
        cwd: process.cwd(),
        env: { ...process.env, E2E_WEB_TARGET_ID: target.id, E2E_BROWSER_ARTIFACT_DIR: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += chunk })
      child.stderr.on('data', (chunk) => { output += chunk })
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
      await writeFile(path.join(dir, 'command.log'), output)
      const registry = await readFile(path.join(dir, 'artifacts/registry', `${id}-season-0.json`), 'utf8').then(JSON.parse).catch(() => null)
      const result = { id: target.id, scenario: id, status: exit === 0 && registry?.status === 'PASS' ? 'PASS' : 'FAIL', exit,
        provenance: registry?.provenance, error: registry?.error ?? (exit ? output.slice(-2000) : null), artifactDir: dir }
      report.targets.push(result)
      await writeFile(path.join(artifactDir, 'gameplay.json'), `${JSON.stringify(report, null, 2)}\n`)
      process.stdout.write(`${target.id} ${id}: ${result.status}\n`)
    }
  }
  report.status = report.targets.every((target) => target.status === 'PASS') ? 'PASS' : 'FAIL'
  await writeFile(path.join(artifactDir, 'gameplay.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(artifactDir, 'gameplay.md'), ['# Web gameplay matrix', '', 'Playwright emulation. No physical iPhone or installed Home Screen app is used.', '', '| Target | Scenario | Result |', '| --- | --- | --- |', ...report.targets.map((row) => `| ${row.id} | ${row.scenario} | ${row.status} |`), ''].join('\n'))
  return { ...report, season, artifactDir }
}
