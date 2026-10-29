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

export function checkedDenoRecipes(scripts) {
  return [...new Set(Object.values(scripts).flatMap(command => {
    if (typeof command !== 'string') return []
    return [...command.matchAll(/\bdeno\s+run\s+([^;&|]+)/g)].flatMap(([, argumentsText]) => {
      const tokens = argumentsText.trim().split(/\s+/)
      if (!tokens.includes('--check')) return []
      const entrypoint = tokens.find(token => /\.(?:ts|mts|js|mjs)$/.test(token))
      if (!entrypoint) throw new Error(`Checked Deno recipe has no entrypoint: ${command}`)
      return [entrypoint]
    })
  }))].sort()
}

function run() {
  const { entrypoints, tests } = checkInventory()
  console.log(`Edge inventory: ${entrypoints.length} entrypoints, ${tests.length} test files`)
  const recipes = checkedDenoRecipes(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts)
  if (recipes.length) execFileSync('deno', ['check', '--no-lock', ...recipes], { cwd: ROOT, stdio: 'inherit' })
  console.log(`Deno evidence recipes: ${recipes.length} entrypoints checked`)
  if (process.argv.includes('--inventory-only')) return

  execFileSync('deno', ['check', ...entrypoints.map(relative)], { cwd: ROOT, stdio: 'inherit' })
  const liveTests = tests.filter(file => readFileSync(file, 'utf8').includes("Deno.env.get('SUPABASE_DB_URL')"))
  const unitEnvironment = { ...process.env }
  delete unitEnvironment.SUPABASE_DB_URL
  const argumentsFor = files => ['test', '--allow-env', '--allow-net', '--allow-read',
    ...(process.env.SUPABASE_DB_URL ? ['--allow-run=psql'] : []), ...files.map(relative)]
  execFileSync('deno', argumentsFor(tests.filter(file => !liveTests.includes(file))), { cwd: ROOT, env: unitEnvironment, stdio: 'inherit' })
  for (const file of liveTests) execFileSync('deno', argumentsFor([file]), { cwd: ROOT, stdio: 'inherit' })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
