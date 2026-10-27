import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const execute = promisify(execFile)
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const fullSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
export const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
export const readJson = async file => JSON.parse(await readFile(file, 'utf8'))
export async function saveJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(`${file}.partial`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(`${file}.partial`, file)
}

export function cliEnvironment(environment) {
  const result = { ...environment }
  for (const name of ['SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN']) delete result[name]
  return result
}

export async function command(bin, args, cwd) {
  const { stdout, stderr } = await execute(bin, args, {
    cwd, env: cliEnvironment(process.env), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30 * 60 * 1000,
  })
  return { stdout, stderr }
}

export function guardedCommand(dryRun, execute = command) {
  return async (bin, args, cwd) => {
    if (dryRun) {
      const localGit = bin === 'git' && ['rev-parse', 'branch', 'merge-base', 'status', 'diff', 'ls-files', 'archive'].includes(args[0])
      const localDatabase = bin === 'supabase' && args[0] === 'db' && args.includes('--local') && !args.includes('--linked') && !args.includes('--db-url')
        && (['query', 'dump'].includes(args[1]) || (args[1] === 'push' && args.includes('--dry-run')))
      requireValue(localGit || localDatabase || (bin === 'deno' && args[0] === 'check') || (bin === 'tar' && args[0] === '-xf'), 'Command is forbidden in dry-run mode')
    }
    return execute(bin, args, cwd)
  }
}

export function validateConfig(config, dryRun) {
  const allowed = new Set(['frontendUrl', 'edgeUrl', 'expectedMain', 'replayReceipt', 'checksReceipt', 'recoverySql', 'releaseNotes', 'stackRoot', 'pullRequestReceipt', 'projectRef', 'pr', 'expectedBundleDigest', 'waitSeconds'])
  requireValue(Object.keys(config).every(key => allowed.has(key)), 'Unknown release configuration field')
  if (config.expectedBundleDigest !== undefined) requireValue(digest(config.expectedBundleDigest), 'expectedBundleDigest must be a SHA-256 digest')
  if (config.waitSeconds !== undefined) requireValue(Number.isInteger(config.waitSeconds) && config.waitSeconds > 0 && config.waitSeconds <= 3600, 'waitSeconds must be between 1 and 3600')
  for (const key of ['frontendUrl', 'edgeUrl']) {
    const url = new URL(config[key])
    requireValue(!url.username && !url.password && !url.search && !url.hash, `${key} must not contain credentials or query parameters`)
    requireValue(dryRun ? url.protocol === 'http:' && url.hostname === '127.0.0.1' : url.protocol === 'https:',
      dryRun ? `${key} must use http://127.0.0.1 in dry-run mode` : `${key} must use HTTPS`)
  }
  requireValue(fullSha(config.expectedMain), 'expectedMain must be a full SHA')
  for (const key of ['replayReceipt', 'checksReceipt', 'recoverySql', 'releaseNotes']) {
    requireValue(typeof config[key] === 'string' && config[key].length > 0, `Missing ${key}`)
  }
  if (dryRun) {
    requireValue(typeof config.stackRoot === 'string' && !!config.stackRoot, 'Dry runs require an isolated stackRoot')
    requireValue(typeof config.pullRequestReceipt === 'string', 'Dry runs require a pullRequestReceipt')
  } else {
    requireValue(/^[a-z]{20}$/.test(config.projectRef), 'projectRef must name the linked Supabase project')
    requireValue(Number.isSafeInteger(config.pr) && config.pr > 0, 'pr must name an existing pull request')
  }
}

export async function checkedFetch(ctx, url) {
  const target = new URL(url)
  if (ctx.dryRun) requireValue(target.protocol === 'http:' && target.hostname === '127.0.0.1', 'Dry-run network requests must stay on loopback')
  const response = await ctx.fetch(target, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) })
  return response
}

export async function marker(ctx, url, kind, expectedSha, expectedDigest) {
  const response = await checkedFetch(ctx, url)
  requireValue(response.ok, `${kind} identity returned HTTP ${response.status}`)
  const value = await response.json()
  requireValue(fullSha(value.commitSha) && digest(value[kind === 'Edge' ? 'edgeArtifactDigest' : 'bundleDigest']), `Invalid ${kind} identity`)
  if (kind === 'Edge') requireValue(value.ok === true, 'Edge health is not green')
  if (expectedSha) requireValue(value.commitSha === expectedSha, `${kind} commit does not match ${expectedSha}`)
  if (expectedDigest) requireValue(value[kind === 'Edge' ? 'edgeArtifactDigest' : 'bundleDigest'] === expectedDigest, `${kind} digest does not match`)
  return value
}

export async function sql(ctx, query) {
  const args = ['db', 'query', ctx.dryRun ? '--local' : '--linked', '--agent=no', '-o', 'json', query]
  const { stdout } = await ctx.run('supabase', args, ctx.databaseRoot)
  const result = JSON.parse(stdout)
  requireValue(Array.isArray(result), 'Unexpected Supabase query output')
  return result
}

export async function verifyFiles(root, files) {
  for (const [file, expected] of Object.entries(files)) {
    requireValue(!path.isAbsolute(file) && !file.split('/').includes('..'), 'Unsafe receipt file path')
    requireValue(sha256(await readFile(path.join(root, file))) === expected, `Backup changed: ${file}`)
  }
}

export async function nonempty(file) {
  requireValue((await stat(file)).size > 0, `Empty backup: ${file}`)
}
