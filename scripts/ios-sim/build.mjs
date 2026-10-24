import assert from 'node:assert/strict'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { apiUrl, digest, home, json, lock, readJson, repo, run } from './common.mjs'

export async function sourceSnapshot() {
  return lock(path.join(home, 'build.lock'), async () => {
    const snapshot = path.join(home, 'source')
    await mkdir(snapshot, { recursive: true })
    const files = (await run('git', ['ls-files', '-c', '--others', '--exclude-standard', '-z'])).split('\0').filter(file => file && !file.split('/').some(part => part.startsWith('.env') || ['.git', '.temp'].includes(part)))
    const fingerprint = []
    const previous = await readJson(path.join(home, 'source-files.json')) ?? []
    for (const file of files) {
      const target = path.join(snapshot, file)
      await mkdir(path.dirname(target), { recursive: true })
      const contents = await readFile(path.join(repo, file))
      if (!file.startsWith('scripts/ios-sim/') && !file.startsWith('tests/ios-sim/') && file !== 'docs/ios-simulator-testing.md') fingerprint.push(`${file}:${digest(contents)}`)
      await writeFile(target, contents)
    }
    const { rm } = await import('node:fs/promises')
    for (const file of previous) if (!files.includes(file)) await rm(path.join(snapshot, file), { force: true })
    await json(path.join(home, 'source-files.json'), files)
    const packageHash = digest(await readFile(path.join(snapshot, 'package-lock.json')))
    if ((await readJson(path.join(home, 'installed.json')))?.hash !== packageHash) {
      process.stdout.write('Installing the existing development dependencies in the external build copy.\n')
      await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: snapshot })
      await json(path.join(home, 'installed.json'), { hash: packageHash })
    }
    return { snapshot, hash: digest(fingerprint.join('\n')) }
  })
}

export async function exportWeb(stack, force = false) {
  assert.equal(stack.url, apiUrl)
  const source = await sourceSnapshot()
  return lock(path.join(home, 'export.lock'), async () => {
    const hash = digest(`isolated-cache-v2:${source.hash}:${stack.anonKey}`)
    const root = path.join(home, 'exports', hash)
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
    return { ...source, root, hash }
  })
}
