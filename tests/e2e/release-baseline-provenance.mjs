import process from 'node:process'

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

export const validateReleaseBaselineProvenance = ({ frontend, edge }) => {
  const failures = []
  if (!fullSha(frontend?.commitSha)) failures.push('deployed frontend commitSha is invalid')
  if (!digest(frontend?.bundleDigest)) failures.push('deployed frontend bundleDigest is invalid')
  if (!fullSha(edge?.commitSha)) failures.push('deployed Edge commitSha is invalid')
  if (!digest(edge?.edgeArtifactDigest)) failures.push('deployed Edge edgeArtifactDigest is invalid')
  if (edge?.ok !== true || edge?.service !== 'pancake-supabase-api' || edge?.runtime !== 'supabase-edge') {
    failures.push('deployed Edge health identity is invalid')
  }
  return failures
}

const fetchJson = async (url, label) => {
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`)
  return response.json()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const frontendUrl = process.env.E2E_PRODUCTION_FRONTEND_URL
  const edgeApiUrl = process.env.EXPO_PUBLIC_API_URL
  if (!frontendUrl || !edgeApiUrl) throw new Error('Production frontend and Edge URLs are required')
  const [frontend, edge] = await Promise.all([
    fetchJson(new URL('release-provenance.json', `${frontendUrl.replace(/\/$/, '')}/`), 'frontend provenance'),
    fetchJson(`${edgeApiUrl.replace(/\/$/, '')}/health`, 'Edge health'),
  ])
  const failures = validateReleaseBaselineProvenance({ frontend, edge })
  if (failures.length > 0) throw new Error(failures.join('; '))
  process.stdout.write(`${JSON.stringify({ frontend, edge })}\n`)
}
