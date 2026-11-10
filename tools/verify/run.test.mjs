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

test('local endpoint guard rejects hosted, lookalike, and wrong-protocol endpoints', () => {
  assert.equal(requireLocal('http://127.0.0.1:54121').port, '54121')
  assert.equal(requireLocal('postgresql://postgres:postgres@127.0.0.1:54122/postgres', 'postgresql:').port, '54122')
  for (const url of ['https://example.supabase.co', 'http://127.0.0.1.evil.test:54121', 'file:///etc/passwd', 'http://127.0.0.1:80']) {
    assert.throws(() => requireLocal(url), url)
  }
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
    await writeFile(path.join(dir, 'run.json'), JSON.stringify({ cleanedAt: null }))
    await writeFile(path.join(dir, 'fixture.json'), '{}')
    await writeFile(path.join(dir, 'webkit-port.json'), JSON.stringify({ port: server.address().port }))
    for (const flags of [['--only=typo'], ['--only='], ['--only=offers', '--only=typo']]) {
      await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('./trade-player-stats.mjs', import.meta.url)), dir, ...flags]), /Unknown journey/)
      assert.equal(requests, 0)
    }
    for (const name of ['typo', 'all', 'offers']) await assert.rejects(readFile(path.join(dir, `trade-player-stats-${name}-receipt.json`)), /ENOENT/)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
