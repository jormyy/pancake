import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { digest, sourceRoot } from './common.mjs'
import { controlInventory } from './interactions.mjs'
import { currentScenario } from './scenario-adapters.mjs'

const states = ['cold', 'warm', 'server-change', 'offline', 'empty', 'error']
const roles = ['commissioner', 'member']
const days = ['in-progress', 'final']

const sections = {
  'league-dashboard': ['results', 'history', 'picks', 'schedule', 'draft', 'bracket', 'settings'],
  players: ['players', 'waivers', 'rankings', 'news'],
  trades: ['offers', 'block', 'history', 'analyzer'],
}

async function filesUnder(directory) {
  const rows = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(rows.map(row => row.isDirectory() ? filesUnder(path.join(directory, row.name)) : path.join(directory, row.name)))).flat()
}

export async function inventory(root = sourceRoot) {
  const matrixBytes = await readFile(path.join(root, 'tests/e2e/surface-matrix.json'))
  const matrix = JSON.parse(matrixBytes.toString('utf8'))
  const routes = (await filesUnder(path.join(root, 'app'))).filter(file => file.endsWith('.tsx') && !/\/(?:_layout|\+html)\.tsx$/.test(file)).map(file => path.relative(root, file)).sort()
  const declared = matrix.surfaces.map(surface => surface.source).sort()
  assert.deepEqual(declared, routes, 'Surface inventory differs from the route files')
  const scenarios = []
  const scenarioFiles = ['scripts/perf-lab/scenarios.json', 'scripts/ios-sim/scenarios.json', ...(await readdir(path.join(root, 'scripts/ios-sim/scenarios'))).filter(file => file.endsWith('.json')).sort().map(file => `scripts/ios-sim/scenarios/${file}`)]
  const hashes = { 'tests/e2e/surface-matrix.json': digest(matrixBytes) }
  hashes['public/sw.js'] = digest(await readFile(path.join(root, 'public/sw.js')))
  hashes['scripts/perf-lab/release-ui.mjs'] = digest(await readFile(path.join(root, 'scripts/perf-lab/release-ui.mjs')))
  for (const file of ['player-results.mjs', 'edge.mjs', 'edge-routing.mjs', 'scenario-adapters.mjs', 'workloads.mjs', 'walk.mjs', 'actions.mjs', 'interactions.mjs', 'control-observer.mjs', 'network-proxy.mjs', 'settle.mjs', 'device.mjs', 'runtime.mjs', 'surfaces.mjs', 'phases.mjs', 'server-change.mjs', 'empty.mjs', 'selection.mjs', 'observer.mjs', 'capture.mjs', 'headshots.mjs', 'external-headshots.mjs', 'bounded-log.mjs']) {
    const relative = `scripts/perf-lab/${file}`
    hashes[relative] = digest(await readFile(path.join(root, relative)))
  }
  for (const directory of ['app', 'components', 'contexts', 'hooks', 'lib', 'supabase/functions', 'supabase/migrations']) {
    for (const file of (await filesUnder(path.join(root, directory))).filter(file => /\.(?:ts|tsx|sql)$/.test(file)).sort()) hashes[path.relative(root, file)] = digest(await readFile(file))
  }
  for (const file of scenarioFiles) {
    const bytes = await readFile(path.join(root, file))
    hashes[file] = digest(bytes)
    for (const scenario of JSON.parse(bytes.toString('utf8'))) scenarios.push(currentScenario({ ...scenario, source: file }))
  }
  const surfaces = matrix.surfaces.map(surface => ({
    id: surface.id, route: surface.path, source: surface.source,
    first: surface.navigation?.firstView ?? 'Unreviewed',
    lazy: 'Unreviewed; requires Michael’s first-paint review',
    data: [...new Set(Object.values(surface.contracts).flatMap(contract => contract.dataClassIds ?? []))],
  }))
  for (const [id, values] of Object.entries(sections)) {
    const surface = surfaces.find(row => row.id === id)
    for (const section of values) surfaces.push({ ...surface, id: `${id}.${section}`, route: `${surface.route}?${id === 'players' ? 'section' : 'tab'}=${section}`, first: `${section} section content` })
  }
  for (const scenario of scenarios) {
    let route = scenario.from
    for (const [index, step] of scenario.steps.entries()) {
      const id = `interaction.${scenario.name}.${step.name ?? index + 1}`
      assert.ok(!surfaces.some(surface => surface.id === id), `Duplicate workload ${id}`)
      route = step.expected?.route ?? step.action?.open ?? route
      const pathname = route.split('?')[0]
      const owner = surfaces.find(surface => !surface.scenario && new RegExp(`^${surface.route.split('?')[0].replace(/:[a-zA-Z]+/g, '[^/]+')}$`).test(pathname))
      surfaces.push({ id, route, source: scenario.source,
        first: JSON.stringify(step.expected), lazy: 'Unreviewed; requires visual evidence', data: owner?.data ?? [],
        scenario: scenario.name, step: index, setup: scenario.setup ?? null })
    }
  }
  const rows = surfaces.flatMap(surface => roles.flatMap(role => days.flatMap(day => states.map(state => ({
    id: `${surface.id}/${role}/${day}/${state}`, surface: surface.id, role, day, state,
    test: `perf-lab.walk:${surface.id}:${role}:${day}:${state}`,
  })))))
  return { version: 1, controls: controlInventory(scenarios), hashes, fingerprint: digest(JSON.stringify(hashes)), routes, dataClasses: matrix.dataClasses, surfaces, scenarios, rows }
}

export function evidenceFailures(row, evidence, fingerprint) {
  if (!evidence) return ['not run']
  const failures = []
  if (evidence.id !== row.id || evidence.fingerprint !== fingerprint) failures.push('different workload or source')
  for (const engine of ['webkit']) {
    const proof = evidence[engine]
    if (!proof) { failures.push(`${engine} missing`); continue }
    if (proof.passed !== true) failures.push(`${engine} assertions failed`)
    if (proof.firstFrameReady !== true) failures.push(`${engine} first visible frame unproved`)
    for (const key of ['requests', 'bytesIn', 'bytesOut', 'firstContentMs', 'settledMs', 'dbCalls', 'dbRows', 'dbBuffers', 'pushBytes', 'cacheHits', 'cacheMisses', 'invalidations']) {
      if (!Number.isFinite(proof[key]) || proof[key] < 0) failures.push(`${engine} ${key} missing`)
    }
    for (const key of ['har', 'firstScreenshot', 'settledScreenshot', 'dbEvidence', 'cacheEvidence', 'pushEvidence']) {
      if (!proof[key]) failures.push(`${engine} ${key} missing`)
    }
    if (row.state === 'server-change' && proof.observedChange !== true) failures.push(`${engine} server change unproved`)
    if (row.state === 'error' && proof.errorExercised !== true) failures.push(`${engine} refresh error unproved`)
    if (row.state === 'empty' && proof.emptyContent !== true) failures.push(`${engine} empty content unproved`)
    if (row.state === 'offline' && proof.offlineContent !== true) failures.push(`${engine} offline content unproved`)
    if (row.day === 'final' && proof.finalDay !== true) failures.push(`${engine} final day unproved`)
    if (proof.role !== row.role) failures.push(`${engine} role unproved`)
    if (proof.phone?.profile !== true || proof.phone?.touch !== true || proof.phone?.standalone !== true) failures.push('iPhone standalone emulation unproved')
  }
  return failures
}
