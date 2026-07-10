import path from 'node:path'
import process from 'node:process'
import { envValue, writeMarkdownReport } from './env.mjs'
import { validateHostedReleaseProvenance, validateHostedTargetIdentity } from './production-readiness-contract.mjs'

const REPORT_PATH = path.join(process.cwd(), 'tests/hosted-release-provenance-report.md')

const fetchJson = async (fetchImpl, url, label) => {
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  const text = await response.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`)
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return body
}

/**
 * @param {{ expected: { commitSha: string, frontendBundleDigest: string, edgeArtifactDigest: string }, edgeApiUrl: string, frontendUrl: string, fetchImpl?: typeof fetch }} input
 */
export const probeHostedReleaseProvenance = async ({ expected, edgeApiUrl, frontendUrl, fetchImpl = fetch }) => {
  const edgeHealthUrl = `${edgeApiUrl.replace(/\/$/, '')}/health`
  let frontendMarkerUrl
  try {
    frontendMarkerUrl = new URL('release-provenance.json', `${frontendUrl.replace(/\/$/, '')}/`).toString()
  } catch {
    return {
      edgeHealthUrl,
      frontendMarkerUrl: 'unavailable',
      edge: null,
      frontend: null,
      failures: ['frontend probe failed: frontend URL is invalid'],
    }
  }
  const [edgeResult, frontendResult] = await Promise.allSettled([
    fetchJson(fetchImpl, edgeHealthUrl, 'Edge health'),
    fetchJson(fetchImpl, frontendMarkerUrl, 'frontend provenance'),
  ])
  const edge = edgeResult.status === 'fulfilled' ? edgeResult.value : null
  const frontend = frontendResult.status === 'fulfilled' ? frontendResult.value : null
  const failures = []
  if (edgeResult.status === 'rejected') failures.push(`Edge probe failed: ${edgeResult.reason instanceof Error ? edgeResult.reason.message : String(edgeResult.reason)}`)
  if (frontendResult.status === 'rejected') failures.push(`frontend probe failed: ${frontendResult.reason instanceof Error ? frontendResult.reason.message : String(frontendResult.reason)}`)
  failures.push(...validateHostedReleaseProvenance(expected, edge, frontend))
  if (edge?.ok !== true || edge?.service !== 'pancake-supabase-api' || edge?.runtime !== 'supabase-edge') {
    failures.push('Edge health response does not identify the Pancake Supabase Edge runtime')
  }
  return { edgeHealthUrl, frontendMarkerUrl, edge, frontend, failures }
}

export const runHostedReleaseProvenance = async ({
  expected,
  edgeApiUrl,
  frontendUrl,
  target,
  fetchImpl = fetch,
  reportPath = REPORT_PATH,
}) => {
  const targetFailures = validateHostedTargetIdentity(target)
  const result = edgeApiUrl && frontendUrl
    ? await probeHostedReleaseProvenance({ expected, edgeApiUrl, frontendUrl, fetchImpl })
    : {
        edgeHealthUrl: edgeApiUrl ? `${edgeApiUrl.replace(/\/$/, '')}/health` : 'unavailable',
        frontendMarkerUrl: frontendUrl ? new URL('release-provenance.json', `${frontendUrl.replace(/\/$/, '')}/`).toString() : 'unavailable',
        edge: null,
        frontend: null,
        failures: ['Hosted provenance requires E2E_REMOTE_API_URL and E2E_FRONTEND_URL'],
      }
  result.failures.push(...targetFailures.map((failure) => `Target identity: ${failure}`))
  const rows = [
    {
      surface: 'Edge',
      status: result.failures.some((failure) => failure.startsWith('Edge ')) ? 'BLOCKED' : 'PASS',
      evidence: `${result.edgeHealthUrl}; commit=${result.edge?.commitSha ?? 'missing'}; edge_artifact=${result.edge?.edgeArtifactDigest ?? 'missing'}`,
    },
    {
      surface: 'Frontend',
      status: result.failures.some((failure) => failure.startsWith('frontend ')) ? 'BLOCKED' : 'PASS',
      evidence: `${result.frontendMarkerUrl}; commit=${result.frontend?.commitSha ?? 'missing'}; bundle=${result.frontend?.bundleDigest ?? 'missing'}`,
    },
    {
      surface: 'Target identity',
      status: targetFailures.length === 0 ? 'PASS' : 'BLOCKED',
      evidence: targetFailures.join('; ') || 'Supabase, Edge, and frontend targets match protected production identity.',
    },
  ]
  if (result.failures.length > 0 && rows.every((row) => row.status === 'PASS')) {
    rows.push({ surface: 'Contract', status: 'BLOCKED', evidence: result.failures.join('; ') })
  }
  await writeMarkdownReport({
    reportPath,
    title: 'Hosted Release Provenance',
    rows,
    columns: [
      { header: 'Surface', value: (row) => row.surface },
      { header: 'Status', value: (row) => row.status },
      { header: 'Evidence', value: (row) => row.evidence },
    ],
  })
  return { ...result, rows }
}

const main = async () => {
  const expected = {
    commitSha: envValue('E2E_EXPECTED_RELEASE_SHA') ?? '',
    frontendBundleDigest: envValue('E2E_EXPECTED_FRONTEND_BUNDLE_DIGEST') ?? '',
    edgeArtifactDigest: envValue('E2E_EXPECTED_EDGE_ARTIFACT_DIGEST') ?? '',
  }
  const edgeApiUrl = envValue('E2E_REMOTE_API_URL', 'EXPO_PUBLIC_API_URL')
  const frontendUrl = envValue('E2E_FRONTEND_URL')
  const result = await runHostedReleaseProvenance({
    expected,
    edgeApiUrl,
    frontendUrl,
    target: {
      expectedProjectRef: envValue('E2E_PRODUCTION_SUPABASE_REF') ?? '',
      linkedProjectRef: envValue('SUPABASE_PROJECT_REF') ?? '',
      supabaseUrl: envValue('E2E_SUPABASE_URL', 'SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_URL') ?? '',
      edgeApiUrl: edgeApiUrl ?? '',
      frontendUrl: frontendUrl ?? '',
      expectedFrontendHost: envValue('E2E_EXPECTED_FRONTEND_HOST'),
      allowCandidateFrontend: envValue('E2E_ALLOW_CANDIDATE_FRONTEND') === '1',
    },
  })
  if (result.failures.length > 0) {
    console.error(result.failures.join('\n'))
    process.exitCode = 1
  } else {
    console.log(`PASS ${REPORT_PATH}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
