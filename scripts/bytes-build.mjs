import assert from 'node:assert/strict'
import { cp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { labRoot, requireMini } from './perf-lab/common.mjs'
import { localKeys } from './perf-lab/database.mjs'
import { measureExport } from './measure-web-bytes.mjs'
import { stampReleaseProvenance } from './stamp-release-provenance.mjs'

await requireMini()
const label = process.argv[2] ?? 'baseline'
assert.match(label, /^[a-z0-9-]+$/)
const previous = process.argv[3] ?? (label === 'baseline' ? '' : 'baseline')
if (previous) assert.match(previous, /^[a-z0-9-]+$/)
const keys = await localKeys()
const origin = /^site_url = "([^"]+)"/m.exec(await readFile('supabase/config.toml', 'utf8'))?.[1]
assert.ok(origin && new URL(origin).protocol === 'https:' && new URL(origin).port === '62084' && new URL(origin).hostname.endsWith('.local'))
const modules = path.join(labRoot, `${label}-modules.jsonl`)
const trace = process.env.PANCAKE_BYTES_TRACE !== '0'
await rm(modules, { force: true })
await rm(`${modules}.code`, { force: true })
const log = await open(path.join(labRoot, `${label}-build.log`), 'w')
try {
  await new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build:web:release'], {
      env: { ...process.env, EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', EXPO_OFFLINE: '1',
        VERCEL_ENV: 'development', PANCAKE_FETCH_PREDECESSOR: '0',
        PANCAKE_PREVIOUS_RELEASE_ROOT: previous ? path.join(labRoot, previous) : '',
        EXPO_PUBLIC_SUPABASE_URL: origin, EXPO_PUBLIC_API_URL: `${origin}/functions/v1/api`,
        EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: keys.ANON_KEY, EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH: '1', PANCAKE_BYTES_MODULES: trace ? modules : '' },
      stdio: ['ignore', log.fd, log.fd],
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Build failed (${code}); inspect ${label}-build.log`)))
  })
} finally { await log.close() }
const destination = path.join(labRoot, label)
await rm(destination, { recursive: true, force: true })
await cp('dist', destination, { recursive: true })
const report = await measureExport(destination, trace ? modules : undefined)
await writeFile(path.join(labRoot, `${label}-bytes.json`), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ label, routes: report.routes.length, common: report.bundles[0]?.raw, precache: report.precacheTotal }))
const nextSha = createHash('sha1').update(`${label}:next-release`).digest('hex')
await rm('dist/release-compatibility.json', { force: true })
await stampReleaseProvenance({ commitSha: nextSha, previousRelease: destination })
const next = path.join(labRoot, `${label}-next`)
await rm(next, { recursive: true, force: true })
await cp('dist', next, { recursive: true })
