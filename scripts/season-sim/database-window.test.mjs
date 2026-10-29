import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { validateDatabaseWindow } from './database-window-contract.mjs'
import { readNextScheduleSource } from './origin.mjs'
import { prepareDatabaseWindow } from './database-window.mjs'

test('database windows preserve their exact target, duration, season, and synthetic provenance',()=>{
  const window={version:1,start:'2026-10-29',end:'2026-10-30',days:2,seasonYear:2027,games:12,provenance:'SYNTHETIC'}
  assert.equal(validateDatabaseWindow(window,'pt4bafabledb',2027),window)
  for(const change of [{days:3},{end:'2026-10-31'},{provenance:'REAL-RAW'},{games:0},{seasonYear:2026}]){
    assert.throws(()=>validateDatabaseWindow({...window,...change},'pt4bafabledb',2027))
  }
  assert.throws(()=>validateDatabaseWindow(window,'pt4bafableux',2027))
})

test('future schedule input stays required outside the bounded database workload',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'database-window-'))
  try{
    await assert.rejects(()=>readNextScheduleSource(root,null),{code:'ENOENT'})
    assert.equal(await readNextScheduleSource(root,{days:2}),null)
    await writeFile(path.join(root,'next-schedule-source.json'),'{broken')
    await assert.rejects(()=>readNextScheduleSource(root,{days:2}))
    await writeFile(path.join(root,'next-schedule-source.json'),'{}')
    assert.deepEqual(await readNextScheduleSource(root,null),{})
  }finally{await rm(root,{recursive:true,force:true})}
})

test('preparing a database window rejects an invalid date before database access',async()=>{
  await assert.rejects(()=>prepareDatabaseWindow('invalid'))
})
