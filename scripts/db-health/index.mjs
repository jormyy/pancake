import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { sourceAudit } from './source-audit.mjs'

export function localDatabase(value) {
  assert.ok(value, 'SUPABASE_DB_URL is required')
  const url = new URL(value)
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'Use PostgreSQL')
  assert.equal(url.hostname, '127.0.0.1', 'Use the assigned loopback database')
  assert.equal(url.port, process.env.PANCAKE_TEST_DB_PORT ?? '57422', 'Use the assigned database port')
  assert.equal(url.pathname, '/postgres', 'Use the assigned database')
  assert.equal(url.search, '', 'Database URL options are not allowed')
  assert.equal(url.hash, '', 'Database URL fragments are not allowed')
  return url
}

function statementDelta(before,after,seconds){
  if(!Array.isArray(before.statements)||!Array.isArray(after.statements))return undefined
  const metrics=['calls','totalMilliseconds','sharedHits','sharedReads','sharedDirtied','sharedWritten','tempReads','tempWritten','walBytes']
  const collect=rows=>{
    const result=new Map()
    for(const row of rows.filter(row=>row.topLevel===true)){
      const total=result.get(row.queryId)??Object.fromEntries(metrics.map(key=>[key,0]))
      for(const key of metrics)total[key]+=Number(row[key]??0)
      result.set(row.queryId,total)
    }
    return result
  }
  const previous=collect(before.statements),current=collect(after.statements)
  const totals=Object.fromEntries(metrics.map(key=>[key,0]))
  for(const [id,row] of current){
    for(const key of metrics){
      const delta=row[key]-(previous.get(id)?.[key]??0)
      assert.ok(Number.isFinite(delta),'Statement counters must stay finite inside a growth window')
      if(delta<0)throw Object.assign(new Error('Statement counters must not reset inside a growth window'),{
        code:'STATEMENT_COUNTER_DECREASED',queryId:id,metric:key,before:previous.get(id)?.[key]??0,after:row[key],
      })
      totals[key]+=delta
    }
  }
  const missingQueries=[...previous.keys()].filter(key=>!current.has(key)).length
  const blockBytes=Number(after.settings?.block_size??8192)
  assert.ok(Number.isSafeInteger(blockBytes)&&blockBytes>0,'Block size must be a positive integer')
  return {topLevelOnly:true,missingQueries,complete:missingQueries===0,wallSeconds:seconds,...totals,
    bufferReadBytes:totals.sharedReads*blockBytes,temporaryWriteBytes:totals.tempWritten*blockBytes,
    bufferReadBytesPerSecond:totals.sharedReads*blockBytes/seconds,walBytesPerSecond:totals.walBytes/seconds,
    logicalBuffersPerCall:(totals.sharedReads+totals.sharedHits)/Math.max(totals.calls,1)}
}

function tableTotals(tables){
  const totals=new Map()
  for(const table of tables){
    const relation=table.partitionRoot??table.relation
    const total=totals.get(relation)??{relation}
    for(const key of ['totalBytes','inserted','estimatedLiveRows']){
      if(Number.isFinite(table[key]))total[key]=(total[key]??0)+table[key]
    }
    totals.set(relation,total)
  }
  return [...totals.values()]
}

export function projectGrowth(before, after, seasonDays, simulatedDays = undefined) {
  const capturedDays = (Date.parse(after.capturedAt) - Date.parse(before.capturedAt)) / 86400000
  assert.ok(capturedDays > 0, 'Snapshots must have increasing capture times')
  const days=simulatedDays??capturedDays
  assert.ok(Number.isFinite(days)&&days>0,'Observed days must be positive')
  assert.ok(Number.isFinite(seasonDays) && seasonDays > 0, 'Season days must be positive')
  assert.equal(before.database, after.database, 'Snapshots must use the same database')
  assert.equal(before.serverStartedAt, after.serverStartedAt, 'Snapshots must use the same server run')
  if(before.statementStatsResetAt!=null||after.statementStatsResetAt!=null)assert.equal(before.statementStatsResetAt,after.statementStatsResetAt,'Statement statistics must use the same reset time')
  const oldTables = new Map(tableTotals(before.tables).map(table => [table.relation, table]))
  return {
    observedDays: days,
    capturedIntervalDays: capturedDays,
    timeBasis: simulatedDays==null?'capture-times':'simulated-days',
    seasonDays,
    workload:statementDelta(before,after,capturedDays*86400),
    database:Number.isFinite(before.databaseBytes)&&Number.isFinite(after.databaseBytes)?{beforeBytes:before.databaseBytes,afterBytes:after.databaseBytes,observedByteChange:after.databaseBytes-before.databaseBytes,linearSeasonAdditionalBytes:(after.databaseBytes-before.databaseBytes)/days*seasonDays}:undefined,
    evidence: 'Observed allocation changes; these are not a simulation receipt or a workload forecast.',
    tables: tableTotals(after.tables).map(table => {
      const previous = oldTables.get(table.relation)
      if (!previous) return { relation: table.relation, comparable: false }
      const bytesPerDay = (table.totalBytes - previous.totalBytes) / days
      return {
        relation: table.relation,
        comparable: true,
        currentBytes: table.totalBytes,
        observedByteChange: table.totalBytes - previous.totalBytes,
        observedInserts:Number.isFinite(previous.inserted)&&Number.isFinite(table.inserted)?table.inserted-previous.inserted:undefined,
        estimatedRowChange:Number.isFinite(previous.estimatedLiveRows)&&Number.isFinite(table.estimatedLiveRows)?table.estimatedLiveRows-previous.estimatedLiveRows:undefined,
        bytesPerDay,
        projectedAdditionalBytes: bytesPerDay * seasonDays,
      }
    }),
  }
}

export function connectionEnvironment(value) {
  const url = localDatabase(value)
  const inherited = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !['PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS'].includes(key)))
  return { ...inherited, PGHOST: url.hostname, PGHOSTADDR: url.hostname,
    PGPORT: url.port, PGDATABASE: 'postgres', PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password), PGPASSFILE: '/dev/null', PGSSLMODE: 'disable' }
}

export function snapshot(value, execute = execFileSync) {
  const env = connectionEnvironment(value)
  const sql = readFileSync(new URL('./snapshot.sql', import.meta.url), 'utf8')
  const output = execute('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
  const report=JSON.parse(output.trim())
  if(report.capturedAt){
    report.databaseCapturedAt=report.capturedAt
    report.capturedAt=new Date().toISOString()
  }
  return report
}

function walk(value, directory) {
  const env = connectionEnvironment(value)
  const sql = readFileSync(new URL('../../tests/db/excellence-screen-walk.sql', import.meta.url), 'utf8')
  mkdirSync(directory, { recursive: true })
  const resultsFile = path.join(directory, 'screen-walk.json')
  const plansFile = path.join(directory, 'screen-plans.log')
  const output = openSync(resultsFile, 'w', 0o600)
  const errors = openSync(plansFile, 'w', 0o600)
  try {
    execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
      { input: sql, encoding: 'utf8', env, stdio: ['pipe', output, errors] })
  } finally {
    closeSync(output)
    closeSync(errors)
  }
  return { resultsFile, plansFile }
}

async function main(args) {
  let report
  if (args[0] === '--verify') {
    assert.equal(args.length, 1, 'Use --verify with the local admin database URL')
    localDatabase(process.env.SUPABASE_DB_URL)
    await import('../../tests/db/hint-drain-timeouts.mjs')
    await import('../../tests/db/league-version-deferred.mjs')
    await import('../../tests/db/realtime-draft-publication.mjs')
    report = { checks: ['hint-drain-timeouts', 'deferred-versions', 'draft-publication'], passed: true }
  } else if (args[0] === '--walk') {
    assert.equal(args.length, 2, 'Use --walk OUTPUT_DIRECTORY with the local admin database URL')
    report = walk(process.env.SUPABASE_DB_URL, args[1])
  } else if (args[0] === '--sources') {
    assert.equal(args.length, 1, 'Use --sources')
    report = sourceAudit()
  } else if (args[0] === '--compare') {
    assert.ok(args.length===4||args.length===5, 'Use --compare BEFORE.json AFTER.json SEASON_DAYS [SIMULATED_DAYS]')
    report = projectGrowth(JSON.parse(readFileSync(args[1], 'utf8')),
      JSON.parse(readFileSync(args[2], 'utf8')), Number(args[3]),args[4]==null?undefined:Number(args[4]))
  } else {
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Use --output FILE.json')
    report = snapshot(process.env.SUPABASE_DB_URL)
  }
  const output = `${JSON.stringify(report, null, 2)}\n`
  if (args[0] === '--output') writeFileSync(args[1], output, { mode: 0o600 })
  else process.stdout.write(output)
}

export async function runCli(args) {
  try { await main(args) }
  catch (error) {
    process.stderr.write(`${error instanceof assert.AssertionError ? error.message : 'Database health report failed. Check the local database and input files.'}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await runCli(process.argv.slice(2))
