import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import ts from 'typescript'

const run = promisify(execFile)
const cli = `${process.cwd()}/node_modules/.bin/agent-browser`
const session = `beacons-${process.pid}`
const browser = (...args) => run(cli, ['--session', session, ...args], { timeout: 30000, maxBuffer: 1024 * 1024 })
const module = ts.transpileModule(readFileSync('lib/perf-beacon.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const source = `
import { observeUsefulContent } from '/beacon.js'
const checks = []
const tick = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
const fixture = (body, title = 'Players') => { document.body.innerHTML = '<main role="main"><h1 role="heading" aria-level="1">'+title+'</h1>'+body+'</main>' }
const assert = (ok, label) => { if (!ok) throw Error(label); checks.push(label) }
try {
  fixture('<input placeholder="Search players..."><div aria-busy="true"><span>Loading players</span></div>')
  let paints = 0
  let cancelled = 0
  const stop = observeUsefulContent('players', performance.now(), () => paints++, () => cancelled++)
  await tick()
  assert(paints === 0, 'search controls and loading text do not count')
  fixture('<input placeholder="Search players..."><div aria-busy="false" style="opacity:0"><span>23 players</span></div>')
  await tick()
  assert(paints === 0, 'invisible content does not count')
  fixture('<input placeholder="Search players..."><div aria-busy="false"><span>23 players</span></div>', 'Roster')
  await tick()
  assert(paints === 0, 'stale screen content does not count')
  fixture('<input placeholder="Search players..."><div aria-busy="true"><div aria-busy="false"><span>23 players</span></div></div>')
  await tick()
  assert(paints === 0, 'busy ancestors do not count')
  fixture('<input placeholder="Search players..."><div aria-busy="false"><span>23 players</span></div>')
  assert(paints === 0, 'DOM insertion alone does not count')
  await tick()
  await tick()
  assert(paints === 1, 'useful current content counts after a paint opportunity')
  await tick()
  assert(paints === 1 && cancelled === 1, 'observation stops after its first reading')
  stop()
  fixture('<div aria-busy="true"><span>Loading roster</span></div>', 'Roster')
  let late = 0
  const cancel = observeUsefulContent('roster', performance.now(), () => late++, () => {})
  cancel()
  fixture('<div aria-busy="false"><span>Active roster</span></div>', 'Roster')
  await tick()
  assert(late === 0, 'navigation cancellation rejects late content')
  fixture('<span>No active draft</span>', 'Draft Room')
  let drafts = 0
  observeUsefulContent('draft', performance.now(), () => drafts++, () => {})
  await tick()
  await tick()
  assert(drafts === 1, 'empty draft result counts as useful content')
  fixture('<button aria-label="Increase bid"><span>Bid</span></button>', 'Mock Auction Draft')
  observeUsefulContent('draft', performance.now(), () => drafts++, () => {})
  await tick()
  await tick()
  assert(drafts === 2, 'inline auction controls count after paint')
  const named = async (screen, title, expected, label) => {
    fixture('<div aria-busy="false"><span>Week 2 results</span></div>', title)
    let count = 0
    const stop = observeUsefulContent(screen, performance.now(), () => count++, () => {})
    await tick()
    await tick()
    stop()
    assert(count === expected, label)
  }
  await named('home', 'Matchup', 1, 'home counts under its matchup title')
  await named('waivers', 'Players', 1, 'waivers counts under the players title')
  await named('waivers', 'Roster', 0, 'waivers ignores another screen title')
  await named('draft-setup', 'League', 1, 'draft setup counts under the league title')
  const sized = async (path) => {
    const url = 'http://localhost:59581' + path + '?' + Math.random()
    await (await fetch(url, { cache: 'no-store' })).text()
    return performance.getEntriesByName(url)[0]?.transferSize ?? 0
  }
  assert(await sized('/data-hidden') === 0, 'cross-origin sizes stay hidden without the timing header')
  assert(await sized('/data-timed') > 0, 'cross-origin sizes are visible with the timing header')
  window.results = { pass: checks.length, checks }
} catch (error) { window.results = { fail: String(error), checks } }
`
const server = createServer((req, res) => {
    if (req.url?.startsWith('/data-')) {
        res.setHeader('Access-Control-Allow-Origin', '*')
        if (req.url.startsWith('/data-timed')) res.setHeader('Timing-Allow-Origin', '*')
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, rows: Array(50).fill('row') }))
    }
    else if (req.url === '/beacon.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(module) }
    else if (req.url === '/check.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(source) }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><title>Beacon readiness check</title><script type="module" src="/check.js"></script></head><body></body></html>') }
})
await new Promise(resolve => server.listen(59581, '127.0.0.1', resolve))
try {
    await run(cli, ['session', 'list'])
    await browser('open', 'http://127.0.0.1:59581')
    await browser('wait', '1500')
    const snapshot = await browser('snapshot')
    if (!snapshot.stdout.includes('23 players') && !snapshot.stdout.includes('Active roster') && !snapshot.stdout.includes('Bid') && !snapshot.stdout.includes('Week 2 results')) throw Error('Browser fixture is blank')
    const { stdout } = await browser('eval', 'JSON.stringify(window.results)')
    const result = JSON.parse(JSON.parse(stdout.trim()))
    if (result.fail || result.pass !== 16) throw Error(JSON.stringify(result))
    console.log(JSON.stringify(result))
} finally {
    await browser('close').catch(() => {})
    try {
        for (let attempt = 0; attempt < 10; attempt++) {
            const sessions = await run(cli, ['session', 'list'])
            if (!sessions.stdout.includes(session)) break
            if (attempt === 9) throw Error('Browser session remains open')
            await new Promise(resolve => setTimeout(resolve, 200))
        }
    } finally { await new Promise(resolve => server.close(resolve)) }
}
