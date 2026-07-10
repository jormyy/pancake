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

/** @param {any} expected @param {any} edge @param {any} frontend */
export const validateHostedReleaseProvenance = (expected, edge, frontend) => {
  const failures = []
  if (!fullSha(expected?.commitSha)) failures.push('expected commitSha must be a full Git SHA')
  if (!digest(expected?.bundleDigest)) failures.push('expected bundleDigest must be a SHA-256 digest')
  for (const [label, actual] of [['Edge', edge], ['frontend', frontend]]) {
    for (const field of ['commitSha', 'bundleDigest']) {
      if (actual?.[field] !== expected?.[field]) {
        failures.push(`${label} ${field} ${actual?.[field] ?? 'missing'} does not match ${expected?.[field] ?? 'missing'}`)
      }
    }
  }
  return failures
}
