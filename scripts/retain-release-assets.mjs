import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readPwaRelease } from '../tests/e2e/pwa-update-release.mjs'
import { recoverReleaseArtifact } from '../tests/e2e/release-artifact.mjs'

const receiptName = 'release-compatibility.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const readOptional = async file => readFile(file).catch(error => {
  if (error.code === 'ENOENT') return null
  throw error
})

export async function retainReleaseAssets(root, previousRoot) {
  const previous = await readPwaRelease(previousRoot)
  const manifest = JSON.parse(await readFile(path.join(previousRoot, 'release-provenance.json'), 'utf8'))
  const priorReceipt = await readOptional(path.join(previousRoot, receiptName))
  const inherited = new Set(priorReceipt ? JSON.parse(priorReceipt.toString('utf8')).files.map(file => file.path) : [])
  const existingReceipt = await readOptional(path.join(root, 'dist', receiptName))
  const recorded = existingReceipt ? JSON.parse(existingReceipt.toString('utf8')) : null
  if (recorded && (recorded.commitSha !== previous.commitSha || recorded.bundleDigest !== previous.bundleDigest)) {
    throw new Error('Changing the predecessor requires a clean release export')
  }
  const retained = new Set(recorded?.files.map(file => file.path) ?? [])
  const files = []
  for (const file of manifest.artifact.files) {
    if (!/^(?:assets|_expo\/static)\//.test(file.path) || inherited.has(file.path)) continue
    if (/^_expo\/static\/js\/web\/entry-[^.]+\.js$/.test(file.path) && !previous.bootHashes[`/${file.path}`]) continue
    const target = path.join(root, 'dist', file.path)
    const existing = await readOptional(target)
    if (existing) {
      if (hash(existing) !== file.sha256) throw new Error(`Immutable release asset changes at the same path: ${file.path}`)
      if (retained.has(file.path)) files.push(file)
      continue
    }
    const bytes = await readFile(path.join(previousRoot, file.path))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
    files.push(file)
  }
  const receipt = { version: 1, commitSha: previous.commitSha, bundleDigest: previous.bundleDigest, files }
  await writeFile(path.join(root, 'dist', receiptName), `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

export async function prepareReleaseCompatibility(root, previousRoot) {
  const localRoot = previousRoot || process.env.PANCAKE_PREVIOUS_RELEASE_ROOT
  if (localRoot) return retainReleaseAssets(root, localRoot)
  if (process.env.VERCEL_ENV !== 'production' && process.env.PANCAKE_FETCH_PREDECESSOR !== '1') return null
  const descriptor = await readOptional(path.join(root, 'release-predecessor.json'))
  if (!descriptor) {
    if (process.env.VERCEL_ENV === 'production') throw new Error('Production build requires a pinned release-predecessor.json')
    return null
  }
  const { url, commitSha, bundleDigest } = JSON.parse(descriptor.toString('utf8'))
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pancake-release-'))
  try {
    const recovered = path.join(directory, 'previous')
    await recoverReleaseArtifact({ url, root: recovered, expectedCommitSha: commitSha, expectedBundleDigest: bundleDigest })
    return await retainReleaseAssets(root, path.join(recovered, 'dist'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
