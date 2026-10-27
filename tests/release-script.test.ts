import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parseArgs, release, runSteps, STEP_ORDER } from '../scripts/release/release.mjs'
import { changedFunctions, configuredFunctions } from '../scripts/release/steps/changed-functions.mjs'
import { validateReplay } from '../scripts/release/steps/preflight.mjs'
import { checkedFetch, cliEnvironment, guardedCommand, sha256, validateConfig } from '../scripts/release/steps/runtime.mjs'
import { databasePlan, databasePush, merge, smoke, validatePullRequest, verifyProgress } from '../scripts/release/steps/rollout.mjs'

const candidate = 'a'.repeat(40)
const main = 'b'.repeat(40)
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const temporary = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-script-'))
  roots.push(root)
  return root
}
const config = () => ({
  frontendUrl: 'http://127.0.0.1:59480', edgeUrl: 'http://127.0.0.1:59421/functions/v1/api',
  expectedMain: main, replayReceipt: 'replay.json', checksReceipt: 'checks.json', releaseNotes: 'notes.md',
  recoverySql: 'recovery.sql', stackRoot: 'stack', pullRequestReceipt: 'pr.json',
})
const passingReplay = () => ({ candidate, passed: true, complete: true, invariantFailures: 0, lateStart: { passed: true, gaps: new Array<string>() } })
const pr = () => ({ headRefOid: candidate, baseRefOid: main, baseRefName: 'main', state: 'OPEN' })

type PipelineState = { completed: Record<string, unknown>; active?: string | null; failure?: { step: string } }
const state = (): PipelineState => ({ completed: {} })
const pipeline = (calls: string[]) => Object.fromEntries(STEP_ORDER.map(name => [name, async () => { calls.push(name); return { checked: true } }]))

it('runs every step in release order and persists intent before each step', async () => {
  const calls: string[] = []
  const snapshots: PipelineState[] = []
  await runSteps(state(), pipeline(calls), async (value: PipelineState) => { snapshots.push(structuredClone(value)) })
  expect(calls).toEqual(['preflight', 'backup', 'edge-deploy', 'db-dry-run', 'db-push', 'merge', 'wait-vercel', 'verify-provenance', 'edge-restamp', 'smoke', 'receipt'])
  for (const [index, name] of calls.entries()) {
    expect(snapshots[index * 2].active).toBe(name)
    expect(snapshots[index * 2].completed[name]).toBeUndefined()
    expect(snapshots[index * 2 + 1].completed[name]).toEqual({ checked: true })
  }
})

it.each(STEP_ORDER)('resumes a failure at %s without repeating earlier writes', async failed => {
  const current = state()
  const calls: string[] = []
  const steps = pipeline(calls)
  steps[failed] = async () => { throw new Error('injected failure') }
  const persist = vi.fn(async () => {})
  await expect(runSteps(current, steps, persist)).rejects.toThrow('injected failure')
  expect(current.failure?.step).toBe(failed)
  expect(current.completed[failed]).toBeUndefined()
  const resumed: string[] = []
  const verified: string[] = []
  await runSteps(current, pipeline(resumed), persist, async (name: string) => { verified.push(name) })
  expect(verified).toEqual(STEP_ORDER.slice(0, STEP_ORDER.indexOf(failed)))
  expect(resumed).toEqual(STEP_ORDER.slice(STEP_ORDER.indexOf(failed)))
  expect(current.failure).toBeUndefined()
})

it('rejects gaps in saved progress before any step runs', async () => {
  const calls: string[] = []
  await expect(runSteps({ completed: { backup: {} } }, pipeline(calls), async () => {})).rejects.toThrow('out-of-order')
  expect(calls).toEqual([])
})

const sourceFixture = {
  'supabase/functions/api/index.ts': "export * from './router.ts'",
  'supabase/functions/api/router.ts': "import '../_shared/indirect.ts'",
  'supabase/functions/worker/index.ts': "const helper = import('../_shared/common.ts')",
  'supabase/functions/untouched/index.ts': "import '../_shared/other.ts'",
  'supabase/functions/_shared/indirect.ts': "export * from './common.ts'",
  'supabase/functions/_shared/common.ts': "import './indirect.ts'; export const shared = 1",
  'supabase/functions/_shared/other.ts': 'export const other = 1',
}
const names = ['api', 'worker', 'untouched']
it('finds direct, transitive, reexported and dynamic shared importers with cycles', () => {
  expect(changedFunctions(['supabase/functions/_shared/common.ts'], sourceFixture, names)).toEqual(['api', 'worker'])
})
it('keeps direct function changes and ignores unrelated shared files', () => {
  expect(changedFunctions(['supabase/functions/worker/removed.ts', 'supabase/functions/_shared/unused.ts'], sourceFixture, names)).toEqual(['worker'])
})
it('includes importers of a removed shared file', () => {
  const removed = { ...sourceFixture }
  Reflect.deleteProperty(removed, 'supabase/functions/_shared/common.ts')
  expect(changedFunctions(['supabase/functions/_shared/common.ts'], removed, names)).toEqual(['api', 'worker'])
})
it('returns no functions for an empty diff and never deploys _shared', () => {
  expect(changedFunctions([], sourceFixture, names)).toEqual([])
  expect(configuredFunctions('[functions.api]\nverify_jwt = false\n[functions.worker]\n')).toEqual(['api', 'worker'])
})
it('refuses removed or unconfigured deployable functions', () => {
  expect(() => changedFunctions(['supabase/functions/deleted/index.ts'], sourceFixture, names)).toThrow('removed or unconfigured')
  expect(() => changedFunctions([], {}, ['api'])).toThrow('Missing function entry')
})

it.each(['https://production.supabase.co', 'https://app.vercel.app', 'http://localhost:59480', 'http://127.0.0.1@production.example'])('rejects non-loopback dry-run targets: %s', url => {
  expect(() => validateConfig({ ...config(), edgeUrl: url }, true)).toThrow()
})
it('rejects redirects before a dry-run request can leave loopback', async () => {
  const fetch = vi.fn(async (_url: URL, _options?: RequestInit) => new Response('{}'))
  await checkedFetch({ dryRun: true, fetch }, 'http://127.0.0.1:59480/release-provenance.json')
  expect(fetch.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  await expect(checkedFetch({ dryRun: true, fetch }, 'https://project.supabase.co')).rejects.toThrow('loopback')
  expect(fetch).toHaveBeenCalledTimes(1)
})
it.each(['candidate', 'passed', 'complete', 'invariantFailures', 'gaps'])('refuses replay evidence with invalid %s', field => {
  const receipt = passingReplay()
  if (field === 'candidate') receipt.candidate = main
  if (field === 'passed') receipt.passed = false
  if (field === 'complete') receipt.complete = false
  if (field === 'invariantFailures') receipt.invariantFailures = 1
  if (field === 'gaps') receipt.lateStart.gaps = ['missing']
  expect(() => validateReplay(receipt, candidate)).toThrow()
})
it('accepts complete passing candidate-bound replay evidence', () => { expect(() => validateReplay(passingReplay(), candidate)).not.toThrow() })
it('validates the PR head and main before a merge', () => {
  expect(() => validatePullRequest(pr(), candidate, main)).not.toThrow()
  expect(() => validatePullRequest({ ...pr(), headRefOid: main }, candidate, main)).toThrow()
  expect(() => validatePullRequest({ ...pr(), baseRefOid: candidate }, candidate, main)).toThrow()
})
it('requires explicit SHA arguments and rejects unknown switches', () => {
  expect(parseArgs(['--dry-run', '--candidate', candidate])).toMatchObject({ dryRun: true, candidate })
  expect(() => parseArgs(['--candidate', 'HEAD'])).toThrow()
  expect(() => parseArgs(['--candidate', candidate, '--unsafe'])).toThrow()
})

const migration = '20261029000100_example.sql'
async function databaseFixture() {
  const root = await temporary()
  await mkdir(path.join(root, 'supabase/migrations'), { recursive: true })
  await writeFile(path.join(root, 'supabase/migrations', migration), 'select 1;')
  const run = vi.fn(async (bin: string, args: string[]) => ({ stdout: bin === 'git' ? (args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? candidate : main) : args[0] === 'merge-base' ? main : '') : args[1] === 'query' ? '[]' : '', stderr: args[1] === 'push' ? `Would push these migrations:\n • ${migration}\n` : '' }))
  return {
    root, directory: root, databaseRoot: root, dryRun: true, candidate, config: config(), run,
    state: { completed: { backup: { files: {} }, 'db-dry-run': { pending: [migration], versions: [migration.split('_')[0]] } } },
  }
}
it('runs a real local DB dry-run twice and never applies migrations in dry-run mode', async () => {
  const ctx = await databaseFixture()
  expect((await databasePlan(ctx)).pending).toEqual([migration])
  expect(await databasePush(ctx)).toMatchObject({ applied: false, versions: [] })
  expect(ctx.run.mock.calls.filter(([bin]) => bin === 'supabase').every(([_bin, args]) => args.includes('--local') && (args[1] !== 'push' || args.includes('--dry-run')))).toBe(true)
})
it('rejects a DB dry-run with missing or extra planned migrations', async () => {
  const ctx = await databaseFixture()
  const original = ctx.run.getMockImplementation()!
  ctx.run.mockImplementation(async (bin, args) => bin === 'git' ? original(bin, args) : { stdout: '[]', stderr: '' })
  await expect(databasePlan(ctx)).rejects.toThrow('differs from the expected plan')
})
it('simulates the merge from a checked local PR receipt without calling gh', async () => {
  const root = await temporary()
  await writeFile(path.join(root, 'pr.json'), JSON.stringify(pr()))
  await writeFile(path.join(root, 'notes.md'), 'Release notes')
  const run = vi.fn(async (_bin: string, args: string[]) => ({ stdout: args[0] === 'rev-parse' ? (args[1] === 'HEAD' ? candidate : main) : args[0] === 'branch' ? 'candidate-branch' : args[0] === 'merge-base' ? main : '', stderr: '' }))
  const result = await merge({ root, dryRun: true, candidate, config: { ...config(), pullRequestReceipt: path.join(root, 'pr.json'), releaseNotes: path.join(root, 'notes.md') }, run })
  expect(result).toMatchObject({ simulated: true, squashSha: candidate })
  expect(run.mock.calls.every(([bin]) => bin === 'git')).toBe(true)
})
it.each(['bad health', 'cached chunk', 'edge errors'])('smoke checks reject %s', async failure => {
  const identity = { commitSha: candidate, bundleDigest: 'c'.repeat(64), edgeArtifactDigest: 'd'.repeat(64) }
  const fetch = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('release-provenance.json')) return new Response(JSON.stringify(identity))
    if (url.pathname.endsWith('/health')) return new Response(JSON.stringify({ ...identity, ok: failure !== 'bad health' }))
    return new Response('missing', { status: 404, headers: { 'cache-control': failure === 'cached chunk' ? 'public' : 'no-store' } })
  })
  const ctx = { dryRun: true, candidate, config: config(), fetch, run: async () => ({ stdout: JSON.stringify([{ errors: failure === 'edge errors' ? 1 : 0 }]) }), state: { completed: { 'wait-vercel': identity, 'edge-restamp': identity } } }
  await expect(smoke(ctx)).rejects.toThrow()
})
it('rejects changed resume inputs and releases the exclusive lock', async () => {
  const root = await temporary()
  const cfg = config()
  for (const file of [cfg.replayReceipt, cfg.checksReceipt, cfg.releaseNotes, cfg.recoverySql, cfg.pullRequestReceipt]) await writeFile(path.join(root, file), '{}')
  await writeFile(path.join(root, 'inputs.json'), JSON.stringify(cfg))
  const file = path.join(root, 'evidence/state.json')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, fingerprint: 'different', completed: {} }))
  await expect(release({ root, dryRun: true, candidate, configFile: 'inputs.json', stateFile: file })).rejects.toThrow('different release inputs')
  await expect(stat(`${file}.lock`)).rejects.toThrow()
  expect(sha256('x')).toHaveLength(64)
})

async function rehearsalFixture() {
  const root = await temporary()
  const cfg = config()
  await mkdir(path.join(root, 'stack/supabase/migrations'), { recursive: true })
  await mkdir(path.join(root, 'supabase/functions/api'), { recursive: true })
  await mkdir(path.join(root, 'supabase/migrations'), { recursive: true })
  await mkdir(path.join(root, 'scripts'), { recursive: true })
  await writeFile(path.join(root, 'stack/supabase/config.toml'), 'project_id = "pt4bafablerelease"\n[api]\nport = 59421\n[db]\nport = 59422\n')
  await writeFile(path.join(root, 'supabase/config.toml'), '[functions.api]\nverify_jwt = false\n')
  await writeFile(path.join(root, 'supabase/functions/api/index.ts'), 'export const api = 1')
  await writeFile(path.join(root, 'scripts/stamp-edge-release-provenance.mjs'), `export const stampEdgeReleaseProvenance = async ({ commitSha }) => ({ commitSha, edgeArtifactDigest: '${'d'.repeat(64)}' })`)
  await writeFile(path.join(root, cfg.replayReceipt), JSON.stringify(passingReplay()))
  const logs = ['npm run check:comprehensive', 'npm test'].map((command, index) => ({ command, exitCode: 0, log: `${index}.log`, sha256: sha256('mocked unit fixture') }))
  for (const row of logs) await writeFile(path.join(root, row.log), 'mocked unit fixture')
  await writeFile(path.join(root, cfg.checksReceipt), JSON.stringify({ candidate, passed: true, commands: logs }))
  await writeFile(path.join(root, cfg.releaseNotes), 'Mock release notes')
  await writeFile(path.join(root, cfg.recoverySql), 'select 1;')
  await writeFile(path.join(root, cfg.pullRequestReceipt), JSON.stringify(pr()))
  await writeFile(path.join(root, 'inputs.json'), JSON.stringify(cfg))
  const run = vi.fn(async (bin: string, args: string[]) => {
    if (bin === 'git') {
      if (args[0] === 'archive') await writeFile(args.find(arg => arg.startsWith('--output='))!.slice('--output='.length), 'mock tar')
      if (args[0] === 'rev-parse') return { stdout: args[1] === 'HEAD' ? candidate : main, stderr: '' }
      if (args[0] === 'merge-base') return { stdout: main, stderr: '' }
      if (args[0] === 'branch') return { stdout: 'candidate', stderr: '' }
      if (args[0] === 'ls-files') return { stdout: args[1] === 'supabase/functions' ? 'supabase/functions/api/index.ts' : '', stderr: '' }
    }
    if (bin === 'tar') {
      const target = args[args.indexOf('-C') + 1]
      await mkdir(path.join(target, 'supabase/functions/api'), { recursive: true })
      await writeFile(path.join(target, 'supabase/functions/api/index.ts'), 'export const api = 1')
      await writeFile(path.join(target, 'supabase/config.toml'), '[functions.api]\n')
    }
    if (bin === 'supabase' && args[1] === 'query') return { stdout: args.at(-1)?.includes('edge_invocations') ? '[{"errors":0}]' : '[]', stderr: '' }
    if (bin === 'supabase' && args[1] === 'dump') await writeFile(args[args.indexOf('--file') + 1], 'mock dump')
    return { stdout: '', stderr: '' }
  })
  const fetch = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('/health')) return new Response(JSON.stringify({ ok: true, commitSha: candidate, edgeArtifactDigest: 'd'.repeat(64) }))
    if (url.pathname.endsWith('release-provenance.json')) return new Response(JSON.stringify({ commitSha: candidate, bundleDigest: 'c'.repeat(64) }))
    return new Response('missing', { status: 404, headers: { 'cache-control': 'no-store' } })
  })
  const options = { root, candidate, dryRun: true, configFile: 'inputs.json' }
  return { root, cfg, run, fetch, options }
}

it('completes and resumes a mocked dry run with a receipt and no hosted write commands', async () => {
  const fixture = await rehearsalFixture()
  const result = await release(fixture.options, fixture)
  const receipt = JSON.parse(await readFile(result.file, 'utf8'))
  expect(receipt).toMatchObject({ dryRun: true, productionWrites: false, candidate })
  expect(receipt.steps).toEqual(STEP_ORDER.slice(0, -1))
  expect(fixture.run.mock.calls.some(([bin]) => bin === 'gh')).toBe(false)
  expect(fixture.run.mock.calls.filter(([bin]) => bin === 'supabase').every(([_bin, args]) => args.includes('--local') && (args[1] !== 'push' || args.includes('--dry-run')))).toBe(true)
  fixture.run.mockClear()
  expect(await release(fixture.options, fixture)).toEqual(result)
  expect(fixture.run.mock.calls.some(([_bin, args]) => args[1] === 'dump' || args[0] === 'archive')).toBe(false)
})

it('fails the full dry run before backup when replay evidence fails', async () => {
  const fixture = await rehearsalFixture()
  await writeFile(path.join(fixture.root, fixture.cfg.replayReceipt), JSON.stringify({ ...passingReplay(), passed: false }))
  await expect(release(fixture.options, fixture)).rejects.toThrow('not passing')
  expect(fixture.fetch).not.toHaveBeenCalled()
  expect(fixture.run.mock.calls.every(([bin]) => bin === 'git')).toBe(true)
})

it('refuses a changed full-check log before backup', async () => {
  const fixture = await rehearsalFixture()
  await writeFile(path.join(fixture.root, '0.log'), 'changed')
  await expect(release(fixture.options, fixture)).rejects.toThrow('Check log changed')
  expect(fixture.fetch).not.toHaveBeenCalled()
})

it('checks rollback artifacts without a deploy and prints saved recovery SQL', async () => {
  const fixture = await rehearsalFixture()
  await release(fixture.options, fixture)
  fixture.run.mockClear()
  await rm(path.join(fixture.root, 'inputs.json'))
  await rm(path.join(fixture.root, fixture.cfg.replayReceipt))
  const result = await release({ ...fixture.options, rollback: true }, fixture)
  expect(result).toMatchObject({ simulated: true, recoverySql: path.join(fixture.root, `evidence/releases/${candidate}/dry-run/recovery.sql`) })
  expect(fixture.run.mock.calls.every(([bin]) => bin === 'deno')).toBe(true)
  await writeFile(path.join(fixture.root, 'inputs.json'), JSON.stringify(fixture.cfg))
  await writeFile(path.join(fixture.root, fixture.cfg.replayReceipt), JSON.stringify(passingReplay()))
  await expect(release(fixture.options, fixture)).rejects.toThrow('rolled-back')
})

it('refuses a corrupted rollback artifact before running any commands', async () => {
  const fixture = await rehearsalFixture()
  await release(fixture.options, fixture)
  await writeFile(path.join(fixture.root, `evidence/releases/${candidate}/dry-run/previous-edge/supabase/functions/api/index.ts`), 'tampered')
  fixture.run.mockClear()
  await expect(release({ ...fixture.options, rollback: true }, fixture)).rejects.toThrow('Backup changed')
  expect(fixture.run).not.toHaveBeenCalled()
})


it.each([
  ['gh', ['pr', 'merge', '1', '--squash']],
  ['vercel', ['deploy', '--prod']],
  ['git', ['ls-remote', 'origin']],
  ['supabase', ['functions', 'deploy', 'api']],
  ['supabase', ['db', 'push', '--linked']],
  ['supabase', ['db', 'push', '--local']],
])('blocks hosted or mutating commands through the dry-run command guard: %s', async (bin, args) => {
  const execute = vi.fn(async () => ({ stdout: '', stderr: '' }))
  await expect(guardedCommand(true, execute)(bin, args, '/fixture')).rejects.toThrow('forbidden')
  expect(execute).not.toHaveBeenCalled()
})


it('uses logged-in CLI accounts instead of inherited token or password overrides', () => {
  expect(cliEnvironment({ PATH: '/tools', GH_TOKEN: 'fixture', GITHUB_TOKEN: 'fixture', SUPABASE_ACCESS_TOKEN: 'fixture', SUPABASE_DB_PASSWORD: 'fixture' })).toEqual({ PATH: '/tools' })
})

it.each(['valid', 'wrong parent', 'wrong tree'])('recovers an interrupted squash merge with %s verification', async variation => {
  const root = await temporary()
  const squash = 'e'.repeat(40)
  const tree = 'f'.repeat(40)
  const merged = { ...pr(), state: 'MERGED', mergeCommit: { oid: squash } }
  const run = vi.fn(async (bin: string, args: string[]) => ({ stdout: bin === 'git' ? tree : JSON.stringify(args[0] === 'pr' ? merged : {
    sha: squash, parents: [{ sha: variation === 'wrong parent' ? candidate : main }], tree: { sha: variation === 'wrong tree' ? candidate : tree },
  }), stderr: '' }))
  const ctx = { root, candidate, dryRun: false, config: { expectedMain: main, pr: 1, releaseNotes: path.join(root, 'notes.md') }, run }
  await writeFile(ctx.config.releaseNotes, 'release notes')
  if (variation === 'valid') expect(await merge(ctx)).toMatchObject({ squashSha: squash, simulated: false })
  else await expect(merge(ctx)).rejects.toThrow('approved base and candidate tree')
  expect(run.mock.calls.some(([bin, args]) => bin === 'gh' && args[0] === 'pr' && args[1] === 'merge')).toBe(false)
})


it('rejects a replay wrapper that contradicts its recorded source', () => {
  expect(() => validateReplay({ ...passingReplay(), source: { application: { commit: main } } }, candidate)).toThrow('another candidate')
})


it('refuses to resume promotion after Edge identity changes', async () => {
  const fixture = await rehearsalFixture()
  await release(fixture.options, fixture)
  const previous = fixture.fetch.getMockImplementation()!
  fixture.fetch.mockImplementation(async url => url.pathname.endsWith('/health')
    ? new Response(JSON.stringify({ ok: true, commitSha: main, edgeArtifactDigest: 'd'.repeat(64) }))
    : previous(url))
  fixture.run.mockClear()
  await expect(release(fixture.options, fixture)).rejects.toThrow('Edge commit does not match')
  expect(fixture.run.mock.calls.every(([bin]) => bin === 'git')).toBe(true)
})

it('refuses saved DB progress when migration history changes', async () => {
  await expect(verifyProgress({ dryRun: true, run: async () => ({ stdout: '[{"version":"unexpected"}]' }) }, 'db-push', { versions: [] })).rejects.toThrow('Database history changed')
})
