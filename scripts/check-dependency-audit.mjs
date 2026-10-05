/**
 * Dependency audit gate.
 *
 * `npm audit --audit-level=high` cannot be used directly: the dependency tree
 * carries advisories with no published fix, so the gate fails on every run and
 * stops meaning anything. This wrapper fails on any high/critical advisory that
 * is not explicitly accepted below, and — just as importantly — fails when an
 * accepted advisory stops appearing, so the list cannot rot unnoticed.
 *
 * Adding an entry is a decision, not a formality: record why the risk is
 * acceptable and what would let us drop it.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import process from 'node:process'

const ACCEPTED = [
  {
    id: 'GHSA-w3rx-r6r6-pgpr',
    package: 'image-size',
    reason: 'Denial of service in the ICNS parser. Reached only through metro/expo at '
      + 'build time, never at runtime, and only for images we author ourselves. '
      + 'No fixed version is published — the advisory covers every release up to '
      + 'and including the latest (2.0.2).',
    dropWhen: 'image-size publishes a release above 2.0.2 that clears the advisory.',
    reviewed: '2026-08-14',
  },
  {
    id: 'GHSA-5p2g-fcmc-qvqq',
    package: 'image-size',
    reason: 'Denial of service in the JXL/HEIF parsers. Same build-time-only exposure '
      + 'and same lack of a published fix as GHSA-w3rx-r6r6-pgpr.',
    dropWhen: 'image-size publishes a release above 2.0.2 that clears the advisory.',
    reviewed: '2026-08-14',
  },
  {
    id: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    reason: 'Stack-exhaustion denial of service from deeply nested brace patterns. '
      + 'Reached only through micromatch in metro-file-map and Jest 29 internals at '
      + 'build time, on patterns from repository and toolchain config, never at '
      + 'runtime. No fixed version is published — the advisory covers every release '
      + 'up to and including the latest (3.0.3).',
    dropWhen: 'braces publishes a release above 3.0.3 that clears the advisory. '
      + 'Temporary exception: re-review by 2026-11-05 or at the next Expo SDK '
      + 'upgrade, whichever comes first.',
    reviewed: '2026-10-05',
  },
  {
    id: 'GHSA-86w9-cpqp-85rv',
    package: 'node-forge',
    reason: 'RSA PKCS#1 v1.5 signature verification accepts forged signatures for '
      + 'low-exponent keys. Reached only through @expo/cli code signing (expo start '
      + 'update manifests, expo run:ios certificates), which verifies signatures it '
      + 'just created; the app has no expo-updates or updates config, and nothing '
      + 'ships it at runtime. No fixed version is published — the advisory covers '
      + 'every release up to and including the latest (1.4.0).',
    dropWhen: 'node-forge publishes a release above 1.4.0 that clears the advisory. '
      + 'Temporary exception: re-review by 2026-11-05, at the next Expo SDK upgrade, '
      + 'or before adopting expo-updates code signing, whichever comes first.',
    reviewed: '2026-10-05',
  },
]

const GATED_SEVERITIES = new Set(['high', 'critical'])

const runAudit = async () => {
  // npm audit exits non-zero when it finds anything, so a rejection is expected
  // and only the payload matters. A missing payload is a real failure.
  try {
    const { stdout } = await promisify(execFile)('npm', ['audit', '--json'], {
      maxBuffer: 32 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout)
    throw new Error(`npm audit did not produce a report: ${error?.message ?? error}`)
  }
}

const collectAdvisories = (report) => {
  const found = new Map()
  for (const vulnerability of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'string' || !GATED_SEVERITIES.has(via.severity)) continue
      const id = via.url?.split('/').pop()
      if (!id) continue
      if (!found.has(id)) found.set(id, { id, package: via.name, title: via.title, severity: via.severity })
    }
  }
  return found
}

const report = await runAudit()
const found = collectAdvisories(report)
const acceptedById = new Map(ACCEPTED.map((entry) => [entry.id, entry]))

const unaccepted = [...found.values()].filter((advisory) => !acceptedById.has(advisory.id))
const stale = ACCEPTED.filter((entry) => !found.has(entry.id))

for (const advisory of unaccepted) {
  console.error(`unaccepted ${advisory.severity} advisory: ${advisory.package} — ${advisory.title} (${advisory.id})`)
}
for (const entry of stale) {
  console.error(`accepted advisory ${entry.id} (${entry.package}) no longer appears — remove it from ACCEPTED`)
}

if (unaccepted.length > 0 || stale.length > 0) {
  console.error(`\n${unaccepted.length} unaccepted, ${stale.length} stale. See scripts/check-dependency-audit.mjs.`)
  process.exit(1)
}

const counts = report.metadata?.vulnerabilities ?? {}
console.log(
  `Dependency audit clean: ${found.size} high/critical advisor${found.size === 1 ? 'y' : 'ies'}, all accepted `
  + `(${ACCEPTED.map((entry) => entry.package).join(', ')}). `
  + `Full tree: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate.`,
)
