import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const provenanceCache = new Map()

/** @typedef {{ commitSha: string, runId: string, bundleDigest: string }} ReleaseProvenance */

const listFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? listFiles(entryPath) : [entryPath]
  }))
  return files.flat().sort()
}

const repositoryCommit = (root) => {
  const fromEnvironment = process.env.GITHUB_SHA
  const commit = fromEnvironment || execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  if (!/^[a-f0-9]{40}$/i.test(commit)) throw new Error('Release provenance requires a full commit SHA')
  return commit.toLowerCase()
}

const digestBundle = async (root) => {
  const distRoot = path.join(root, 'dist')
  const files = await listFiles(distRoot).catch((error) => {
    throw new Error(`Release provenance could not read production bundle: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (files.length === 0) throw new Error('Release provenance requires a non-empty production bundle')
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(distRoot, file))
    hash.update('\0')
    hash.update(await readFile(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

export const resolveReleaseProvenance = async ({ root = process.cwd() } = {}) => {
  let pending = provenanceCache.get(root)
  if (!pending) {
    pending = (async () => {
      const commitSha = repositoryCommit(root)
      const bundleDigest = await digestBundle(root)
      return {
        commitSha,
        bundleDigest,
        runId: process.env.GITHUB_RUN_ID || process.env.E2E_RELEASE_RUN_ID ||
          `local-${commitSha.slice(0, 12)}-${bundleDigest.slice(0, 12)}`,
      }
    })()
    provenanceCache.set(root, pending)
  }
  return pending
}

/** @param {unknown} report @param {ReleaseProvenance | undefined} expected @param {string} label */
export const validateReleaseProvenance = (report, expected, label) => {
  if (!expected) return []
  const actual = report && typeof report === 'object' ? Reflect.get(report, 'provenance') : null
  if (!actual || typeof actual !== 'object') return [`${label} is missing release provenance`]
  return ['commitSha', 'runId', 'bundleDigest'].flatMap((field) => (
    Reflect.get(actual, field) === expected[field]
      ? []
      : [`${label} provenance ${field} ${Reflect.get(actual, field) ?? 'missing'} does not match ${expected[field]}`]
  ))
}
