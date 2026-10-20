import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './common.mjs'
import { sql } from './local-stack.mjs'

export async function functionFingerprint(execute = sql) {
  return sha256(await execute("SELECT coalesce(string_agg(pg_get_functiondef(p.oid),E'\\n' ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)),'') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f'"))
}

export async function applyOverlay(file, execute = sql) {
  assert.ok(path.isAbsolute(file), 'Mutation SQL overlay requires an absolute path')
  const source = await readFile(file, 'utf8')
  assert.ok(!/^\s*\\/m.test(source), 'Mutation overlay accepts SQL, not psql commands')
  const before = await functionFingerprint(execute)
  await execute(source)
  const after = await functionFingerprint(execute)
  return { file, sha256: sha256(source), before, after, appliedAfter: 'data restore, clock installation and runtime startup', source: 'explicit mutation overlay; application definitions are not restored afterwards' }
}
