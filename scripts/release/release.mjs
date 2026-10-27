import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { preflight } from './steps/preflight.mjs'
import * as rollout from './steps/rollout.mjs'
import { command, fullSha, guardedCommand, readJson, requireValue, saveJson, sha256, validateConfig } from './steps/runtime.mjs'

export const STEP_ORDER = Object.freeze([
  'preflight', 'backup', 'edge-deploy', 'db-dry-run', 'db-push', 'merge',
  'wait-vercel', 'verify-provenance', 'edge-restamp', 'smoke', 'receipt',
])

export async function runSteps(state, steps, persist, verify = async (_name, _result) => {}) {
  let missing = false
  for (const name of STEP_ORDER) {
    if (Object.hasOwn(state.completed, name)) requireValue(!missing, 'State contains out-of-order completed steps')
    else missing = true
  }
  for (const name of STEP_ORDER) {
    if (Object.hasOwn(state.completed, name)) {
      await verify(name, state.completed[name])
      continue
    }
    state.active = name
    delete state.failure
    await persist(state)
    try {
      state.completed[name] = await steps[name]()
      state.active = null
      await persist(state)
    } catch (error) {
      delete state.completed[name]
      state.failure = { step: name, message: error.message, at: new Date().toISOString() }
      await persist(state)
      throw error
    }
  }
  return state
}

export function parseArgs(args) {
  const options = { dryRun: false, rollback: false }
  const values = { '--candidate': 'candidate', '--config': 'configFile', '--state': 'stateFile' }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--rollback') options.rollback = true
    else {
      requireValue(values[arg] && args[index + 1] && !args[index + 1].startsWith('--'), `Unknown or incomplete argument: ${arg}`)
      options[values[arg]] = args[++index]
    }
  }
  requireValue(fullSha(options.candidate), '--candidate requires a full lowercase commit SHA')
  return options
}

export async function release(options, dependencies = {}) {
  requireValue(fullSha(options.candidate), 'Candidate must be a full SHA')
  const root = path.resolve(options.root ?? process.cwd())
  const dryRun = options.dryRun === true
  const stateFile = path.resolve(root, options.stateFile ?? `evidence/releases/${options.candidate}/${dryRun ? 'dry-run' : 'live'}/state.json`)
  const saved = options.rollback ? await readJson(stateFile) : null
  const config = saved ? saved.config : await readJson(path.resolve(root, options.configFile ?? 'evidence/release-inputs.json'))
  validateConfig(config, dryRun)
  for (const key of ['stackRoot', 'replayReceipt', 'checksReceipt', 'recoverySql', 'releaseNotes', 'pullRequestReceipt']) {
    if (config[key]) config[key] = path.resolve(root, config[key])
  }
  const inputHashes = saved ? saved.inputHashes : {}
  for (const key of ['replayReceipt', 'checksReceipt', 'recoverySql', 'releaseNotes', 'pullRequestReceipt']) {
    if (!saved && config[key]) inputHashes[key] = sha256(await readFile(config[key]))
  }
  const identity = { candidate: options.candidate, dryRun, root, config, inputHashes }
  const fingerprint = sha256(JSON.stringify(identity))
  const directory = path.dirname(stateFile)
  requireValue(directory !== root, 'State must use a separate evidence directory')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const lock = `${stateFile}.lock`
  await mkdir(lock)
  try {
    let state
    try { state = await readJson(stateFile) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (state) requireValue(state.version === 1 && state.fingerprint === fingerprint, 'State belongs to different release inputs or mode')
    else state = { version: 1, fingerprint, ...identity, startedAt: new Date().toISOString(), completed: {} }
    const ctx = {
      root, candidate: options.candidate, dryRun, config, directory, state,
      databaseRoot: dryRun ? config.stackRoot : root,
      run: guardedCommand(dryRun, dependencies.run ?? command), fetch: dependencies.fetch ?? globalThis.fetch,
      sleep: dependencies.sleep ?? setTimeout,
    }
    const persist = value => saveJson(stateFile, value)
    if (options.rollback) {
      const result = await rollout.rollback(ctx)
      await saveJson(path.join(directory, 'rollback-receipt.json'), result)
      state.rollback = result
      await persist(state)
      console.log(`Recovery SQL: ${result.recoverySql}`)
      return result
    }
    requireValue(!state.rollback, 'A rolled-back release requires a new state directory')
    const receipt = async () => {
      const result = {
        version: 1, candidate: ctx.candidate, dryRun, productionWrites: !dryRun,
        completedAt: new Date().toISOString(), steps: STEP_ORDER.slice(0, -1),
        results: { ...state.completed }, recoverySql: path.join(directory, 'recovery.sql'),
        limitations: dryRun ? ['GitHub merge and Vercel promotion are simulated. Supabase deploy and real DB push are suppressed.'] : [],
      }
      const file = path.join(directory, 'receipt.json')
      await saveJson(file, result)
      return { file, sha256: sha256(await readFile(file)) }
    }
    const steps = {
      preflight: () => preflight(ctx), backup: () => rollout.backup(ctx),
      'edge-deploy': () => rollout.edgeDeploy(ctx), 'db-dry-run': () => rollout.databasePlan(ctx),
      'db-push': () => rollout.databasePush(ctx), merge: () => rollout.merge(ctx),
      'wait-vercel': () => rollout.waitFrontend(ctx), 'verify-provenance': () => rollout.verifyFrontend(ctx),
      'edge-restamp': () => rollout.restamp(ctx), smoke: () => rollout.smoke(ctx), receipt,
    }
    if (state.completed.preflight) await preflight(ctx, false)
    const verify = async (name, result) => {
      await rollout.verifyProgress(ctx, name, result)
      if (name === 'backup') await rollout.verifyBackup(ctx)
      if (name === 'smoke') await rollout.smoke(ctx)
      if (name === 'receipt') requireValue(sha256(await readFile(result.file)) === result.sha256, 'Written receipt changed')
    }
    await runSteps(state, steps, persist, verify)
    console.log(`Receipt: ${state.completed.receipt.file}`)
    return state.completed.receipt
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await release(parseArgs(process.argv.slice(2))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
