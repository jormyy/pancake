import assert from 'node:assert/strict'
import { labTarget } from '../perf-lab/target.mjs'

export function validateDatabaseWindow(value, project, year, env = process.env) {
  assert.equal(project, env.PERF_LAB_PROJECT ? labTarget(env).project : 'pt4bafabledb', 'A database window requires its assigned private project')
  assert.equal(value.version, 1)
  assert.equal(value.days, 2, 'The database workload covers exactly two days')
  assert.equal(value.seasonYear, year)
  assert.match(value.start, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(value.end, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(Date.parse(`${value.end}T12:00:00Z`)-Date.parse(`${value.start}T12:00:00Z`),86400000)
  assert.equal(value.provenance, 'SYNTHETIC')
  assert.ok(value.games > 0)
  return value
}
