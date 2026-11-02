import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {copyFunctionFiles} from './function-files.mjs'

test('correctness overlays preserve the base files and never copy environment files',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'game-night-functions-'))
  try {
    for(const side of ['base','fix']) {
      await mkdir(path.join(root,side,'supabase/functions/worker'),{recursive:true})
      await writeFile(path.join(root,side,'supabase/functions/worker/index.ts'),side)
    }
    await writeFile(path.join(root,'base/supabase/functions/worker/retained.ts'),'retained')
    await writeFile(path.join(root,'base/supabase/functions/.env'),'synthetic excluded fixture')
    const options={sourceRoot:path.join(root,'base'),overlayRoot:path.join(root,'fix'),destination:path.join(root,'out'),
      baseFiles:['supabase/functions/worker/index.ts','supabase/functions/worker/retained.ts','supabase/functions/.env'],overlays:['supabase/functions/worker/index.ts']}
    const result=await copyFunctionFiles(options)
    assert.equal(await readFile(path.join(result.root,'worker/index.ts'),'utf8'),'fix')
    assert.equal(await readFile(path.join(result.root,'worker/retained.ts'),'utf8'),'retained')
    await assert.rejects(access(path.join(result.root,'.env')))
    assert.deepEqual(Object.keys(result.hashes),options.overlays)
    await assert.rejects(copyFunctionFiles({...options,overlays:['../outside.ts']}))
  }finally{await rm(root,{recursive:true,force:true})}
})
