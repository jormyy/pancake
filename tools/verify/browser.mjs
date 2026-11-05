#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const [dirArg, action, ...args] = process.argv.slice(2)
assert.ok(dirArg && action, 'Usage: browser.sh EVIDENCE COMMAND [ARGS]')
const dir = path.resolve(dirArg)
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.equal(run.repo, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'))
assert.ok(!run.cleanedAt, 'Run has been cleaned up')
assert.match(run.id, /^pancake-verify-[a-z0-9-]+$/)
const env = { PATH: process.env.PATH, HOME: os.homedir(), TMPDIR: os.tmpdir() }
const config = path.join(dir, 'browser-config.json')
await writeFile(config, '{"headed":false}\n', { mode: 0o600 })
run.browserStarted = true
await writeFile(path.join(dir, 'run.json'), JSON.stringify(run, null, 2) + '\n', { mode: 0o600 })
const browser = command => {
  try { return execFileSync('agent-browser', ['--session', run.id, '--config', config, ...command], { env, encoding: 'utf8', timeout: 60000 }) }
  catch (error) { throw new Error(`Browser ${command[0]} failed (${error.status ?? error.code}). Inspect this run's screenshot and snapshot.`) }
}
if (action === 'login') {
  const state = JSON.parse(await readFile(path.join(run.work, 'tests/e2e-state.json'), 'utf8'))
  const user = state.users[Number(args[0] ?? 0)]
  assert.ok(user, 'Choose a seeded account index')
  browser(['set', 'viewport', '390', '844'])
  browser(['open', `${run.url}/sign-in`])
  browser(['wait', 'input[placeholder="you@example.com"]'])
  browser(['fill', 'input[placeholder="you@example.com"]', user.email])
  browser(['fill', 'input[placeholder="Your password"]', state.password])
  browser(['find', 'role', 'button', 'click', '--name', 'Sign In', '--exact'])
  console.log('Submitted seeded credentials through the sign-in form. Confirm Home with snapshot.')
} else if (action === 'find' && args[0] === 'role' && args[2] === 'click' && args[3] === '--name' && args.includes('--exact')) {
  const snapshot = JSON.parse(browser(['snapshot', '-i', '--json']))
  const matches = Object.entries(snapshot.data.refs).filter(([, ref]) => ref.role === args[1] && ref.name === args[4])
  assert.equal(matches.length, 1, 'Choose one visible snapshot reference for this action')
  const target = `@${matches[0][0]}`
  browser(['scrollintoview', target])
  process.stdout.write(browser(['click', target]))
} else {
  assert.ok(!['auth', 'connect', 'session'].includes(action), 'Use only this run’s isolated browser')
  assert.ok(!args.includes('--all'), 'Never close all browser sessions')
  process.stdout.write(browser([action, ...args]))
}
await appendFile(path.join(dir, 'actions.log'), `${new Date().toISOString()} ${action}${['fill', 'type', 'login', 'eval'].includes(action) ? ' [details omitted]' : ' ' + args.join(' ')}\n`)
