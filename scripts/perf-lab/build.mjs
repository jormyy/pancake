import assert from 'node:assert/strict'
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { labRoot, ports, sourceRoot, digest, json, requireMini } from './common.mjs'
import { command } from './process.mjs'
import { pageObserverSource, workerObserverSource } from './observer.mjs'
import { stampReleaseProvenance } from '../stamp-release-provenance.mjs'
import { createReleaseArtifactManifest } from '../../tests/e2e/release-artifact.mjs'
import { digestReleaseBundle, FRONTEND_DEPLOYMENT_INPUTS } from '../../tests/e2e/release-provenance.mjs'

async function filesUnder(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : path.join(directory, entry.name)))).flat()
}

export async function ensureMkcert() {
  const binary = path.join(labRoot, 'bin/mkcert')
  const expected = 'c8af0df44bce04359794dad8ea28d750437411d632748049d08644ffb66a60c6'
  let bytes = await readFile(binary).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
  if (!bytes) {
    const response = await fetch('https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-darwin-arm64', { signal: AbortSignal.timeout(60000) })
    assert.ok(response.ok, 'The pinned mkcert binary is unavailable')
    bytes = Buffer.from(await response.arrayBuffer())
    assert.equal(digest(bytes), expected, 'The mkcert download differs from the pinned binary')
    await mkdir(path.dirname(binary), { recursive: true })
    await writeFile(binary, bytes, { mode: 0o700 })
  }
  assert.equal(digest(bytes), expected, 'The local mkcert binary differs from the pinned binary')
  await chmod(binary, 0o700)
  return binary
}

export async function certificate() {
  await requireMini()
  const hostname = (await command('scutil', ['--get', 'LocalHostName'])).stdout.trim().toLowerCase() + '.local'
  const addresses = Object.entries(networkInterfaces()).filter(([name]) => name.startsWith('en')).flatMap(([, entries]) => entries.filter(entry => !entry.internal && entry.family === 'IPv4' && !entry.address.startsWith('169.254.')).map(entry => entry.address))
  assert.ok(addresses.length, 'The mini has no LAN IPv4 address')
  const directory = path.join(labRoot, 'certs')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const key = path.join(directory, 'server-key.pem'), cert = path.join(directory, 'server.pem')
  if (process.env.PERF_LAB_TLS_SELF_SIGNED === '1') {
    await command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${hostname}`])
    await cp(cert, path.join(directory, 'rootCA.pem'))
  } else {
    const binary = await ensureMkcert()
    await command(binary, ['-cert-file', cert, '-key-file', key, hostname, ...addresses, 'localhost', '127.0.0.1'], { env: { ...process.env, CAROOT: directory } })
  }
  const result = { hostname, addresses, key, cert, ca: path.join(directory, 'rootCA.pem'), origin: `https://${hostname}:${ports.https}` }
  await json(path.join(labRoot, 'evidence/https.json'), { hostname, addresses, origin: result.origin, ca: 'certs/rootCA.pem' })
  return result
}

async function bootstrapPredecessor(commitSha) {
  const root = path.join(sourceRoot, 'dist')
  const html = await readFile(path.join(root, 'index.html'), 'utf8')
  const boot = ['/', ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]), ...[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(match => match[1])].filter(url => url.startsWith('/') && !url.startsWith('//'))
  assert.ok(boot.length >= 3, 'Local bootstrap has too few boot assets')
  const hashes = Object.fromEntries(await Promise.all(boot.map(async url => [url, digest(await readFile(path.join(root, url === '/' ? 'index.html' : url)))])))
  const worker = (await readFile(path.join(root, 'sw.js'), 'utf8')).replace(/const VERSION = '[^']*'/, `const VERSION = 'pancake-${commitSha.slice(0, 12)}-local-bootstrap'`)
    .replace(/const PRECACHE_URLS = \[[^\]]*\]/, `const PRECACHE_URLS = ${JSON.stringify(boot)}`)
    .replace(/const PUBLIC_ASSET_HASHES = \{[^\n]*\}/, `const PUBLIC_ASSET_HASHES = ${JSON.stringify(hashes)}`)
  await writeFile(path.join(root, 'sw.js'), worker)
  await json(path.join(root, 'release-provenance.json'), { commitSha, bundleDigest: await digestReleaseBundle(sourceRoot), deploymentInputs: FRONTEND_DEPLOYMENT_INPUTS, artifact: await createReleaseArtifactManifest(sourceRoot) })
  const previous = path.join(labRoot, 'previous-export')
  await rm(previous, { recursive: true, force: true })
  await cp(root, previous, { recursive: true, force: true })
  return previous
}

export async function buildWeb(keys, tls) {
  await requireMini()
  const commitSha = (await command('git', ['rev-parse', 'HEAD'])).stdout.trim()
  const env = { ...process.env, VERCEL_ENV: 'development', PANCAKE_FETCH_PREDECESSOR: '0', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', CI: '1',
    EXPO_PUBLIC_SUPABASE_URL: tls.origin, EXPO_PUBLIC_API_URL: `${tls.origin}/functions/v1/api`, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY,
    TMPDIR: path.join(labRoot, 'build-cache') }
  await mkdir(env.TMPDIR, { recursive: true })
  await rm(path.join(sourceRoot, 'dist'), { recursive: true, force: true })
  await command('node', ['node_modules/expo/bin/cli', 'export', '--platform', 'web', '--clear'], { env, timeout: 240000 })
  const previous = await bootstrapPredecessor(commitSha)
  const files = await filesUnder(path.join(sourceRoot, 'dist'))
  const observer = `/assets/perf-lab.${digest(pageObserverSource)}.js`
  await mkdir(path.join(sourceRoot, 'dist/assets'), { recursive: true })
  await writeFile(path.join(sourceRoot, 'dist', observer), pageObserverSource)
  for (const file of files.filter(file => file.endsWith('.html'))) await writeFile(file, (await readFile(file, 'utf8')).replace('<head>', `<head><script src="${observer}"></script>`))
  const worker = path.join(sourceRoot, 'dist/sw.js')
  await writeFile(worker, `${workerObserverSource}\n${await readFile(worker, 'utf8')}`)
  await cp(tls.ca, path.join(sourceRoot, 'dist/lab-ca.pem'))
  const previousEnv = process.env.PANCAKE_PREVIOUS_RELEASE_ROOT
  process.env.PANCAKE_PREVIOUS_RELEASE_ROOT = previous
  try { await stampReleaseProvenance({ root: sourceRoot, commitSha, previousRelease: previous }) }
  finally { if (previousEnv === undefined) delete process.env.PANCAKE_PREVIOUS_RELEASE_ROOT; else process.env.PANCAKE_PREVIOUS_RELEASE_ROOT = previousEnv }
  const root = path.join(labRoot, 'web-export')
  await rm(root, { recursive: true, force: true })
  await cp(path.join(sourceRoot, 'dist'), root, { recursive: true, force: true })
  return { root, commitSha, origin: tls.origin, previous }
}
