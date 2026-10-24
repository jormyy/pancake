import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { apiUrl, digest, home, json, localUrl, lock, readJson, repo, run } from './common.mjs'

async function sourceFiles() {
  return [...new Set((await run('git', ['ls-files', '-c', '--others', '--exclude-standard', '-z'])).split('\0'))].filter(file => file && !file.split('/').some(part => part.startsWith('.env') || ['.git', '.temp'].includes(part))).sort()
}

function measuredSource(file) {
  return !file.startsWith('scripts/ios-sim/') && !file.startsWith('tests/ios-sim/') && file !== 'docs/ios-simulator-testing.md'
}

async function sourceFingerprint() {
  const fingerprint = []
  for (const file of await sourceFiles()) {
    const contents = await readFile(path.join(repo, file)).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (contents !== null && measuredSource(file)) fingerprint.push(`${file}:${digest(contents)}`)
  }
  return digest(fingerprint.join('\n'))
}

export async function sourceSnapshot(action = source => source) {
  return lock(path.join(home, 'build.lock'), async () => {
    const snapshot = path.join(home, 'source')
    await mkdir(snapshot, { recursive: true })
    const files = await sourceFiles()
    const fingerprint = []
    const previous = await readJson(path.join(home, 'source-files.json')) ?? []
    for (const file of files) {
      const target = path.join(snapshot, file)
      await mkdir(path.dirname(target), { recursive: true })
      const contents = await readFile(path.join(repo, file)).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
      if (contents === null) { await rm(target, { force: true }); continue }
      if (measuredSource(file)) fingerprint.push(`${file}:${digest(contents)}`)
      await writeFile(target, contents)
    }
    for (const file of previous) if (!files.includes(file)) await rm(path.join(snapshot, file), { force: true })
    await json(path.join(home, 'source-files.json'), files)
    const packageHash = digest(await readFile(path.join(snapshot, 'package-lock.json')))
    if ((await readJson(path.join(home, 'installed.json')))?.hash !== packageHash) {
      process.stdout.write('Installing the existing development dependencies in the external build copy.\n')
      await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: snapshot })
      await json(path.join(home, 'installed.json'), { hash: packageHash })
    }
    return action({ snapshot, hash: digest(fingerprint.join('\n')) })
  })
}

export async function exportWeb(stack, force = false) {
  assert.equal(stack.url, apiUrl)
  return sourceSnapshot(async source => {
    const hash = digest(`isolated-cache-v3:${source.hash}:${stack.anonKey}`)
    const root = path.join(home, 'exports', force ? `${hash}-${randomUUID()}` : hash)
    if (force || !(await readJson(path.join(root, 'ios-build.json')))) {
      process.stdout.write('Exporting the current worktree for the local stack.\n')
      const cache = path.join(home, 'metro-cache')
      await mkdir(cache, { recursive: true })
      await run('node', ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear', '--output-dir', root], {
        cwd: source.snapshot,
        env: { ...process.env, TMPDIR: cache, CI: '1', EXPO_NO_DOTENV: '1', EXPO_PUBLIC_SUPABASE_URL: stack.url, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.anonKey, EXPO_PUBLIC_API_URL: `${stack.url}/functions/v1/api` },
      })
      const scriptRoot = path.join(root, '_expo/static/js/web')
      const scripts = (await Promise.all((await readdir(scriptRoot)).filter(file => file.endsWith('.js')).map(file => readFile(path.join(scriptRoot, file), 'utf8')))).join('\n')
      assert.ok(scripts.includes(stack.url) && scripts.includes(stack.anonKey), 'Export does not contain the requested local stack values')
      await cp(path.join(source.snapshot, 'public'), root, { recursive: true })
      await json(path.join(root, 'ios-build.json'), { hash, source: source.hash, head: await run('git', ['rev-parse', 'HEAD']), stackUrl: stack.url })
    }
    return { ...source, sourceFingerprint: source.hash, root, hash }
  })
}

export async function verifyBuild(origin, build) {
  localUrl(origin)
  const response = await fetch(`${origin}/ios-build.json`, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
  assert.ok(response.ok, 'Served build fingerprint is missing')
  const served = await response.json()
  assert.equal(served.hash, build.hash, 'Served build fingerprint differs from the requested export')
  assert.equal(served.source, build.sourceFingerprint, 'Served source fingerprint differs from the requested export')
  assert.equal(served.stackUrl, apiUrl, 'Served build targets a different stack')
  assert.equal(served.source, await sourceFingerprint(), 'Served build does not match the requesting checkout')
  return served
}
