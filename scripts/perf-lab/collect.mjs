import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { command } from './process.mjs'
import { shellQuote } from './detached.mjs'
import { archiveEvidence } from './evidence.mjs'
import { verifyArchivePaths } from './transfer.mjs'
import { renderReport } from './report.mjs'
import { json } from './common.mjs'

export function requireCompletedReplay(runId, result) {
  assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.equal(result.running, false, 'The detached replay is still running')
  assert.ok(Number.isInteger(result.exitCode), 'The detached replay has no terminal exit code')
  assert.equal(result.receipt?.runId, runId, 'Collect the finished replay before starting another workload')
  assert.equal(result.receipt?.cleanup, true, 'The detached replay has not completed stack cleanup')
  return result.receipt
}

export async function collectDetached(runId, remotePrefix) {
  assert.match(runId, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
  assert.ok(remotePrefix, 'The mini environment is required')
  const remote = '$HOME/pancake-t_4ba51e0d/lanes/fable-timeline/perf-lab'
  const ssh = script => command('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'mini', remotePrefix + script], { timeout: 300000 })
  const probe = `const fs=require('fs'),path=require('path');const root=path.join(process.env.HOME,'pancake-t_4ba51e0d/lanes/fable-timeline/perf-lab');const run=path.join(root,'runs','${runId}');const pid=Number(fs.readFileSync(path.join(run,'pid'),'utf8'));if(!Number.isSafeInteger(pid)||pid<=1)throw Error('Invalid detached PID');const raw=fs.existsSync(path.join(run,'exit-code'))?fs.readFileSync(path.join(run,'exit-code'),'utf8').trim():null;const exit=raw!==null&&/^[0-9]+$/.test(raw)?Number(raw):null;let running=false;if(exit===null)try{process.kill(pid,0);running=true}catch{}const receipt=JSON.parse(fs.readFileSync(path.join(root,'evidence/database-run.json'),'utf8'));console.log(JSON.stringify({pid,running,exitCode:exit,receipt}));`
  const status = JSON.parse((await ssh(`node -e ${shellQuote(probe)}`)).stdout)
  requireCompletedReplay(runId, status)
  const evidence = path.join(homedir(), 'Documents/pancake-season-mission/fable/program3/evidence/lab')
  await mkdir(evidence, { recursive: true })
  await archiveEvidence(evidence)
  const known = (await readdir(path.join(evidence, 'history')).catch(() => [])).filter(id => /^[a-f0-9-]{36}$/.test(id))
  await ssh(`cd "${remote}/repo" && node scripts/perf-lab/transfer.mjs ${shellQuote(known.join(','))}`)
  const temporary = await mkdtemp(path.join(tmpdir(), 'pancake-detached-evidence-'))
  try {
    const file = path.join(temporary, 'evidence.tar.gz')
    await command('scp', ['mini:pancake-t_4ba51e0d/lanes/fable-timeline/perf-lab/evidence-transfer.tar.gz', file], { timeout: 300000 })
    const listing = await command('tar', ['-tzf', file])
    const details = await command('tar', ['-tvzf', file])
    verifyArchivePaths(listing.stdout, details.stdout)
    await command('tar', ['-xzf', file, '-C', evidence])
  } finally { await rm(temporary, { recursive: true, force: true }) }
  const receipt = JSON.parse(await readFile(path.join(evidence, 'database-run.json'), 'utf8'))
  requireCompletedReplay(runId, { ...status, receipt })
  const simulation = JSON.parse(await readFile(path.join(evidence, 'two-day.json'), 'utf8'))
  const { report } = await renderReport({ evidenceRoot: evidence, receipts: [], simulation })
  await json(path.join(evidence, 'detached-collection.json'), { runId, pid: status.pid, exitCode: status.exitCode, source: receipt.source, gatesPassed: simulation.passed, collectedAt: new Date().toISOString() })
  console.log(JSON.stringify({ runId, exitCode: status.exitCode, gates: simulation.gates, simulationPassed: report.simulationPassed, matrixComplete: report.done }))
  return status.exitCode
}
