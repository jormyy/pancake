import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

export const REQUIRED_MUTATION_SCENARIOS = Object.freeze([
  'league-lifecycle',
  'auction',
  'lineup',
  'waiver',
  'trade-proposal',
  'trade-accept',
])

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)
const errorText = (error) => error instanceof Error ? error.message : String(error)

const fetchJson = async (url, label, fetchImpl = fetch) => {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return response.json()
}

export const validateMutationCompatibilityReport = (report) => {
  const failures = []
  if (!fullSha(report?.expected?.frontendSha)) failures.push('expected frontend SHA is invalid')
  if (!digest(report?.expected?.frontendDigest)) failures.push('expected frontend digest is invalid')
  if (!fullSha(report?.expected?.edgeSha)) failures.push('expected Edge SHA is invalid')
  if (!digest(report?.expected?.edgeDigest)) failures.push('expected Edge digest is invalid')
  if (report?.observed?.frontend?.commitSha !== report?.expected?.frontendSha) failures.push('observed frontend SHA does not match')
  if (report?.observed?.frontend?.bundleDigest !== report?.expected?.frontendDigest) failures.push('observed frontend digest does not match')
  if (report?.observed?.edge?.commitSha !== report?.expected?.edgeSha) failures.push('observed Edge SHA does not match')
  if (report?.observed?.edge?.edgeArtifactDigest !== report?.expected?.edgeDigest) failures.push('observed Edge digest does not match')
  if (report?.observed?.edge?.ok !== true || report?.observed?.edge?.service !== 'pancake-supabase-api') {
    failures.push('observed Edge identity is invalid')
  }
  const results = new Map((report?.scenarios ?? []).map((scenario) => [scenario.id, scenario]))
  for (const id of REQUIRED_MUTATION_SCENARIOS) {
    const result = results.get(id)
    if (!result) failures.push(`${id} mutation evidence is missing`)
    else if (result.status !== 'PASS') failures.push(`${id} mutation failed: ${result.error ?? 'unknown error'}`)
  }
  return failures
}

export const runMutationScenarios = async ({ runScenario }) => {
  const scenarios = []
  for (const id of REQUIRED_MUTATION_SCENARIOS) {
    try {
      const result = await runScenario(id)
      scenarios.push({ id, status: result?.status === 'PASS' ? 'PASS' : 'FAIL', error: result?.error ?? null })
    } catch (error) {
      scenarios.push({ id, status: 'FAIL', error: errorText(error) })
    }
  }
  return scenarios
}

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const main = async () => {
  const pairId = process.argv.find((arg) => arg.startsWith('--pair='))?.split('=')[1]
  if (!pairId || !/^[a-z0-9-]+$/.test(pairId)) throw new Error('--pair requires a filesystem-safe identifier')
  const frontendUrl = required('E2E_FRONTEND_URL').replace(/\/$/, '')
  const edgeUrl = required('E2E_API_BASE_URL').replace(/\/$/, '')
  const expected = {
    frontendSha: required('E2E_COMPAT_FRONTEND_SHA'),
    frontendDigest: required('E2E_COMPAT_FRONTEND_DIGEST'),
    edgeSha: required('E2E_COMPAT_EDGE_SHA'),
    edgeDigest: required('E2E_COMPAT_EDGE_DIGEST'),
  }
  const nonce = `${process.env.GITHUB_RUN_ID ?? 'local'}-${Date.now()}`
  const [frontend, edge] = await Promise.all([
    fetchJson(`${frontendUrl}/release-provenance.json?compatibility=${nonce}`, 'frontend provenance'),
    fetchJson(`${edgeUrl}/health?compatibility=${nonce}`, 'Edge health'),
  ])
  const artifactRoot = path.join(process.cwd(), 'tests/artifacts/compatibility', pairId)
  const registryArtifactRoot = path.join(artifactRoot, 'registry')
  await mkdir(registryArtifactRoot, { recursive: true })
  const { browserScenarioById } = await import('./browser-scenario-registry.mjs')
  const scenarios = await runMutationScenarios({
    runScenario: (id) => browserScenarioById(id).run({
      args: { browserFullSweep: false },
      season: 0,
      registryArtifactRoot,
    }),
  })
  const report = { pairId, expected, observed: { frontend, edge }, scenarios }
  const failures = validateMutationCompatibilityReport(report)
  report.status = failures.length === 0 ? 'PASS' : 'FAIL'
  report.failures = failures
  await writeFile(path.join(artifactRoot, 'mutation-compatibility.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (failures.length > 0) throw new Error(failures.join('; '))
  process.stdout.write(`${JSON.stringify(report)}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(errorText(error))
    process.exit(1)
  })
}
