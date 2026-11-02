import assert from 'node:assert/strict'
import path from 'node:path'
import {copyFile,mkdir,readFile} from 'node:fs/promises'
import {digest} from './common.mjs'

export async function copyFunctionFiles({sourceRoot,destination,baseFiles,overlays,overlayRoot}) {
  const allowed=file=>file==='types/database.ts' || /^supabase\/functions\/(?!.*(?:^|\/)\.)(?!.*\.\.\/)[\w/.-]+\.(?:ts|json)$/.test(file)
  const files=baseFiles.filter(allowed)
  for(const file of overlays)assert.ok(allowed(file) && files.includes(file),`Invalid function overlay: ${file}`)
  const hashes={}
  for(const file of files) {
    const target=path.join(destination,file)
    const source=path.join(overlays.includes(file)?overlayRoot:sourceRoot,file)
    await mkdir(path.dirname(target),{recursive:true})
    await copyFile(source,target)
    if(overlays.includes(file))hashes[file]=digest(await readFile(source))
  }
  return {root:path.join(destination,'supabase/functions'),hashes}
}
