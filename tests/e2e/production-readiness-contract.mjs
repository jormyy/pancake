/**
 * @param {{ legacyState: { ok: boolean, enabled: boolean | null, evidence: string }, legacyKeys: string[] | null, manualVerified: boolean }} input
 */
export const evaluateLegacyKeyReadiness = ({ legacyState, legacyKeys, manualVerified }) => {
  const authoritative = []
  if (legacyState.ok && typeof legacyState.enabled === 'boolean') {
    authoritative.push({ pass: legacyState.enabled === false, evidence: legacyState.evidence })
  }
  if (Array.isArray(legacyKeys)) {
    authoritative.push({
      pass: legacyKeys.length === 0,
      evidence: legacyKeys.length === 0
        ? 'Supabase API-key metadata no longer includes legacy JWT key records.'
        : `Supabase API-key metadata includes legacy key record(s): ${legacyKeys.join(', ')}.`,
    })
  }

  const contradiction = authoritative.find(({ pass }) => !pass)
  if (contradiction) return { pass: false, source: 'authoritative', evidence: contradiction.evidence }
  if (authoritative.length > 0) {
    return { pass: true, source: 'authoritative', evidence: authoritative.map(({ evidence }) => evidence).join(' ') }
  }
  return {
    pass: manualVerified,
    source: 'manual',
    evidence: manualVerified
      ? 'Manual hosted-project legacy-key verification was used because authoritative sources were unavailable.'
      : `Authoritative legacy-key state is unavailable. ${legacyState.evidence}`,
  }
}

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

const hostname = (value) => {
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * @param {{ expectedProjectRef: string, linkedProjectRef: string, supabaseUrl: string, edgeApiUrl: string }} input
 */
export const validateProductionBackendIdentity = ({ expectedProjectRef, linkedProjectRef, supabaseUrl, edgeApiUrl }) => {
  const failures = []
  if (!/^[a-z0-9]{20}$/.test(expectedProjectRef)) failures.push('expected production Supabase project ref is invalid')
  if (linkedProjectRef !== expectedProjectRef) failures.push('linked Supabase project does not match the pinned production project')

  const expectedSupabaseHost = `${expectedProjectRef}.supabase.co`
  if (hostname(supabaseUrl) !== expectedSupabaseHost) failures.push('Supabase URL does not match the pinned production project')
  if (hostname(edgeApiUrl) !== expectedSupabaseHost) failures.push('Edge API URL does not match the pinned production project')
  try {
    const path = new URL(edgeApiUrl).pathname.replace(/\/$/, '')
    if (path !== '/functions/v1/api') failures.push('Edge API URL does not target the Pancake API function')
  } catch {
    if (!failures.includes('Edge API URL does not match the pinned production project')) failures.push('Edge API URL is invalid')
  }
  return failures
}

/**
 * @param {{ expectedProjectRef: string, linkedProjectRef: string, supabaseUrl: string, edgeApiUrl: string, frontendUrl: string, expectedFrontendHost?: string, allowCandidateFrontend?: boolean }} input
 */
export const validateHostedTargetIdentity = ({
  expectedProjectRef,
  linkedProjectRef,
  supabaseUrl,
  edgeApiUrl,
  frontendUrl,
  expectedFrontendHost,
  allowCandidateFrontend = false,
}) => {
  const failures = validateProductionBackendIdentity({ expectedProjectRef, linkedProjectRef, supabaseUrl, edgeApiUrl })

  const frontendHost = hostname(frontendUrl)
  if (!frontendHost || !frontendUrl.startsWith('https://')) failures.push('frontend URL must be HTTPS')
  if (!allowCandidateFrontend) {
    if (!expectedFrontendHost) failures.push('pinned production frontend host is unavailable')
    else if (frontendHost !== expectedFrontendHost.toLowerCase()) failures.push('frontend URL does not match the pinned production host')
  }
  return failures
}

/** @param {{ status: number, text: string }} result */
export const validInternalEdgeAuthProbe = (result) => {
  if (result.status !== 200) return false
  try {
    const body = JSON.parse(result.text)
    return body?.ok === true && body?.action === '__edge_auth_probe__'
  } catch {
    return false
  }
}

/** @param {any} expected @param {any} edge @param {any} frontend */
export const validateHostedReleaseProvenance = (expected, edge, frontend) => {
  const failures = []
  if (!fullSha(expected?.commitSha)) failures.push('expected commitSha must be a full Git SHA')
  if (!digest(expected?.frontendBundleDigest)) failures.push('expected frontendBundleDigest must be a SHA-256 digest')
  if (!digest(expected?.edgeArtifactDigest)) failures.push('expected edgeArtifactDigest must be a SHA-256 digest')
  for (const [label, actual] of [['Edge', edge], ['frontend', frontend]]) {
    if (actual?.commitSha !== expected?.commitSha) {
      failures.push(`${label} commitSha ${actual?.commitSha ?? 'missing'} does not match ${expected?.commitSha ?? 'missing'}`)
    }
  }
  if (edge?.edgeArtifactDigest !== expected?.edgeArtifactDigest) {
    failures.push(`Edge edgeArtifactDigest ${edge?.edgeArtifactDigest ?? 'missing'} does not match ${expected?.edgeArtifactDigest ?? 'missing'}`)
  }
  if (frontend?.bundleDigest !== expected?.frontendBundleDigest) {
    failures.push(`frontend bundleDigest ${frontend?.bundleDigest ?? 'missing'} does not match ${expected?.frontendBundleDigest ?? 'missing'}`)
  }
  return failures
}
