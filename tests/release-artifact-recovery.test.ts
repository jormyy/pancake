import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { createReleaseArtifactManifest, recoverReleaseArtifact } from './e2e/release-artifact.mjs'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from './e2e/release-provenance.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const fixture = async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'pancake-recover-'))
  roots.push(parent)
  const source = path.join(parent, 'source')
  await mkdir(path.join(source, 'dist/assets'), { recursive: true })
  await writeFile(path.join(source, 'dist/index.html'), '<script src="/assets/app.js"></script>\n')
  await writeFile(path.join(source, 'dist/assets/app.js'), 'globalThis.fixture = 1\n')
  for (const name of FRONTEND_DEPLOYMENT_INPUTS) await writeFile(path.join(source, name), `{ "fixture": "${name}" }\n`)
  const expectedCommitSha = 'a'.repeat(40)
  const expectedBundleDigest = await digestReleaseBundle(source)
  const marker = { commitSha: expectedCommitSha, bundleDigest: expectedBundleDigest, artifact: await createReleaseArtifactManifest(source) }
  const fetchImpl = vi.fn(async (url: URL) => {
    const name = decodeURIComponent(url.pathname.slice(1))
    if (name === 'release-provenance.json') return new Response(JSON.stringify(marker))
    try { return new Response(await readFile(path.join(source, 'dist', name))) }
    catch { return new Response('missing', { status: 404 }) }
  })
  return { source, marker, fetchImpl, options: { root: path.join(parent, 'recovered'), url: 'http://127.0.0.1:9999', expectedCommitSha, expectedBundleDigest, fetchImpl } }
}

it('recovers every deployed byte and original input under the unchanged complete digest', async () => {
  const { source, options, marker } = await fixture()
  expect(await recoverReleaseArtifact(options)).toEqual({ commitSha: options.expectedCommitSha, bundleDigest: options.expectedBundleDigest, files: 2, complete: true })
  for (const file of marker.artifact.files) expect(await readFile(path.join(options.root, 'dist', file.path))).toEqual(await readFile(path.join(source, 'dist', file.path)))
  for (const name of FRONTEND_DEPLOYMENT_INPUTS) expect(await readFile(path.join(options.root, name))).toEqual(await readFile(path.join(source, name)))
  expect(await digestReleaseBundle(options.root)).toBe(options.expectedBundleDigest)
})

it.each(['altered bytes', 'missing file', 'omitted manifest member', 'unexpected member', 'changed input'])(
  'rejects %s while the expected published digest stays fixed', async (change) => {
    const { source, options, marker } = await fixture()
    let error = 'Complete recovered artifact digest does not match production'
    if (change === 'altered bytes') {
      await writeFile(path.join(source, 'dist/assets/app.js'), 'globalThis.fixture = 2\n')
      error = 'Published artifact bytes do not match: assets/app.js'
    } else if (change === 'missing file') {
      await rm(path.join(source, 'dist/assets/app.js'))
      error = 'Artifact read failed for assets/app.js: HTTP 404'
    } else if (change === 'omitted manifest member') marker.artifact.files.shift()
    else if (change === 'unexpected member') {
      const bytes = Buffer.from('unexpected')
      await writeFile(path.join(source, 'dist/z.js'), bytes)
      marker.artifact.files.push({ path: 'z.js', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    } else marker.artifact.inputs[0].contentBase64 = Buffer.from('{"changed":true}').toString('base64')
    await expect(recoverReleaseArtifact(options)).rejects.toThrow(error)
  },
)

it.each(['duplicate', 'reordered', 'traversal', 'extra input'])('rejects an invalid %s manifest before fetching output', async (change) => {
  const { options, marker, fetchImpl } = await fixture()
  if (change === 'duplicate') marker.artifact.files.push(marker.artifact.files[0])
  if (change === 'reordered') marker.artifact.files.reverse()
  if (change === 'traversal') marker.artifact.files[0].path = '../escape'
  if (change === 'extra input') marker.artifact.inputs.push({ path: '.env', contentBase64: '' })
  await expect(recoverReleaseArtifact(options)).rejects.toThrow(change === 'extra input' ? 'exact four-file contract' : 'file manifest is invalid')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('rejects the wrong expected source before downloading output', async () => {
  const { options, fetchImpl } = await fixture()
  await expect(recoverReleaseArtifact({ ...options, expectedCommitSha: 'b'.repeat(40) })).rejects.toThrow('expected source and digest')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('rejects the wrong expected digest before downloading output', async () => {
  const { options, fetchImpl } = await fixture()
  await expect(recoverReleaseArtifact({ ...options, expectedBundleDigest: 'b'.repeat(64) })).rejects.toThrow('expected source and digest')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('rejects a marker without an artifact manifest before downloading output', async () => {
  const { options, marker } = await fixture()
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ commitSha: marker.commitSha, bundleDigest: marker.bundleDigest })))
  await expect(recoverReleaseArtifact({ ...options, fetchImpl })).rejects.toThrow('no complete artifact manifest')
  expect(fetchImpl).toHaveBeenCalledTimes(1)
})

it('rejects a deployment change during recovery', async () => {
  const { options, marker, fetchImpl } = await fixture()
  const original = fetchImpl.getMockImplementation()!
  let markers = 0
  fetchImpl.mockImplementation(async (url) => {
    if (url.pathname === '/release-provenance.json' && ++markers === 2) return new Response(JSON.stringify({ ...marker, commitSha: 'b'.repeat(40) }))
    return original(url)
  })
  await expect(recoverReleaseArtifact(options)).rejects.toThrow('changes during recovery')
})

it('rejects redirects and preserves an existing recovery directory', async () => {
  const { options } = await fixture()
  const redirected = new Response('elsewhere')
  Object.defineProperty(redirected, 'redirected', { value: true })
  await expect(recoverReleaseArtifact({ ...options, fetchImpl: async () => redirected })).rejects.toThrow('Artifact read failed')
  await mkdir(options.root)
  await writeFile(path.join(options.root, 'keep'), 'original')
  await expect(recoverReleaseArtifact(options)).rejects.toThrow('EEXIST')
  expect(await readFile(path.join(options.root, 'keep'), 'utf8')).toBe('original')
})

it('refuses symlinked build outputs instead of omitting them from the manifest', async () => {
  const { source } = await fixture()
  await symlink('../package.json', path.join(source, 'dist/link.json'))
  await expect(createReleaseArtifactManifest(source)).rejects.toThrow('non-regular file')
})
