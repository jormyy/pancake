import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { REQUIRED_MUTATION_SCENARIOS, validateMutationCompatibilityReport } from './release-mutation-compatibility.mjs'

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)

export const validateReleaseCompatibilityEvidence = ({
  candidateSha,
  deployedFrontendSha,
  deployedEdgeSha,
  deployedFrontendRebuild,
  pairs,
}) => {
  const failures = []
  const expected = new Map([
    ['deployed-frontend-candidate-edge', { frontendSha: deployedFrontendSha, edgeSha: candidateSha }],
    ['deployed-frontend-deployed-edge', { frontendSha: deployedFrontendSha, edgeSha: deployedEdgeSha }],
    ['candidate-frontend-deployed-edge', { frontendSha: candidateSha, edgeSha: deployedEdgeSha }],
  ])
  for (const [id, identity] of expected) {
    const pair = pairs?.find((candidate) => candidate?.id === id)
    if (!pair) {
      failures.push(`${id} evidence is missing`)
      continue
    }
    if (pair.status !== 'PASS') failures.push(`${id} mutation contract failed: ${pair.error ?? 'unknown error'}`)
    if (pair.frontend?.commitSha !== identity.frontendSha) failures.push(`${id} frontend commit does not match the intended pairing`)
    if (pair.edge?.commitSha !== identity.edgeSha) failures.push(`${id} Edge commit does not match the intended pairing`)
    if (!digest(pair.frontend?.bundleDigest)) failures.push(`${id} frontend artifact digest is invalid`)
    if (!digest(pair.edge?.edgeArtifactDigest)) failures.push(`${id} Edge artifact digest is invalid`)
    for (const scenarioId of REQUIRED_MUTATION_SCENARIOS) {
      if (!pair.mutationEvidenceIds?.includes(scenarioId)) failures.push(`${id} did not retain ${scenarioId} mutation evidence`)
    }
  }
  for (const [label, sha] of [['candidate', candidateSha], ['deployed frontend', deployedFrontendSha], ['deployed Edge', deployedEdgeSha]]) {
    if (!fullSha(sha)) failures.push(`${label} SHA is invalid`)
  }
  const deployedPair = pairs?.find((candidate) => candidate?.id === 'deployed-frontend-candidate-edge')
  if (deployedFrontendRebuild?.exactProductionRebuildVerified !== true) {
    failures.push('deployed frontend exact production rebuild was not verified')
  }
  if (!digest(deployedFrontendRebuild?.liveBundleDigest)) {
    failures.push('deployed frontend live bundle digest is invalid')
  }
  if (deployedFrontendRebuild?.compatibilityBundleDigest !== deployedPair?.frontend?.bundleDigest) {
    failures.push('deployed frontend compatibility digest does not identify the browser-tested bundle')
  }
  return failures
}

const required = (name, value) => {
  if (!value) throw new Error(`${name} is required`)
  return value
}

const main = async () => {
  const [oldFrontendNewEdgeReportPath, deployedPairReportPath, newFrontendOldEdgeReportPath] = process.argv.slice(2)
  if (!oldFrontendNewEdgeReportPath || !deployedPairReportPath || !newFrontendOldEdgeReportPath) {
    throw new Error('Three browser report paths are required')
  }
  const [oldFrontendNewEdgeReport, deployedPairReport, newFrontendOldEdgeReport] = await Promise.all([
    readFile(oldFrontendNewEdgeReportPath, 'utf8').then(JSON.parse),
    readFile(deployedPairReportPath, 'utf8').then(JSON.parse),
    readFile(newFrontendOldEdgeReportPath, 'utf8').then(JSON.parse),
  ])
  for (const [label, report] of [
    ['deployed-frontend-candidate-edge', oldFrontendNewEdgeReport],
    ['deployed-frontend-deployed-edge', deployedPairReport],
    ['candidate-frontend-deployed-edge', newFrontendOldEdgeReport],
  ]) {
    const reportFailures = validateMutationCompatibilityReport(report)
    if (reportFailures.length > 0) throw new Error(`${label}: ${reportFailures.join('; ')}`)
  }
  const candidateSha = required('E2E_RELEASE_SHA', process.env.E2E_RELEASE_SHA)
  const deployedFrontendSha = required('E2E_DEPLOYED_FRONTEND_SHA', process.env.E2E_DEPLOYED_FRONTEND_SHA)
  const deployedFrontendDigest = required('E2E_DEPLOYED_FRONTEND_DIGEST', process.env.E2E_DEPLOYED_FRONTEND_DIGEST)
  const deployedFrontendCompatibilityDigest = required(
    'E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST',
    process.env.E2E_DEPLOYED_FRONTEND_COMPATIBILITY_DIGEST,
  )
  const deployedEdgeSha = required('E2E_DEPLOYED_EDGE_SHA', process.env.E2E_DEPLOYED_EDGE_SHA)
  const deployedEdgeDigest = required('E2E_DEPLOYED_EDGE_DIGEST', process.env.E2E_DEPLOYED_EDGE_DIGEST)
  const candidateEdgeDigest = required('E2E_CANDIDATE_EDGE_DIGEST', process.env.E2E_CANDIDATE_EDGE_DIGEST)
  const candidateFrontendDigest = required('E2E_CANDIDATE_FRONTEND_DIGEST', process.env.E2E_CANDIDATE_FRONTEND_DIGEST)
  const deployedFrontendRebuild = {
    commitSha: deployedFrontendSha,
    liveBundleDigest: deployedFrontendDigest,
    exactProductionRebuildVerified: true,
    compatibilityBundleDigest: deployedFrontendCompatibilityDigest,
  }
  const pairs = [
    {
      id: 'deployed-frontend-candidate-edge',
      status: oldFrontendNewEdgeReport.status,
      error: oldFrontendNewEdgeReport.failures?.join('; '),
      frontend: { commitSha: deployedFrontendSha, bundleDigest: deployedFrontendCompatibilityDigest },
      edge: { commitSha: candidateSha, edgeArtifactDigest: candidateEdgeDigest },
      mutationEvidenceIds: oldFrontendNewEdgeReport.scenarios.filter((scenario) => scenario.status === 'PASS').map((scenario) => scenario.id),
    },
    {
      id: 'deployed-frontend-deployed-edge',
      status: deployedPairReport.status,
      error: deployedPairReport.failures?.join('; '),
      frontend: { commitSha: deployedFrontendSha, bundleDigest: deployedFrontendCompatibilityDigest },
      edge: { commitSha: deployedEdgeSha, edgeArtifactDigest: deployedEdgeDigest },
      mutationEvidenceIds: deployedPairReport.scenarios.filter((scenario) => scenario.status === 'PASS').map((scenario) => scenario.id),
    },
    {
      id: 'candidate-frontend-deployed-edge',
      status: newFrontendOldEdgeReport.status,
      error: newFrontendOldEdgeReport.failures?.join('; '),
      frontend: { commitSha: candidateSha, bundleDigest: candidateFrontendDigest },
      edge: { commitSha: deployedEdgeSha, edgeArtifactDigest: deployedEdgeDigest },
      mutationEvidenceIds: newFrontendOldEdgeReport.scenarios.filter((scenario) => scenario.status === 'PASS').map((scenario) => scenario.id),
    },
  ]
  const failures = validateReleaseCompatibilityEvidence({
    candidateSha,
    deployedFrontendSha,
    deployedEdgeSha,
    deployedFrontendRebuild,
    pairs,
  })
  const report = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    candidateSha,
    deployedFrontendRebuild,
    pairs,
    failures,
  }
  const artifactRoot = path.join(process.cwd(), 'tests/artifacts/compatibility')
  await mkdir(artifactRoot, { recursive: true })
  await writeFile(path.join(artifactRoot, 'release-runtime-compatibility.json'), `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(path.join(artifactRoot, 'release-runtime-compatibility.md'), [
    '# Release Runtime Compatibility',
    '',
    `- Status: ${report.status}`,
    ...pairs.map((pair) => `- ${pair.id}: ${pair.status}; frontend=${pair.frontend.commitSha}; edge=${pair.edge.commitSha}`),
    ...failures.map((failure) => `- Failure: ${failure}`),
    '',
  ].join('\n'))
  if (failures.length > 0) throw new Error(failures.join('; '))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
