import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from './release-provenance.mjs'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const markerName = 'release-provenance.json'
const safePath = (value) => typeof value === 'string' && value.length > 0 &&
  !value.includes('\\') && !value.includes('\0') &&
  value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

const outputFiles = async (root, relative = '') => {
  const files = []
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await outputFiles(root, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Release artifact contains a non-regular file: ${name}`)
  }
  return files.sort()
}

export const createReleaseArtifactManifest = async (root) => {
  const files = []
  for (const name of (await outputFiles(path.join(root, 'dist'))).filter((name) => name !== markerName)) {
    if (!safePath(name)) throw new Error('Release artifact contains an unsafe path')
    const bytes = await readFile(path.join(root, 'dist', name))
    files.push({ path: name, bytes: bytes.length, sha256: hash(bytes) })
  }
  if (files.length === 0) throw new Error('Release artifact requires output files')
  const inputs = await Promise.all(FRONTEND_DEPLOYMENT_INPUTS.map(async (name) => ({
    path: name,
    contentBase64: (await readFile(path.join(root, name))).toString('base64'),
  })))
  return { version: 1, files, inputs }
}

const validateManifest = (manifest) => {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Release marker has no complete artifact manifest')
  }
  let previous = ''
  for (const file of manifest.files) {
    if (!safePath(file.path) || file.path === markerName || file.path <= previous ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Release artifact file manifest is invalid, duplicated or reordered')
    }
    previous = file.path
  }
  if (!Array.isArray(manifest.inputs) ||
      JSON.stringify(manifest.inputs.map((input) => input.path)) !== JSON.stringify(FRONTEND_DEPLOYMENT_INPUTS)) {
    throw new Error('Release artifact deployment inputs do not match the exact four-file contract')
  }
  for (const input of manifest.inputs) {
    if (typeof input.contentBase64 !== 'string' ||
        Buffer.from(input.contentBase64, 'base64').toString('base64') !== input.contentBase64) {
      throw new Error('Release artifact deployment input encoding is invalid')
    }
  }
}

/**
 * @param {{ url: string, root: string, expectedCommitSha: string, expectedBundleDigest: string,
 *   fetchImpl?: (url: URL, init: RequestInit) => Promise<Response> }} options
 */
export const recoverReleaseArtifact = async ({
  url, root, expectedCommitSha, expectedBundleDigest, fetchImpl = fetch,
}) => {
  if (!/^[a-f0-9]{40}$/.test(expectedCommitSha) || !/^[a-f0-9]{64}$/.test(expectedBundleDigest)) {
    throw new Error('Artifact recovery requires an exact expected source and digest')
  }
  const base = new URL(url)
  if (base.username || base.password || base.search || base.hash ||
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('Artifact recovery requires HTTPS or an isolated loopback server')
  }
  base.pathname = `${base.pathname.replace(/\/$/, '')}/`
  const get = async (name) => {
    const target = new URL(name.split('/').map(encodeURIComponent).join('/'), base)
    const response = await fetchImpl(target, {
      redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok || response.redirected) throw new Error(`Artifact read failed for ${name}: HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  }
  const before = await get(markerName)
  const marker = JSON.parse(before.toString('utf8'))
  if (marker.commitSha !== expectedCommitSha || marker.bundleDigest !== expectedBundleDigest) {
    throw new Error('Published artifact does not match the expected source and digest')
  }
  validateManifest(marker.artifact)
  await mkdir(root)
  await mkdir(path.join(root, 'dist'))
  for (const file of marker.artifact.files) {
    const bytes = await get(file.path)
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) {
      throw new Error(`Published artifact bytes do not match: ${file.path}`)
    }
    await mkdir(path.dirname(path.join(root, 'dist', file.path)), { recursive: true })
    await writeFile(path.join(root, 'dist', file.path), bytes, { flag: 'wx' })
  }
  for (const input of marker.artifact.inputs) {
    await writeFile(path.join(root, input.path), Buffer.from(input.contentBase64, 'base64'), { flag: 'wx' })
  }
  await writeFile(path.join(root, 'dist', markerName), before, { flag: 'wx' })
  const actual = await digestReleaseBundle(root)
  if (actual !== expectedBundleDigest) throw new Error('Complete recovered artifact digest does not match production')
  if (!(await get(markerName)).equals(before)) throw new Error('Published artifact changes during recovery')
  return { commitSha: marker.commitSha, bundleDigest: actual, files: marker.artifact.files.length, complete: true }
}
