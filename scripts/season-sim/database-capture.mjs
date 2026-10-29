import assert from 'node:assert/strict'

export async function configurePlanCapture({ project, execute, enabled }) {
  assert.equal(project, 'pt4bafabledb', 'Plan capture requires the private database project')
  if (enabled) await execute("LOAD 'auto_explain'; RESET auto_explain.log_min_duration;")
  await execute(`ALTER SYSTEM SET auto_explain.log_min_duration='${enabled ? '0' : '-1'}'`)
  await execute('SELECT pg_reload_conf()')
}
