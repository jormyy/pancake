import path from 'node:path'
import ts from 'typescript'

export function changedFunctions(changedPaths, files, configuredFunctions) {
  const names = new Set(configuredFunctions)
  const changed = new Set(changedPaths.map(file => path.posix.normalize(file)))
  const affected = new Set()
  for (const file of changed) {
    const name = file.match(/^supabase\/functions\/([^/]+)\//)?.[1]
    if (name && !name.startsWith('_')) {
      if (!names.has(name)) throw new Error(`Changed function is removed or unconfigured: ${name}`)
      affected.add(name)
    }
  }
  const dependencies = new Map(Object.entries(files).map(([file, source]) => [file,
    ts.preProcessFile(source, true, true).importedFiles
      .map(({ fileName }) => fileName.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), fileName)) : null)
      .filter(Boolean),
  ]))
  const touchesChange = (file, visited = new Set()) => {
    if (changed.has(file)) return true
    if (visited.has(file)) return false
    visited.add(file)
    return (dependencies.get(file) ?? []).some(dependency => touchesChange(dependency, visited))
  }
  for (const name of names) {
    const entry = `supabase/functions/${name}/index.ts`
    if (!(entry in files)) throw new Error(`Missing function entry: ${entry}`)
    if (touchesChange(entry)) affected.add(name)
  }
  return [...affected].sort()
}

export function configuredFunctions(config) {
  return [...config.matchAll(/^\[functions\.([\w-]+)\]$/gm)].map(match => match[1]).sort()
}
