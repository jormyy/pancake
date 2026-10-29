import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { edgeFunctionNames } from './edge-function-inventory.mjs'

test('the replay discovers new workers without importing private or incomplete folders',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'edge-inventory-'))
  try{
    for(const name of ['worker','new-worker','_shared','missing-entry'])await mkdir(path.join(root,name))
    for(const name of ['worker','new-worker','_shared'])await writeFile(path.join(root,name,'index.ts'),'')
    assert.deepEqual(edgeFunctionNames(root),['new-worker','worker'])
  }finally{await rm(root,{recursive:true,force:true})}
})

test('the installed replay includes forecast and screen refresh workers',()=>{
  const names=edgeFunctionNames(fileURLToPath(new URL('../../supabase/functions/',import.meta.url)))
  assert.ok(names.includes('matchup-forecast'))
  assert.ok(names.includes('refresh-views'))
})
