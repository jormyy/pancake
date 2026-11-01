import path from 'node:path'
import { command, directory, json, readJson, repository } from './common.mjs'
import { startStack } from './stack.mjs'

const evidence = '/Users/michaelchen/Documents/pancake-half-gig/evidence-climb/regressions-retry'
const sources = [
  ['e5f16211', path.resolve(repository, '../half-gig-origin')],
  ['current', repository],
]
for (const [label, sourceRoot] of sources) {
  const folder = path.join(evidence, label)
  let stack
  try {
    stack = await startStack(folder, { sourceRoot })
    const results = []
    for (const [name, file] of [
      ...['io-write-reductions.sql', 'statistics-maintenance.sql'].map(name => [name, path.join(repository, 'tests/db', name)]),
      ...['injuries','forecasts'].map(name => [`quality-${name}.sql`, path.join(directory, `quality-${name}.sql`)]),
    ]) {
      const output = path.join(folder, `${name}.log`)
      const result = await stack.sqlFile(file, { allowFailure: true, output })
      results.push({ name, exitCode: result.code, lastError: result.stderr.split('\n').filter(line => /ERROR:|CONTEXT:|NOTICE:.*(FAIL|failed)/.test(line)).slice(-5) })
    }
    const freshness = JSON.parse(await stack.sql("SELECT json_build_object('first',private.refresh_screen_statistics(),'second',private.refresh_screen_statistics())"))
    await json(path.join(folder, 'analysis-statuses.json'), freshness)
    const url = new URL(stack.db)
    url.username = 'supabase_admin'
    const catalog = await command(process.execPath, ['scripts/check-db-function-sources.mjs', '--check-catalog'], { cwd: sourceRoot, env: { PATH: process.env.PATH, HOME: process.env.HOME, PGPASSFILE: '/dev/null', SUPABASE_DB_URL: url.href }, allowFailure: true, file: path.join(folder, 'catalog.log') })
    const actual = JSON.parse(await stack.sql(`SELECT jsonb_object_agg(n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')',jsonb_build_object('owner',r.rolname,'acl',coalesce((SELECT jsonb_agg(coalesce(g.rolname,'PUBLIC')||'|'||x.privilege_type||'|'||x.is_grantable::text||'|'||coalesce(b.rolname,'PUBLIC') ORDER BY coalesce(g.rolname,'PUBLIC'),x.privilege_type,x.is_grantable,coalesce(b.rolname,'PUBLIC')) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))x LEFT JOIN pg_roles g ON g.oid=x.grantee LEFT JOIN pg_roles b ON b.oid=x.grantor),'[]'::jsonb))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner WHERE p.prokind='f' AND n.nspname IN('public','private','analytics')`))
    const expected = (await readJson(path.join(sourceRoot, 'supabase/sql/function-catalog.json'))).functions
    const permissions = Object.entries(expected).flatMap(([name, metadata]) => !actual[name] ? [{ name, issue: 'missing', expected: metadata, actual: null }] : metadata.owner !== actual[name].owner || JSON.stringify(metadata.acl) !== JSON.stringify(actual[name].acl) ? [{ name, issue: 'permissions differ', expected: metadata, actual: actual[name] }] : [])
    await json(path.join(folder, 'catalog-permissions.json'), { actual, permissions, extra: Object.keys(actual).filter(name => !expected[name]) })
    await json(path.join(folder, 'results.json'), { source: stack.metadata.source, results, permissions, catalogExitCode: catalog.code, catalogOutput: catalog.stdout, catalogErrors: catalog.stderr })
    console.log(JSON.stringify({ label, results, catalogExitCode: catalog.code, catalogSummary: (catalog.stdout + catalog.stderr).slice(-1600) }))
  } finally { await stack?.stop() }
}
