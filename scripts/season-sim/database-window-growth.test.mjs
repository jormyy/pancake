import assert from 'node:assert/strict'
import test from 'node:test'
import { projectGrowth } from '../db-health/index.mjs'
import { clearDatabaseWindowReports, projectReplayGrowth } from './database-window-growth.mjs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const before={capturedAt:'2026-10-28T00:00:00Z',database:'postgres',serverStartedAt:'same',statementStatsResetAt:'same',statementStatsDeallocations:0,databaseBytes:100,tables:[],statements:[{queryId:'1',topLevel:true,calls:1,sharedReads:8}]}
const after={...before,capturedAt:'2026-10-28T00:01:00Z',databaseBytes:140,statementStatsDeallocations:1,statements:[{queryId:'1',topLevel:true,calls:2,sharedReads:1}]}

test('counter replacement preserves storage evidence without publishing statement totals',()=>{
  assert.throws(()=>projectGrowth(before,after,174,2),error=>error instanceof Error && 'code' in error && error.code==='STATEMENT_COUNTER_DECREASED')
  const result=projectReplayGrowth(before,after,174,2)
  assert.equal(result.database.observedByteChange,40)
  assert.equal(result.workload.complete,false)
  assert.deepEqual(result.workload,{
    complete:false,reason:'Statement counters decreased; statement totals and throughput are unavailable.',
    beforeDeallocations:0,afterDeallocations:1,
  })
  assert.equal('calls' in result.workload,false)
  assert.equal('walBytes' in result.workload,false)
})

test('replay growth still rejects a restarted or reset database',()=>{
  assert.throws(()=>projectReplayGrowth(before,{...after,serverStartedAt:'other'},174,2),/same server/)
  assert.throws(()=>projectReplayGrowth(before,{...after,statementStatsResetAt:'other'},174,2),/same reset/)
})

test('intact statement counters retain complete workload evidence',()=>{
  const result=projectReplayGrowth(before,{...after,statements:[{queryId:'1',topLevel:true,calls:2,sharedReads:9}]},174,2)
  assert.equal(result.workload.complete,true)
  assert.equal(Reflect.get(result.workload,'calls'),1)
})

test('a new window removes earlier result files without removing other evidence',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'window-results-'))
  try {
    await mkdir(path.join(root,'evidence'))
    for(const name of ['database-growth.json','database-window-result.json','keep.json']) {
      await writeFile(path.join(root,'evidence',name),'previous')
    }
    await clearDatabaseWindowReports(root)
    await assert.rejects(readFile(path.join(root,'evidence','database-growth.json')), {code:'ENOENT'})
    await assert.rejects(readFile(path.join(root,'evidence','database-window-result.json')), {code:'ENOENT'})
    assert.equal(await readFile(path.join(root,'evidence','keep.json'),'utf8'),'previous')
    await clearDatabaseWindowReports(root)
  } finally {
    await rm(root,{recursive:true,force:true})
  }
})
