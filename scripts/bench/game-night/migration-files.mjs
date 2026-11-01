import assert from 'node:assert/strict'
import {cp,copyFile,readFile,readdir} from 'node:fs/promises'
import path from 'node:path'
import {digest} from './common.mjs'

export async function copyMigrations(source,destination,overlays=[]) {
  await cp(source,destination,{recursive:true})
  const names=new Set(await readdir(destination))
  const added={}
  for(const file of overlays) {
    const name=path.basename(file)
    assert.match(name,/^\d{14}_[a-z0-9_]+\.sql$/,'Overlay must be a named migration')
    assert.ok(!names.has(name),'Overlay cannot replace an existing migration')
    await copyFile(file,path.join(destination,name))
    names.add(name)
    added[name]=digest(await readFile(file))
  }
  const hashes=Object.fromEntries(await Promise.all([...names].filter(name=>name.endsWith('.sql')).sort()
    .map(async name=>[name,digest(await readFile(path.join(destination,name)))])))
  return {hashes,added}
}
