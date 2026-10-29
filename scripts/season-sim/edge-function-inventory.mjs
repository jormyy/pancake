import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

export function edgeFunctionNames(directory) {
  return readdirSync(directory,{withFileTypes:true})
    .filter(entry=>entry.isDirectory()&&!entry.name.startsWith('_')&&existsSync(path.join(directory,entry.name,'index.ts')))
    .map(entry=>entry.name).sort()
}
