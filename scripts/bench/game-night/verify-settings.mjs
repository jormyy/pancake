import path from 'node:path'
import { parseArgs } from 'node:util'
import { defaultEvidence, command, directory, json, repository } from './common.mjs'
import { startStack } from './stack.mjs'

const { values } = parseArgs({ options: { evidence: { type: 'string', default: path.join(defaultEvidence, 'settings-verification') }, test: { type: 'string', multiple: true } } })
const evidence = path.resolve(values.evidence)
let stack
try {
  stack = await startStack(evidence)
  const results = []
  for (const file of values.test ?? [
    'supabase/functions/refresh-views/schedule.test.sql',
    'tests/db/statistics-maintenance.sql',
    'tests/db/statistics-freshness.sql',
    'tests/db/io-write-reductions.sql',
    'tests/db/work-queue-live-poll.sql',
    'tests/db/nightly-worker-hours.sql',
    ...['injuries','forecasts'].map(name => path.relative(repository, path.join(directory, `quality-${name}.sql`))),
  ]) {
    const output = await stack.sqlFile(path.join(repository, file), { allowFailure: true, output: path.join(evidence, path.basename(file)+'.log') })
    const row = { file, passed: output.code === 0, exitCode: output.code, error: output.stderr.split('\n').filter(line => line.includes('ERROR:')).join('\n') }
    results.push(row)
    console.log(JSON.stringify(row))
  }
  const target = new URL(stack.db)
  target.username = 'postgres'
  const catalog = await command(process.execPath, ['scripts/check-db-function-sources.mjs','--check-catalog'], { env: { PATH: process.env.PATH, HOME: process.env.HOME, PGPASSFILE: '/dev/null', SUPABASE_DB_URL: target.href }, allowFailure: true, file: path.join(evidence, 'catalog.log') })
  results.push({ file: 'function-catalog', passed: catalog.code === 0, exitCode: catalog.code, error: catalog.stderr })
  await json(path.join(evidence, 'results.json'), results)
  if (results.some(row => !row.passed)) process.exitCode = 1
} finally { await stack?.stop() }
