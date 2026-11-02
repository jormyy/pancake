import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises'
import path from 'node:path'
import {tmpdir} from 'node:os'
import test from 'node:test'
import {copyMigrations} from './migration-files.mjs'
import {digest} from './common.mjs'

test('an explicit overlay preserves base migrations and records exactly what executes',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'game-night-migrations-'))
  try {
    const source=path.join(root,'source'),destination=path.join(root,'runtime')
    await mkdir(source)
    await writeFile(path.join(source,'20260101000000_base.sql'),'SELECT 1;')
    const overlay=path.join(root,'20260102000000_fix.sql')
    await writeFile(overlay,'SELECT 2;')
    const result=await copyMigrations(source,destination,[overlay])
    assert.equal(await readFile(path.join(destination,path.basename(overlay)),'utf8'),'SELECT 2;')
    assert.equal(result.added[path.basename(overlay)],digest('SELECT 2;'))
    assert.equal(result.hashes['20260101000000_base.sql'],digest('SELECT 1;'))
    await assert.rejects(()=>copyMigrations(source,path.join(root,'rejected'),[path.join(source,'20260101000000_base.sql')]),/cannot replace/)
  }finally {await rm(root,{recursive:true,force:true})}
})
