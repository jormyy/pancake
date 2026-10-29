import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localDatabase, projectGrowth, snapshot } from '../../scripts/db-health/index.mjs'

test('health report refuses unassigned targets before opening a connection', () => {
  for (const value of [undefined, 'https://127.0.0.1:57422/postgres',
    'postgres://postgres@ceeytbfmwsnzalxlkalc.supabase.co:57422/postgres',
    'postgres://postgres@127.0.0.1:58922/postgres', 'postgres://postgres@127.0.0.1:57422/other',
    'postgres://postgres@127.0.0.1:57422/postgres?host=example.com']) {
    let connected = false
    assert.throws(() => snapshot(value, () => { connected = true }))
    assert.equal(connected, false)
  }
  assert.equal(localDatabase('postgres://postgres@127.0.0.1:57422/postgres').port, '57422')
})

test('health report uses a read-only query and keeps passwords out of arguments', () => {
  const result = snapshot('postgres://postgres:local-secret@127.0.0.1:57422/postgres', (command, args, options) => {
    assert.equal(command, 'psql')
    assert.ok(!args.join(' ').includes('local-secret'))
    assert.match(options.input, /^BEGIN READ ONLY;/)
    assert.equal(options.env.PGHOSTADDR, '127.0.0.1')
    assert.equal(options.env.PGPASSWORD, 'local-secret')
    assert.equal(options.env.PGSERVICE, undefined)
    assert.equal(options.env.PGOPTIONS, undefined)
    return '{"tables":[]}'
  })
  assert.deepEqual(result, { tables: [] })
})

test('growth comparison uses elapsed days and refuses restarted or mismatched samples', () => {
  const before = { capturedAt: '2026-10-20T00:00:00Z', database: 'postgres', serverStartedAt: 'same',
    tables: [{ relation: 'public.sample', totalBytes: 100 }] }
  const after = { ...before, capturedAt: '2026-10-22T00:00:00Z', tables: [{ relation: 'public.sample', totalBytes: 140 }] }
  const report = projectGrowth(before, after, 180)
  assert.equal(report.observedDays, 2)
  assert.equal(report.tables[0].bytesPerDay, 20)
  assert.equal(report.tables[0].projectedAdditionalBytes, 3600)
  assert.throws(() => projectGrowth(after, before, 180))
  assert.throws(() => projectGrowth(before, { ...after, serverStartedAt: 'different' }, 180))
  assert.throws(() => projectGrowth(before, { ...after, database: 'other' }, 180))
  assert.throws(() => projectGrowth(before, after, 0))
})

test('accelerated workloads use explicit simulated days without changing capture evidence',()=>{
  const before={capturedAt:'2026-10-28T00:00:00Z',database:'postgres',serverStartedAt:'same',tables:[{relation:'sample',totalBytes:100}]}
  const after={...before,capturedAt:'2026-10-28T00:02:00Z',tables:[{relation:'sample',totalBytes:140}]}
  const result=projectGrowth(before,after,180,2)
  assert.equal(result.observedDays,2)
  assert.equal(result.timeBasis,'simulated-days')
  assert.equal(result.capturedIntervalDays,2/1440)
  assert.equal(result.tables[0].bytesPerDay,20)
  for(const days of [0,-1,Infinity,NaN])assert.throws(()=>projectGrowth(before,after,180,days))
})


test('growth capture time comes from the host while database time stays visible',()=>{
  const started=Date.now()
  const report=snapshot('postgres://postgres@127.0.0.1:57422/postgres',()=>'{"capturedAt":"2077-01-01T00:00:00Z","tables":[]}')
  assert.equal(report.databaseCapturedAt,'2077-01-01T00:00:00Z')
  assert.ok(Date.parse(report.capturedAt)>=started&&Date.parse(report.capturedAt)<=Date.now())
})


test('workload deltas count top-level calls once across roles and retain missing-query evidence',()=>{
  const row={queryId:'1',topLevel:true,calls:2,totalMilliseconds:4,sharedReads:1,sharedHits:3,walBytes:100}
  const before={capturedAt:'2026-10-28T00:00:00Z',database:'postgres',serverStartedAt:'same',tables:[],statements:[row,{...row,topLevel:false,calls:1000}, {...row,queryId:'gone'}]}
  const after={...before,capturedAt:'2026-10-28T00:00:10Z',statements:[{...row,calls:4,totalMilliseconds:10,sharedReads:3,sharedHits:6,walBytes:400},{...row,calls:1,totalMilliseconds:2,sharedReads:0,sharedHits:1,walBytes:0}]}
  const result=projectGrowth(before,after,180,2).workload
  assert.equal(result.calls,3)
  assert.equal(result.totalMilliseconds,8)
  assert.equal(result.bufferReadBytes,16384)
  assert.equal(result.walBytesPerSecond,30)
  assert.equal(result.missingQueries,1)
  assert.equal(result.complete,false)
})

test('growth comparisons reject counter resets and invalid database blocks',()=>{
  const before={capturedAt:'2026-10-28T00:00:00Z',database:'postgres',serverStartedAt:'same',tables:[],statementStatsResetAt:'same',statements:[{queryId:'1',topLevel:true,calls:2}]}
  const after={...before,capturedAt:'2026-10-28T00:00:10Z'}
  assert.throws(()=>projectGrowth(before,{...after,statementStatsResetAt:'new'},180,2),/reset time/)
  assert.throws(()=>projectGrowth(before,{...after,statements:[{queryId:'1',topLevel:true,calls:1}]},180,2),/counters/)
  assert.throws(()=>projectGrowth(before,{...after,settings:{block_size:0}},180,2),/Block size/)
})

test('growth includes newly created partitions under their stable parent',()=>{
  const before={capturedAt:'2026-10-28T00:00:00Z',database:'postgres',serverStartedAt:'same',tables:[
    {relation:'public.events',partitionRoot:'public.events',totalBytes:0,inserted:0,estimatedLiveRows:0},
    {relation:'public.events_oct',partitionRoot:'public.events',totalBytes:100,inserted:10,estimatedLiveRows:10},
  ]}
  const after={...before,capturedAt:'2026-10-30T00:00:00Z',tables:[
    {relation:'public.events',partitionRoot:'public.events',totalBytes:0,inserted:0,estimatedLiveRows:0},
    {relation:'public.events_oct',partitionRoot:'public.events',totalBytes:120,inserted:12,estimatedLiveRows:12},
    {relation:'public.events_nov',partitionRoot:'public.events',totalBytes:50,inserted:5,estimatedLiveRows:5},
  ]}
  const result=projectGrowth(before,after,180,2)
  assert.equal(result.tables.length,1)
  assert.equal(result.tables[0].relation,'public.events')
  assert.equal(result.tables[0].observedByteChange,70)
  assert.equal(result.tables[0].observedInserts,7)
  assert.equal(result.tables[0].estimatedRowChange,7)
})
