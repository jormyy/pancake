import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { pickAllocator } from './db-source-rules/pick-allocator.mjs'
import { yearArithmetic } from './db-source-rules/year-arithmetic.mjs'

const rules = [pickAllocator, yearArithmetic]
const root = path.resolve(process.argv[2] ?? 'supabase/sql/functions/by-name')

const sqlFiles = async (dir) => (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) => {
  const full = path.join(dir, entry.name)
  if (entry.isDirectory()) return sqlFiles(full)
  return entry.name.endsWith('.sql') ? [full] : []
}))).flat()

const failures = []
for (const file of (await sqlFiles(root)).sort()) {
  const relative = path.relative(root, file).split(path.sep).join('/')
  const source = await readFile(file, 'utf8')
  for (const rule of rules) failures.push(...rule(relative, source))
}
for (const failure of failures) console.error(failure)
if (failures.length > 0) process.exitCode = 1
