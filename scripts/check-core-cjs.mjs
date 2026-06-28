import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const CORE = path.join(ROOT, 'core')
const EXPECTED = path.join(CORE, 'cjs')

async function listFiles(dir, prefix = '') {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const rel = path.join(prefix, entry.name)
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(full, rel))
    else files.push(rel)
  }
  return files.sort()
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'pancake-core-cjs-'))
  const tempOut = path.join(tempRoot, 'cjs')
  const tempConfig = path.join(tempRoot, 'tsconfig.cjs-check.json')

  try {
    await writeFile(tempConfig, JSON.stringify({
      extends: path.join(CORE, 'tsconfig.json'),
      compilerOptions: {
        module: 'CommonJS',
        moduleResolution: 'Node',
        declaration: false,
        declarationMap: false,
        outDir: tempOut,
      },
      exclude: ['node_modules', 'dist', 'cjs', 'tests'],
    }, null, 2))

    const tsc = spawnSync('npx', ['tsc', '-p', tempConfig], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (tsc.status !== 0) {
      process.stderr.write(tsc.stderr || tsc.stdout)
      process.exitCode = tsc.status ?? 1
      return
    }

    const expectedFiles = await listFiles(EXPECTED)
    const actualFiles = await listFiles(tempOut)
    if (expectedFiles.join('\n') !== actualFiles.join('\n')) {
      console.error('core/cjs file list is out of date.')
      console.error('expected:\n' + expectedFiles.join('\n'))
      console.error('actual:\n' + actualFiles.join('\n'))
      process.exitCode = 1
      return
    }

    for (const rel of expectedFiles) {
      const expected = await readFile(path.join(EXPECTED, rel), 'utf8')
      const actual = await readFile(path.join(tempOut, rel), 'utf8')
      if (expected !== actual) {
        console.error(`core/cjs/${rel} is out of date. Run npm run build --workspace core.`)
        process.exitCode = 1
        return
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

await main()
