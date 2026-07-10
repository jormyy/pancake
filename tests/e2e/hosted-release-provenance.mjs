import path from 'node:path'
import process from 'node:process'
import { envValue, writeMarkdownReport } from './env.mjs'
import { validateHostedReleaseProvenance } from './production-readiness-contract.mjs'

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
 * @param {{ expected: { commitSha: string, bundleDigest: string }, edgeApiUrl: string, frontendUrl: string, fetchImpl?: typeof fetch }} input
 */
export const probeHostedReleaseProvenance = async ({ expected, edgeApiUrl, frontendUrl, fetchImpl = fetch }) => {
  const edgeHealthUrl = `${edgeApiUrl.replace(/\/$/, '')}/health`
  const frontendMarkerUrl = new URL('release-provenance.json', `${frontendUrl.replace(/\/$/, '')}/`).toString()
  const [edge, frontend] = await Promise.all([
    fetchJson(fetchImpl, edgeHealthUrl, 'Edge health'),
    fetchJson(fetchImpl, frontendMarkerUrl, 'frontend provenance'),
  ])
  const failures = validateHostedReleaseProvenance(expected, edge, frontend)
  if (edge?.ok !== true || edge?.service !== 'pancake-supabase-api' || edge?.runtime !== 'supabase-edge') {
    failures.push('Edge health response does not identify the Pancake Supabase Edge runtime')
  }
  return { edgeHealthUrl, frontendMarkerUrl, edge, frontend, failures }
}

const main = async () => {
  const expected = {
    commitSha: envValue('E2E_EXPECTED_RELEASE_SHA') ?? '',
    bundleDigest: envValue('E2E_EXPECTED_BUNDLE_DIGEST') ?? '',
  }
  const edgeApiUrl = envValue('E2E_REMOTE_API_URL', 'EXPO_PUBLIC_API_URL')
  const frontendUrl = envValue('E2E_FRONTEND_URL')
  if (!edgeApiUrl || !frontendUrl) throw new Error('Hosted provenance requires E2E_REMOTE_API_URL and E2E_FRONTEND_URL')
  const result = await probeHostedReleaseProvenance({ expected, edgeApiUrl, frontendUrl })
  const rows = [
    {
      surface: 'Edge',
      status: result.failures.some((failure) => failure.startsWith('Edge ')) ? 'BLOCKED' : 'PASS',
      evidence: `${result.edgeHealthUrl}; commit=${result.edge?.commitSha ?? 'missing'}; bundle=${result.edge?.bundleDigest ?? 'missing'}`,
    },
    {
      surface: 'Frontend',
      status: result.failures.some((failure) => failure.startsWith('frontend ')) ? 'BLOCKED' : 'PASS',
      evidence: `${result.frontendMarkerUrl}; commit=${result.frontend?.commitSha ?? 'missing'}; bundle=${result.frontend?.bundleDigest ?? 'missing'}`,
    },
  ]
  if (result.failures.length > 0 && rows.every((row) => row.status === 'PASS')) {
    rows.push({ surface: 'Contract', status: 'BLOCKED', evidence: result.failures.join('; ') })
  }
  await writeMarkdownReport({
    reportPath: REPORT_PATH,
    title: 'Hosted Release Provenance',
    rows,
    columns: [
      { header: 'Surface', value: (row) => row.surface },
      { header: 'Status', value: (row) => row.status },
      { header: 'Evidence', value: (row) => row.evidence },
    ],
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
