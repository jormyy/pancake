import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { readPwaRelease } from '../tests/e2e/pwa-update-release.mjs'
import { recoverReleaseArtifact } from '../tests/e2e/release-artifact.mjs'

const receiptName = 'release-compatibility.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const readOptional = async file => readFile(file).catch(error => {
  if (error.code === 'ENOENT') return null
  throw error
})

const loaderReferences = bytes => {
  const source = bytes.toString('utf8')
  if (!Buffer.from(source).equals(bytes)) return null
  const parsed = ts.createSourceFile('loader.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (!('parseDiagnostics' in parsed) || !Array.isArray(parsed.parseDiagnostics) || parsed.parseDiagnostics.length) return null
  const references = []
  const replacements = []
  for (const statement of parsed.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue
    const call = statement.expression
    if (!ts.isIdentifier(call.expression) || call.expression.text !== '__d' || call.arguments.length !== 3) continue
    const dependencies = call.arguments[2]
    if (!ts.isObjectLiteralExpression(dependencies)) continue
    for (const property of dependencies.properties) {
      if (!ts.isPropertyAssignment(property) ||
          !(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) || property.name.text !== 'paths') continue
      if (!ts.isObjectLiteralExpression(property.initializer) || !property.initializer.properties.length) return null
      for (const entry of property.initializer.properties) {
        if (!ts.isPropertyAssignment(entry) ||
            !(ts.isStringLiteral(entry.name) || ts.isNumericLiteral(entry.name)) || !/^\d+$/.test(entry.name.text) ||
            !ts.isStringLiteral(entry.initializer)) return null
        const value = entry.initializer.text
        if (!/^\/_expo\/static\/js\/web\/[\w.-]+-[a-f0-9]{32}\.js$/.test(value)) return null
        references.push(value.slice(1))
        replacements.push([entry.initializer.getStart(parsed), entry.initializer.end])
      }
    }
  }
  if (!references.length) return null
  let normalized = source
  for (const [start, end] of replacements.reverse()) {
    normalized = `${normalized.slice(0, start)}"<release-asset>"${normalized.slice(end)}`
  }
  return { normalized, references }
}

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
  const changedLoaders = []
  for (const file of manifest.artifact.files) {
    if (!/^(?:assets|_expo\/static)\//.test(file.path) || inherited.has(file.path)) continue
    if (/^_expo\/static\/js\/web\/entry-[^.]+\.js$/.test(file.path) && !previous.bootHashes[`/${file.path}`]) continue
    const target = path.join(root, 'dist', file.path)
    const existing = await readOptional(target)
    if (existing) {
      if (hash(existing) !== file.sha256) {
        const before = file.path.endsWith('.js') && loaderReferences(await readFile(path.join(previousRoot, file.path)))
        const after = before && loaderReferences(existing)
        if (!after || before.normalized !== after.normalized) {
          throw new Error(`Immutable release asset changes at the same path: ${file.path}`)
        }
        changedLoaders.push({ file, before, after })
        continue
      }
      if (retained.has(file.path)) files.push(file)
      continue
    }
    const bytes = await readFile(path.join(previousRoot, file.path))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
    files.push(file)
  }
  const previousFiles = new Map(manifest.artifact.files.map(file => [file.path, file]))
  for (const { file, before, after } of changedLoaders) {
    for (const reference of new Set(before.references)) {
      const expected = previousFiles.get(reference)
      const bytes = await readOptional(path.join(root, 'dist', reference))
      if (!expected || !bytes || hash(bytes) !== expected.sha256) {
        throw new Error(`Immutable release asset changes at the same path: ${file.path}; old referenced asset is not retained: ${reference}`)
      }
    }
    for (const reference of new Set(after.references)) {
      if (!await readOptional(path.join(root, 'dist', reference))) {
        throw new Error(`Immutable release asset changes at the same path: ${file.path}; new referenced asset is missing: ${reference}`)
      }
    }
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
