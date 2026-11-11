import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { execFile, execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { requireLocal, stackConfig, refreshAppSources } from './run.mjs'
import { assertTradeProof, assertTradeSenderStates, beginTradeProof, reserveTradeCapture, tradeProofReceiptName } from './trade-proof.mjs'
import { localFixtureEnv } from './local-fetch.mjs'

test('local endpoint guard rejects hosted, lookalike, and wrong-protocol endpoints', () => {
  assert.equal(requireLocal('http://127.0.0.1:54121').port, '54121')
  assert.equal(requireLocal('postgresql://postgres:postgres@127.0.0.1:54122/postgres', 'postgresql:').port, '54122')
  for (const url of ['https://example.supabase.co', 'http://127.0.0.1.evil.test:54121', 'file:///etc/passwd', 'http://127.0.0.1:80']) {
    assert.throws(() => requireLocal(url), url)
  }
})

test('fixture transport closes local HTTP connections while preserving request data', async () => {
  const base = { PATH: process.env.PATH, HOME: os.homedir() }
  assert.equal(base.NODE_OPTIONS, undefined)
  const configured = localFixtureEnv(base)
  assert.match(configured.NODE_OPTIONS, /--import=file:/)
  assert.equal(base.NODE_OPTIONS, undefined)
  const source = `globalThis.fetch = async (input, init) => ({ connection: new Headers(init?.headers).get('connection'), key: new Headers(init?.headers).get('apikey'), method: init?.method, body: init?.body });
await import(${JSON.stringify(new URL('./local-fetch.mjs', import.meta.url).href)});
const init = { method: 'POST', headers: { apikey: 'fixture-only' }, body: 'fixture body' };
console.log(JSON.stringify([await fetch('http://127.0.0.1:52001/auth/v1/token', init), await fetch('https://example.com', init)]));`
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { ...base, PANCAKE_VERIFY_FIXTURE_LOCAL_TRANSPORT: '1' } })
  const [local, external] = JSON.parse(result.stdout)
  assert.deepEqual(local, { connection: 'close', key: 'fixture-only', method: 'POST', body: 'fixture body' })
  assert.deepEqual(external, { connection: null, key: 'fixture-only', method: 'POST', body: 'fixture body' })
})

test('isolated config replaces all exposed ports and only the temporary project identity', async () => {
  const source = await readFile(new URL('../../supabase/config.toml', import.meta.url), 'utf8')
  const isolated = stackConfig(source, 'pancake-verify-test', 54120)
  assert.match(isolated, /project_id = "pancake-verify-test"/)
  for (const port of [54119, 54120, 54121, 54122, 54123, 54126, 54128, 54129]) assert.ok(isolated.includes(`= ${port}`), String(port))
  assert.doesNotMatch(isolated, /^(?:port|shadow_port|inspector_port) = 5432[0-9]/m)
  assert.match(source, /project_id = "pancake"/)
  assert.match(isolated, /\[functions.api\]\nverify_jwt = false/)
})

test('feature map has the generator shape and covers every required area', async () => {
  const root = new URL('../../.claude/skills/verify-pancake/', import.meta.url)
  const skill = await readFile(new URL('SKILL.md', root), 'utf8')
  assert.match(skill, /^---\nname: verify-pancake\ndescription:/)
  for (const section of ['Launch', 'Doctor', 'Drive', 'Evidence', 'Cleanup', 'Helpers']) assert.ok(skill.includes(`## ${section}\n`))
  const files = await readdir(new URL('features/', root))
  for (const area of ['sign-in', 'home', 'roster', 'lineup', 'players-waivers', 'trades', 'league', 'player', 'draft', 'settings', 'pwa']) {
    assert.ok(files.includes(`${area}.md`))
    const text = await readFile(new URL(`features/${area}.md`, root), 'utf8')
    assert.deepEqual(text.match(/^## .+$/gm), ['## Sub-features', '## How to get to it (user POV)', '## Driving it with agent-browser', '## Gotchas'])
    assert.match(text, /Preconditions:/)
  }
})

test('cleanup closes a browser created after launch and preserves evidence', async () => {
  const root = path.join(os.homedir(), 'Documents/pancake-verify-evidence')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'helper-check-'))
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  const script = new URL('./run.mjs', import.meta.url)
  const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({ id: 'pancake-verify-check', dir, repo, work: dir, url: 'http://127.0.0.1:50001', processes: [], stackStarted: false, browserStarted: false }))
  await writeFile(path.join(dir, 'browser-config.json'), '{}')
  await writeFile(path.join(dir, 'proof.txt'), 'keep this evidence')
  await writeFile(path.join(bin, 'agent-browser'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('close')) fs.writeFileSync(${JSON.stringify(path.join(dir, 'closed.txt'))}, 'closed');
else console.log(JSON.stringify({success:true,data:{sessions:[]}}));
`, { mode: 0o700 })
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: os.homedir() }
  execFileSync(process.execPath, [fileURLToPath(script), 'cleanup', dir], { env })
  assert.equal(await readFile(path.join(dir, 'closed.txt'), 'utf8'), 'closed')
  assert.equal(await readFile(path.join(dir, 'proof.txt'), 'utf8'), 'keep this evidence')
  assert.ok(JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8')).cleanedAt)
  execFileSync(process.execPath, [fileURLToPath(script), 'cleanup', dir], { env })
  assert.throws(() => execFileSync(process.execPath, [fileURLToPath(script), 'doctor', dir], { env, stdio: 'pipe' }), /cleaned up/)
})

test('named clicks use the visible snapshot target instead of a hidden duplicate', async () => {
  const root = path.join(os.homedir(), 'Documents/pancake-verify-evidence')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'visible-click-'))
  const bin = path.join(dir, 'bin')
  await mkdir(bin)
  const repo = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')
  await writeFile(path.join(dir, 'run.json'), JSON.stringify({ id: 'pancake-verify-visible-click', dir, repo, work: dir, url: 'http://127.0.0.1:50001' }))
  await writeFile(path.join(bin, 'agent-browser'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('snapshot')) console.log(JSON.stringify({success:true,data:{refs:{e2:{role:'button',name:'Back'}}}}));
else if (process.argv.includes('click')) fs.writeFileSync(${JSON.stringify(path.join(dir, 'clicked.txt'))}, process.argv.at(-1));
else if (process.argv.includes('find')) process.exit(1);
`, { mode: 0o700 })
  execFileSync(process.execPath, [fileURLToPath(new URL('./browser.mjs', import.meta.url)), dir, 'find', 'role', 'button', 'click', '--name', 'Back', '--exact'], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: os.homedir() }, stdio: 'pipe' })
  assert.equal(await readFile(path.join(dir, 'clicked.txt'), 'utf8'), '@e2')
})

test('source refresh removes deleted routes and old core output while retaining runtime state', async () => {
  const root = path.join(os.homedir(), 'Documents/pancake-verify-evidence')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'source-refresh-'))
  const source = path.join(dir, 'source')
  const work = path.join(dir, 'work')
  for (const folder of [source + '/app', source + '/core/src', work + '/app', work + '/core/cjs', work + '/supabase', work + '/tests']) await mkdir(folder, { recursive: true })
  await writeFile(source + '/app/current.tsx', 'current route')
  await writeFile(source + '/core/src/value.ts', 'new core source')
  await writeFile(work + '/app/deleted.tsx', 'obsolete route')
  await writeFile(work + '/core/cjs/value.js', 'old core output')
  await writeFile(work + '/supabase/config.toml', 'owned isolated stack')
  await writeFile(work + '/tests/e2e-state.json', 'owned fixture state')
  await refreshAppSources(source, work, ['app/current.tsx', 'app/deleted.tsx', 'core/src/value.ts'])
  assert.deepEqual(await readdir(work + '/app'), ['current.tsx'])
  assert.equal(await readFile(work + '/core/src/value.ts', 'utf8'), 'new core source')
  await assert.rejects(readFile(work + '/core/cjs/value.js'), /ENOENT/)
  assert.equal(await readFile(work + '/supabase/config.toml', 'utf8'), 'owned isolated stack')
  assert.equal(await readFile(work + '/tests/e2e-state.json', 'utf8'), 'owned fixture state')
})

test('invalid journey filters fail before browser actions or success receipts', async () => {
  const root = path.join(os.homedir(), 'Documents/pancake-verify-evidence')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'journey-filter-'))
  let requests = 0
  const server = createServer((request, response) => {
    requests++
    request.resume()
    response.end(JSON.stringify({ result: 'navigation "Primary"' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await writeFile(path.join(dir, 'run.json'), JSON.stringify({ id: 'pancake-verify-filter', dir, repo: fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''), cleanedAt: null }))
    await writeFile(path.join(dir, 'fixture.json'), '{}')
    await writeFile(path.join(dir, 'webkit-port.json'), JSON.stringify({ port: server.address().port }))
    for (const flags of [['--only=typo'], ['--only='], ['--only=offers', '--only=typo']]) {
      for (const name of ['typo', 'all', 'offers']) await writeFile(path.join(dir, `trade-player-stats-${name}-receipt.json`), '{"oldSuccess":true}')
      await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./trade-player-stats.mjs', import.meta.url)), dir, ...flags]), /Unknown journey/)
      assert.equal(requests, 0)
      for (const name of ['typo', 'all', 'offers']) await assert.rejects(readFile(path.join(dir, `trade-player-stats-${name}-receipt.json`)), /ENOENT/)
    }
    for (const name of ['typo', 'all', 'offers']) await assert.rejects(readFile(path.join(dir, `trade-player-stats-${name}-receipt.json`)), /ENOENT/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('grouped-only activity cannot satisfy individual trade proof or retain prior success', async () => {
  const root = path.join(os.homedir(), 'Documents/pancake-verify-evidence')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'activity-proof-'))
  const clicks = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const { command, values } = JSON.parse(body)
      if (command === 'click') clicks.push(JSON.parse(values[0]))
      const result = command === 'links' ? [{ label: 'View E2E Player013 stats', ancestors: ['trade-activity-group'] }] : 'navigation "Primary" Activity\n- button "View E2E Player013 stats"'
      response.end(JSON.stringify({ result }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await writeFile(path.join(dir, 'run.json'), JSON.stringify({ id: 'pancake-verify-activity-proof', dir, repo: fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, ''), cleanedAt: null }))
    await writeFile(path.join(dir, 'fixture.json'), '{}')
    await writeFile(path.join(dir, 'webkit-port.json'), JSON.stringify({ port: server.address().port }))
    for (const name of ['all', 'activity']) await writeFile(path.join(dir, `trade-player-stats-${name}-receipt.json`), '{"oldSuccess":true}')
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./trade-player-stats.mjs', import.meta.url)), dir, '--only=activity', '--width=390']), /Individual trade activity contains a player stats control/)
    assert.equal(clicks.some(target => target.name?.startsWith('View ')), false)
    for (const name of ['all', 'activity']) await assert.rejects(readFile(path.join(dir, `trade-player-stats-${name}-receipt.json`)), /ENOENT/)
    assert.match(JSON.parse(await readFile(path.join(dir, 'trade-player-stats-failure.json'), 'utf8')).error, /Individual trade activity/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('partial viewports and subfeatures cannot produce the canonical matrix receipt', () => {
  const canonical = 'trade-player-stats-all-receipt.json'
  assert.equal(tradeProofReceiptName(undefined, [390, 375, 1440]), canonical)
  for (const widths of [[390], [375], [1440], [390, 375]]) assert.notEqual(tradeProofReceiptName(undefined, widths), canonical)
  assert.notEqual(tradeProofReceiptName('activity', [390, 375, 1440]), canonical)
})

test('success requires every documented entry point at every requested viewport', () => {
  const activity = ['league-trade-activity', 'league-completed-activity'].map(label => ({ label, width: 390 }))
  assertTradeProof(activity, [390], 'activity')
  assert.throws(() => assertTradeProof(activity.slice(0, 1), [390], 'activity'), /Every activity entry point/)
  assert.throws(() => assertTradeProof([...activity, activity[0]], [390], 'activity'), /Every activity entry point/)
  assert.throws(() => assertTradeProof(activity, [390, 375], 'activity'), /375px/)
  assert.throws(() => assertTradeProof(activity, [390]), /Every full-matrix entry point/)
})

test('stats and selection captures stay distinct while duplicate viewport captures fail', () => {
  const captures = new Set()
  reserveTradeCapture(captures, 390, 'analyzer-selection-before')
  reserveTradeCapture(captures, 390, 'analyzer-column-selection-before')
  reserveTradeCapture(captures, 375, 'analyzer-selection-before')
  assert.throws(() => reserveTradeCapture(captures, 390, 'analyzer-selection-before'), /Duplicate trade proof capture/)
})

test('complete sender checks catch inactive FAAB and route resets while allowing one removed asset', () => {
  const before = [
    { sender: 'You', controls: [{ label: 'FAAB sent by You to Them', value: '9' }, { label: 'Route Player003 to Third', selected: 'true' }], selectionLabels: ['Remove Player003 from trade'] },
    { sender: 'Third', controls: [{ label: 'Remove Player041 from trade', selected: 'true' }], selectionLabels: ['Remove Player041 from trade'] },
  ]
  const after = structuredClone(before)
  after[1].controls = []
  after[1].selectionLabels = []
  assertTradeSenderStates(before, after, 'Player041')
  const faabReset = structuredClone(after)
  faabReset[0].controls[0].value = '0'
  assert.throws(() => assertTradeSenderStates(before, faabReset, 'Player041'), /Every sender/)
  const routeReset = structuredClone(after)
  routeReset[0].controls[1].selected = 'false'
  assert.throws(() => assertTradeSenderStates(before, routeReset, 'Player041'), /Every sender/)
  assert.throws(() => assertTradeSenderStates(before, after.slice(1), 'Player041'), /Every sender/)
})

test('new attempts archive prior captures and receipts without touching unrelated evidence', async () => {
  const root = path.join(os.homedir(), 'Documents/pancake-verify-evidence')
  await mkdir(root, { recursive: true })
  const dir = await mkdtemp(path.join(root, 'proof-attempt-'))
  const files = ['trade-player-stats-all-receipt.json', 'trade-player-stats-390-probe-state.json', 'webkit-trade-player-stats-375-probe.png', 'webkit-trade-player-stats-1440-probe.txt']
  for (const file of [...files, 'fixture.json']) await writeFile(path.join(dir, file), file)
  const first = await beginTradeProof(dir)
  for (const file of files) {
    await assert.rejects(readFile(path.join(dir, file)), /ENOENT/)
    assert.equal(await readFile(path.join(dir, `previous-trade-proof-${first}`, file), 'utf8'), file)
  }
  assert.equal(await readFile(path.join(dir, 'fixture.json'), 'utf8'), 'fixture.json')
  await writeFile(path.join(dir, files[0]), 'latest receipt')
  const second = await beginTradeProof(dir)
  assert.notEqual(first, second)
  assert.equal(await readFile(path.join(dir, `previous-trade-proof-${second}`, files[0]), 'utf8'), 'latest receipt')
  assert.equal(await readFile(path.join(dir, `previous-trade-proof-${first}`, files[0]), 'utf8'), files[0])
})
