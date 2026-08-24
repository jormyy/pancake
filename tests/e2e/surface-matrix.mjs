import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { BACKEND_SCENARIO_MANIFEST } from './backend-scenario-manifest.mjs'
import { BROWSER_SCENARIO_MANIFEST } from './browser-scenario-manifest.mjs'

const ROOT = process.cwd()
export const SURFACE_MATRIX_PATH = path.join(
  ROOT,
  'docs/evidence/2026-08-23-instant-pwa/surface-matrix.json',
)

const DIMENSIONS = ['cache', 'freshness', 'realtime', 'autoUpdate', 'pwa']
const DATA_CONTRACT_FIELDS = [
  'owner',
  'cacheKey',
  'warmSource',
  'coldSource',
  'ttl',
  'invalidation',
  'realtimeEvent',
  'reconnect',
  'crossTab',
  'autoUpdate',
  'sizeBound',
  'failureFallback',
  'writePolicy',
]
const BUILTIN_EVIDENCE_IDS = [
  'browser.surface_online',
  'browser.surface_offline',
  'browser.surface_reconnect',
  'pwa.cache_update',
  'source.failure_recovery',
  'surface.matrix',
  'invariants.boundary',
  'dynasty.decision_tools',
  'environment.fake_upstream',
  'cross.cors',
  'realtime.delivery',
  'push.trade_waiver',
  'migration.midlife',
  'matchups.idempotent',
  'picks.long_horizon',
  'picks.rookie_materialization',
  'history.retained',
  'snapshots.no_shrink',
  'runtime.drift',
  'memory.drift',
]

const knownEvidenceIds = () => new Set([
  ...BUILTIN_EVIDENCE_IDS,
  ...BROWSER_SCENARIO_MANIFEST.map(({ evidenceId }) => evidenceId),
  ...BACKEND_SCENARIO_MANIFEST.map(({ evidenceId }) => evidenceId),
])

const textPresent = (value) => typeof value === 'string' && value.trim().length > 0

async function walkRoutes(directory, relative = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const nextRelative = path.posix.join(relative, entry.name)
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await walkRoutes(absolute, nextRelative))
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue
    if (entry.name === '_layout.tsx' || entry.name === '_layout.web.tsx' || entry.name === '+html.tsx') continue
    files.push(path.posix.join('app', nextRelative))
  }
  return files.sort()
}

export const repositoryRouteSources = () => walkRoutes(path.join(ROOT, 'app'))

export async function readSurfaceMatrix(matrixPath = SURFACE_MATRIX_PATH) {
  return JSON.parse(await readFile(matrixPath, 'utf8'))
}

function duplicateValues(values) {
  const seen = new Set()
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))]
}

function validateEvidenceIds(ids, known, label, failures) {
  if (!Array.isArray(ids) || ids.length === 0) {
    failures.push(`${label} has no evidence ids`)
    return
  }
  for (const id of ids) {
    if (!known.has(id)) failures.push(`${label} uses unknown evidence id ${id}`)
  }
}

export function validateSurfaceMatrix(matrix, routeSources) {
  const failures = []
  const known = knownEvidenceIds()
  if (matrix?.schemaVersion !== 1) failures.push('schemaVersion must be 1')
  if (!Array.isArray(matrix?.surfaces)) failures.push('surfaces must be an array')
  if (!Array.isArray(matrix?.backgrounds)) failures.push('backgrounds must be an array')
  if (!Array.isArray(matrix?.dataClasses)) failures.push('dataClasses must be an array')
  if (!Array.isArray(matrix?.functions)) failures.push('functions must be an array')
  if (failures.length > 0) return failures

  const surfaceIds = matrix.surfaces.map(({ id }) => id)
  const routeLabels = matrix.surfaces.map(({ routeLabel }) => routeLabel)
  const matrixSources = matrix.surfaces.map(({ source }) => source).sort()
  const dataIdList = matrix.dataClasses.map(({ id }) => id)
  const functionIdList = matrix.functions.map(({ id }) => id)
  const dataIds = new Set(dataIdList)
  const functionIds = new Set(functionIdList)
  const targetIds = new Set([...surfaceIds, ...matrix.backgrounds.map(({ id }) => id)])

  for (const duplicate of duplicateValues(surfaceIds)) failures.push(`duplicate surface id ${duplicate}`)
  for (const duplicate of duplicateValues(routeLabels)) failures.push(`duplicate route label ${duplicate}`)
  for (const duplicate of duplicateValues(matrixSources)) failures.push(`duplicate route source ${duplicate}`)
  for (const duplicate of duplicateValues(dataIdList)) failures.push(`duplicate data class id ${duplicate}`)
  for (const duplicate of duplicateValues(functionIdList)) failures.push(`duplicate function id ${duplicate}`)

  const missingRoutes = routeSources.filter((source) => !matrixSources.includes(source))
  const staleRoutes = matrixSources.filter((source) => !routeSources.includes(source))
  if (missingRoutes.length > 0) failures.push(`unmapped route sources: ${missingRoutes.join(', ')}`)
  if (staleRoutes.length > 0) failures.push(`stale route sources: ${staleRoutes.join(', ')}`)

  for (const target of [...matrix.surfaces, ...matrix.backgrounds]) {
    if (!textPresent(target.id)) failures.push('surface or background has no id')
    if (!Array.isArray(target.functionIds) || target.functionIds.length === 0) {
      failures.push(`${target.id} has no mapped functions`)
    }
    for (const id of target.functionIds ?? []) {
      if (!functionIds.has(id)) failures.push(`${target.id} uses unknown function ${id}`)
    }
    if (!target.contracts || typeof target.contracts !== 'object') {
      failures.push(`${target.id} has no contracts`)
      continue
    }
    for (const dimension of DIMENSIONS) {
      const contract = target.contracts[dimension]
      if (!contract || !['required', 'not-applicable'].includes(contract.mode)) {
        failures.push(`${target.id}.${dimension} has no explicit mode`)
        continue
      }
      if (contract.mode === 'not-applicable') {
        if (!textPresent(contract.reason)) failures.push(`${target.id}.${dimension} has no reason`)
        continue
      }
      if (!Array.isArray(contract.dataClassIds) || contract.dataClassIds.length === 0) {
        failures.push(`${target.id}.${dimension} has no data classes`)
      }
      for (const id of contract.dataClassIds ?? []) {
        if (!dataIds.has(id)) failures.push(`${target.id}.${dimension} uses unknown data class ${id}`)
      }
      validateEvidenceIds(contract.proofIds, known, `${target.id}.${dimension}`, failures)
    }
  }

  const usedDataIds = new Set()
  for (const target of [...matrix.surfaces, ...matrix.backgrounds]) {
    for (const dimension of DIMENSIONS) {
      for (const id of target.contracts?.[dimension]?.dataClassIds ?? []) usedDataIds.add(id)
    }
  }
  for (const dataClass of matrix.dataClasses) {
    if (!textPresent(dataClass.id)) failures.push('data class has no id')
    for (const field of DATA_CONTRACT_FIELDS) {
      if (!textPresent(dataClass[field])) failures.push(`${dataClass.id}.${field} is empty`)
    }
    if (!usedDataIds.has(dataClass.id)) failures.push(`unused data class ${dataClass.id}`)
  }

  for (const item of matrix.functions) {
    if (!textPresent(item.id)) failures.push('function has no id')
    if (!Array.isArray(item.targetIds) || item.targetIds.length === 0) failures.push(`${item.id} has no targets`)
    for (const id of item.targetIds ?? []) {
      if (!targetIds.has(id)) failures.push(`${item.id} uses unknown target ${id}`)
      const target = [...matrix.surfaces, ...matrix.backgrounds].find((candidate) => candidate.id === id)
      if (target && !target.functionIds.includes(item.id)) failures.push(`${item.id} is not linked back from ${id}`)
    }
    validateEvidenceIds(item.happyPathEvidenceIds, known, `${item.id}.happyPath`, failures)
    for (const kind of ['failurePaths', 'recoveryPaths']) {
      if (!Array.isArray(item[kind]) || item[kind].length === 0) failures.push(`${item.id}.${kind} is empty`)
      for (const pathItem of item[kind] ?? []) {
        if (!textPresent(pathItem.id)) failures.push(`${item.id}.${kind} has an unnamed path`)
        validateEvidenceIds(pathItem.evidenceIds, known, `${item.id}.${kind}.${pathItem.id}`, failures)
      }
    }
  }

  return failures
}

export function surfaceSoakCoverageFailures(matrix, rows) {
  const evidence = new Set(
    rows.filter(({ status }) => status === 'PASS').flatMap(({ evidenceIds }) => evidenceIds ?? []),
  )
  const failures = []
  const hasAny = (ids) => ids.some((id) => evidence.has(id))
  for (const item of matrix.functions) {
    if (!hasAny(item.happyPathEvidenceIds)) failures.push(`${item.id} happy path has no passing soak evidence`)
    for (const pathItem of item.failurePaths) {
      if (!hasAny(pathItem.evidenceIds)) failures.push(`${item.id} failure ${pathItem.id} has no passing soak evidence`)
    }
    for (const pathItem of item.recoveryPaths) {
      if (!hasAny(pathItem.evidenceIds)) failures.push(`${item.id} recovery ${pathItem.id} has no passing soak evidence`)
    }
  }
  return failures
}

export async function assertSurfaceMatrix() {
  const [matrix, routes] = await Promise.all([readSurfaceMatrix(), repositoryRouteSources()])
  const failures = validateSurfaceMatrix(matrix, routes)
  if (failures.length > 0) throw new Error(`Surface matrix failed:\n- ${failures.join('\n- ')}`)
  return matrix
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertSurfaceMatrix()
    .then((matrix) => {
      process.stdout.write(`${JSON.stringify({
        status: 'PASS',
        surfaces: matrix.surfaces.length,
        backgrounds: matrix.backgrounds.length,
        dataClasses: matrix.dataClasses.length,
        functions: matrix.functions.length,
      })}\n`)
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
