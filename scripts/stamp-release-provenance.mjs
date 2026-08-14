import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from '../tests/e2e/release-provenance.mjs'

const fullSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value)

const repositoryCommit = (root) => execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim()

const SERVICE_WORKER_VERSION = /const VERSION = '[^']*'/

// The service worker keys its caches on VERSION and deletes every cache that does
// not start with it. Left as a hand-edited literal it never changes, so old
// hashed assets accumulate across deploys forever. Stamp it from the release
// commit, and fail closed if the declaration is ever renamed away.
const stampServiceWorkerVersion = async (root, commitSha) => {
  const workerPath = path.join(root, 'dist', 'sw.js')
  let source
  try {
    source = await readFile(workerPath, 'utf8')
  } catch {
    return
  }
  if (!SERVICE_WORKER_VERSION.test(source)) {
    throw new Error('Service worker is missing its VERSION declaration; cache versioning would silently stop working')
  }
  await writeFile(
    workerPath,
    source.replace(SERVICE_WORKER_VERSION, `const VERSION = 'pancake-${commitSha.slice(0, 12)}'`),
  )
}

export const stampReleaseProvenance = async ({
  root = process.cwd(),
  commitSha = process.env.E2E_EXPECTED_RELEASE_SHA || process.env.PANCAKE_RELEASE_SHA ||
    process.env.E2E_RELEASE_SHA || process.env.GITHUB_SHA || repositoryCommit(root),
} = {}) => {
  if (!fullSha(commitSha)) throw new Error('Release marker requires a full commit SHA')
  // Must run before the digest so the shipped worker is what gets hashed.
  await stampServiceWorkerVersion(root, commitSha)
  const marker = {
    commitSha: commitSha.toLowerCase(),
    bundleDigest: await digestReleaseBundle(root),
    deploymentInputs: FRONTEND_DEPLOYMENT_INPUTS,
  }
  await writeFile(path.join(root, 'dist', 'release-provenance.json'), `${JSON.stringify(marker, null, 2)}\n`)
  return marker
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const marker = await stampReleaseProvenance()
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `bundle_digest=${marker.bundleDigest}\n`)
  }
  console.log(JSON.stringify(marker))
}
