import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {inputSource} from './input-source.mjs'

test('source manifests preserve failed responses and reject a corrupt cache',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'season-input-'))
  try{
    let calls=0
    const source=await inputSource(directory,async()=>{calls++;return new Response(calls===1?'missing':'{"real":true}',{status:calls===1?404:200})})
    const failed=await source('absent','https://example.test/source','test')
    assert.equal(failed.row.status,404)
    const fetched=await source('present','https://example.test/source','test')
    assert.equal(fetched.row.bytes,13)
    assert.equal((await source('present','https://example.test/source','test')).row.sha256,fetched.row.sha256)
    assert.equal(calls,2)
    assert.equal((await readFile(path.join(directory,'manifest.jsonl'),'utf8')).trim().split('\n').length,2)
    await writeFile(path.join(directory,fetched.row.file),'corrupt')
    await assert.rejects(()=>source('present','https://example.test/source','test'))
  }finally{await rm(directory,{recursive:true,force:true})}
})
