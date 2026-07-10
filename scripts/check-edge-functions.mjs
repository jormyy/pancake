import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FUNCTIONS_DIR = path.join(ROOT, 'supabase/functions')
const CONFIG_PATH = path.join(ROOT, 'supabase/config.toml')

const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/')

export function configuredFunctionNames(source = readFileSync(CONFIG_PATH, 'utf8')) {
  return [...source.matchAll(/^\[functions\.([a-z0-9-]+)\]$/gm)].map((match) => match[1]).sort()
}

export function edgeEntrypoints() {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => path.join(FUNCTIONS_DIR, entry.name, 'index.ts'))
    .filter(existsSync)
    .sort()
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    return entry.isDirectory() ? filesBelow(target) : [target]
  })
}

export function edgeTests() {
  return filesBelow(FUNCTIONS_DIR).filter((file) => file.endsWith('.test.ts')).sort()
}

export function inventoryFailures(configured, entrypointNames) {
  const configuredSet = new Set(configured)
  const entrypointSet = new Set(entrypointNames)
  return [
    ...configured.filter((name) => !entrypointSet.has(name)).map((name) => `configured function ${name} has no index.ts`),
    ...entrypointNames.filter((name) => !configuredSet.has(name)).map((name) => `Edge entrypoint ${name} is missing from config.toml`),
  ].sort()
}

export function checkInventory() {
  const entrypoints = edgeEntrypoints()
  const names = entrypoints.map((file) => path.basename(path.dirname(file)))
  const failures = inventoryFailures(configuredFunctionNames(), names)
  if (failures.length > 0) throw new Error(failures.join('\n'))
  return { entrypoints, tests: edgeTests() }
}

function run() {
  const { entrypoints, tests } = checkInventory()
  console.log(`Edge inventory: ${entrypoints.length} entrypoints, ${tests.length} test files`)
  if (process.argv.includes('--inventory-only')) return

  execFileSync('deno', ['check', ...entrypoints.map(relative)], { cwd: ROOT, stdio: 'inherit' })
  execFileSync('deno', [
    'test',
    '--allow-env',
    '--allow-net',
    '--allow-read',
    ...tests.map(relative),
  ], { cwd: ROOT, stdio: 'inherit' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
