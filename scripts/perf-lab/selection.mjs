import assert from 'node:assert/strict'

export function workloadSelection(env = process.env) {
  const choose = (name, values) => {
    const selected = env[name]?.split(',') ?? values
    assert.ok(selected.length && selected.every(value => values.includes(value)), `Invalid ${name}`)
    return [...new Set(selected)]
  }
  const surfaces = env.PERF_LAB_SURFACE?.split(',') ?? null
  assert.ok(!surfaces || surfaces.every(value => /^[a-zA-Z0-9_.-]+$/.test(value)), 'Invalid PERF_LAB_SURFACE')
  const cases = env.PERF_LAB_CASES?.split(',') ?? null
  assert.ok(!cases || cases.every(value => /^[a-zA-Z0-9_.-]+\/(commissioner|member)\/(in-progress|final)\/(cold|warm|offline|server-change|error|empty)$/.test(value)), 'Invalid PERF_LAB_CASES')
  const seconds = Number(env.PERF_LAB_SECONDS ?? 0)
  assert.ok(Number.isInteger(seconds) && seconds >= 0, 'Invalid PERF_LAB_SECONDS')
  assert.ok(['0', '1'].includes(env.PERF_LAB_STOP_ON_FAILURE ?? '0'), 'Invalid PERF_LAB_STOP_ON_FAILURE')
  return {
    seconds, surfaces, cases, stopOnFailure: env.PERF_LAB_STOP_ON_FAILURE === '1',
    scope: choose('PERF_LAB_SCOPE', ['all', 'routes', 'interactions']),
    states: choose('PERF_LAB_STATES', ['cold', 'warm', 'offline', 'server-change', 'error', 'empty']),
    roles: choose('PERF_LAB_ROLES', ['commissioner', 'member']),
    days: choose('PERF_LAB_DAYS', ['in-progress', 'final']),
  }
}

export function selectionEnvironment(env = process.env) {
  workloadSelection(env)
  return ['SURFACE', 'CASES', 'SCOPE', 'STATES', 'ROLES', 'DAYS', 'SECONDS', 'STOP_ON_FAILURE'].map(name => `PERF_LAB_${name}`).filter(key => env[key]).map(key => `${key}=${env[key]} `).join('')
}

export function selectedSurfaces(work, selection, phase = {}) {
  const selected = new Set(work.rows.filter(row => selection.roles.includes(row.role) && selection.days.includes(row.day)
    && selection.states.includes(row.state) && (!selection.cases || selection.cases.includes(row.id))
    && (!phase.role || phase.role === row.role) && (!phase.day || phase.day === row.day)).map(row => row.surface))
  return work.surfaces.filter(surface => (!selection.surfaces || selection.surfaces.includes(surface.id))
    && selected.has(surface.id) && (selection.scope.includes('all') || selection.scope.includes(surface.scenario ? 'interactions' : 'routes')))
}
