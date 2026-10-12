import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { FRONTEND_DEPLOYMENT_INPUTS } from './release-provenance.mjs'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const filesBelow = async (root, prefix = '') => {
  const files = []
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await filesBelow(root, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Release contains a non-regular file: ${name}`)
  }
  return files.sort()
}

/** Verify the complete local export before using it as an update oracle. */
export const readPwaRelease = async (root) => {
  const marker = JSON.parse(await readFile(path.join(root, 'release-provenance.json'), 'utf8'))
  const manifest = marker.artifact
  if (!/^[a-f0-9]{40}$/.test(marker.commitSha) || !/^[a-f0-9]{64}$/.test(marker.bundleDigest) ||
      manifest?.version !== 1 || !Array.isArray(manifest.files) || !Array.isArray(manifest.inputs)) {
    throw new Error('PWA update requires a complete stamped production export')
  }
  const files = (await filesBelow(root)).filter((name) => name !== 'release-provenance.json')
  if (!files.length || JSON.stringify(files) !== JSON.stringify(manifest.files.map((file) => file.path)) ||
      JSON.stringify(manifest.inputs.map((input) => input.path)) !== JSON.stringify(FRONTEND_DEPLOYMENT_INPUTS)) {
    throw new Error('Release manifest does not match the complete export')
  }
  const digest = createHash('sha256')
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(root, file.path))
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`Release bytes differ from the manifest: ${file.path}`)
    }
    digest.update(`output:${file.path}\0`).update(bytes).update('\0')
  }
  for (const input of manifest.inputs) {
    const bytes = Buffer.from(input.contentBase64, 'base64')
    if (bytes.toString('base64') !== input.contentBase64) throw new Error('Invalid release input encoding')
    digest.update(`input:${input.path}\0`).update(bytes).update('\0')
  }
  if (digest.digest('hex') !== marker.bundleDigest) throw new Error('Release bundle digest differs from its manifest')
  const worker = await readFile(path.join(root, 'sw.js'), 'utf8')
  const version = /const VERSION = '([^']+)'/.exec(worker)?.[1]
  const declared = JSON.parse(/const PRECACHE_URLS = (\[[^\n]*\])/.exec(worker)?.[1] ?? 'null')
  const hashes = JSON.parse(/const PUBLIC_ASSET_HASHES = (\{[^\n]*\})/.exec(worker)?.[1] ?? 'null')
  if (!version?.startsWith(`pancake-${marker.commitSha.slice(0, 12)}-`) ||
      !Array.isArray(declared) || declared.length < 3 || !declared.includes('/') || !hashes) {
    throw new Error('Release has no stamped worker boot manifest')
  }
  const fileHashes = new Map(manifest.files.map((file) => [file.path, file.sha256]))
  const bootHashes = Object.fromEntries(declared.map((url) => {
    const expected = fileHashes.get(url === '/' ? 'index.html' : url.slice(1))
    if (!url.startsWith('/') || url.startsWith('//') || !expected || hashes[url] !== expected) {
      throw new Error(`Worker boot manifest differs from its export: ${url}`)
    }
    return [url, expected]
  }))
  return { root, commitSha: marker.commitSha, bundleDigest: marker.bundleDigest, version, bootHashes }
}
