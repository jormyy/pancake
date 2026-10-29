import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { digest, sourceRoot } from './common.mjs'

const backend = ['core', 'supabase/functions', 'supabase/migrations', 'supabase/sql']
const artifacts = ['two-day.json', 'database-run.json', 'replay-checkpoint.json', 'edge-invocations.jsonl', 'job-load-replay.json', 'replay-client-access.jsonl']
const gates = ['liveTicks', 'overnightFinalization', 'preTipoff', 'waivers', 'tradeProposed', 'tradeCountered', 'tradeAccepted', 'forecasts', 'realtime']

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function sameReplayBackend(source, root = sourceRoot) {
  if (!/^[a-f0-9]{40}$/.test(source ?? '')) return false
  try {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (git(['status', '--porcelain', '--', ...backend])) return false
    return backend.every(directory => git(['rev-parse', `${source}:${directory}`]) === git(['rev-parse', `HEAD:${directory}`]))
  } catch { return false }
}

export async function retainedReplay(evidenceRoot, compatible = sameReplayBackend) {
  if (!evidenceRoot) return null
  const history = path.join(evidenceRoot, 'history')
  const directories = (await readdir(history).catch(() => [])).filter(id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
  const candidates = []
  for (const id of directories) {
    const root = path.join(history, id)
    try {
      const bytes = await Promise.all(artifacts.slice(0, 3).map(file => readFile(path.join(root, file))))
      const [simulation, receipt, checkpoint] = bytes.map(value => JSON.parse(value.toString('utf8')))
      if (!simulation.passed || simulation.days !== 2 || simulation.fidelity !== 'production-cadence' || !gates.every(gate => simulation.gates?.[gate] === true)) continue
      if (!['full', 'control'].includes(simulation.captureProfile) || receipt.runId !== id || receipt.cleanup !== true || receipt.failure) continue
      if (simulation.source?.application?.commit !== receipt.source || simulation.source?.committedHarness !== true || checkpoint.complete !== true) continue
      if (!await compatible(receipt.source)) continue
      const hashes = Object.fromEntries(artifacts.slice(0, 3).map((file, index) => [file, digest(bytes[index])]))
      for (const file of artifacts.slice(3)) hashes[file] = await fileHash(path.join(root, file))
      candidates.push({ root, simulation, receipt, artifacts: hashes })
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error }
  }
  return candidates.sort((a, b) => String(b.receipt.finishedAt ?? b.receipt.startedAt).localeCompare(String(a.receipt.finishedAt ?? a.receipt.startedAt)))[0] ?? null
}
