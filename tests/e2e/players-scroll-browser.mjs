import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableps"$/m)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, 'http://127.0.0.1:62621')
const { origin } = JSON.parse(await readFile('../browser-origin.json', 'utf8'))
assert.equal(new URL(origin).port, '62684')
const phase = process.argv[2] ?? 'after'
assert.ok(['before', 'after'].includes(phase))
const output = path.resolve(`../players-scroll-${phase}`)
await mkdir(output, { recursive: true })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const admin = createClient(stack.API_URL, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const members = await checked(admin.from('league_members').select('id,user_id,league_id').order('joined_at').limit(1))
assert.equal(members.length, 1)
const member = members[0]
const email = `players-scroll-${randomUUID()}@example.invalid`, password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Players scroll check' } }))
const browserSession = `fable-ui20-${randomUUID()}`
const executable = path.resolve('node_modules/.bin/agent-browser')
const call = (...args) => {
    const raw = execFileSync(executable, ['--session', browserSession, '--ignore-https-errors', '--args', `--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1`, '--json', ...args], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] })
    const result = JSON.parse(raw)
    assert.equal(result.success, true, `agent-browser ${args[0]}`)
    return result.data
}
const sql = statement => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafableps', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
const bump = (topic, table) => sql(`SELECT private.publish_league_version('${member.league_id}',ARRAY['${topic}'],ARRAY['${table}']);`)
const requests = [], records = []
const pendingPlayers = new Set()
const routeErrors = []
let browser, page
let scenario = 'setup'
let refreshAnchor = null
const state = () => page.evaluate(() => {
    const scroller = [...document.querySelectorAll('div')].filter(node => node.clientHeight > 100 && node.scrollHeight > node.clientHeight + 200 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY)).sort((a, b) => b.scrollHeight - a.scrollHeight)[0]
    const rows = [...document.querySelectorAll('[aria-label^="Open "]')].filter(node => {
        const box = node.getBoundingClientRect()
        return box.height > 0 && box.bottom > 180 && box.top < innerHeight - 80
    }).map(node => ({ label: node.getAttribute('aria-label'), top: Math.round(node.getBoundingClientRect().top) }))
    const count = document.body.innerText.match(/\b(\d+)(?: filtered)? players\b/)
    return { count: count ? Number(count[1]) : 0, offset: scroller?.scrollTop ?? 0, height: scroller?.scrollHeight ?? 0, rows }
})
const scroll = async bottom => {
    call('eval', `(() => { const node = [...document.querySelectorAll('div')].filter(node => node.clientHeight > 100 && node.scrollHeight > node.clientHeight + 200 && ['auto','scroll'].includes(getComputedStyle(node).overflowY)).sort((a,b) => b.scrollHeight-a.scrollHeight)[0]; if(node) node.scrollTop = ${bottom ? 'node.scrollHeight - node.clientHeight' : 'Math.min(1800,node.scrollHeight-node.clientHeight-180)'}; })()`)
    await delay(300)
}
const settle = async () => {
    await delay(1200)
    for (let attempt = 0; attempt < 100 && pendingPlayers.size > 0; attempt++) await delay(100)
    assert.equal(pendingPlayers.size, 0, 'Players requests settled')
    await page.waitForFunction(() => !document.body.innerText.includes('Loading more players'), { timeout: 30000 })
    await delay(300)
}
const capture = name => call('screenshot', path.join(output, `${name}.png`))
const loadThree = async () => {
    console.log('Opening private Players screen.')
    await page.goto(`${origin}/players`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.getByRole('textbox', { name: 'Search players', exact: true }).waitFor()
    await settle()
    for (let index = 0; index < 8 && (await state()).count < 60; index++) { await scroll(true); await settle() }
    assert.ok((await state()).count >= 60, 'Loaded at least three pages')
    await scroll(false)
    await settle()
}
try {
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', member.id))
    const auth = createClient(stack.API_URL, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    console.log('Starting owned agent-browser session.')
    call('open', 'about:blank')
    const endpoint = call('get', 'cdp-url')
    console.log('Connecting to owned automation browser.')
    browser = await chromium.connectOverCDP(typeof endpoint === 'string' ? endpoint : endpoint.url ?? endpoint.cdpUrl, { timeout: 10000 })
    console.log('Preparing private browser context.')
    const context = browser.contexts()[0]
    page = context.pages()[0]
    await page.setViewportSize({ width: 390, height: 844 })
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        return url.origin === origin || url.hostname === '127.0.0.1' && url.port.startsWith('626') || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
    })
    await context.addInitScript(({ session, member }) => {
        localStorage.setItem(`sb-${location.hostname.split('.')[0]}-auth-token`, JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${session.user.id}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: member.id }))
    }, { session, member })
    page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/views/players')) pendingPlayers.add(request) })
    page.on('requestfailed', request => pendingPlayers.delete(request))
    page.on('requestfinished', async request => {
        pendingPlayers.delete(request)
        const url = new URL(request.url())
        if (!/^\/(functions|rest)\/v1\//.test(url.pathname)) return
        const response = await request.response()
        requests.push({ scenario, path: url.pathname, params: url.searchParams.get('params'), since: url.searchParams.get('since'), status: response?.status(), at: Date.now() })
    })
    const cases = [
        ['background-trade', async () => bump('trade', 'trade_value_cache')],
        ['forecast', async () => bump('forecast', 'matchup_forecasts')],
        ['standings', async () => bump('score', 'standings_current')],
        ['live-stats', async () => bump('player_stats', 'player_game_stats')],
        ['focus', async () => {
            await page.getByRole('link', { name: 'Roster', exact: true }).click()
            await delay(300)
            await page.getByRole('link', { name: 'Players', exact: true }).click()
        }],
        ['offline-online', async () => {
            await context.setOffline(true)
            await page.evaluate(() => window.dispatchEvent(new Event('offline')))
            await delay(300)
            await context.setOffline(false)
            await page.evaluate(() => window.dispatchEvent(new Event('online')))
        }],
        ['stale-revalidate', async () => {
            await page.route('**/views/players?**', async route => { await delay(600); await route.continue().catch(error => routeErrors.push(error.message)) })
            bump('resources', 'players')
            await delay(300)
            capture('stale-revalidate-during')
            await settle()
            await page.unrouteAll({ behavior: 'wait' })
        }],
        ['loadMore-refresh-race', async () => {
            let release = () => {}
            const held = new Promise(resolve => { release = () => resolve(undefined) })
            let started = () => {}
            const waiting = new Promise(resolve => { started = () => resolve(undefined) })
            const baseline = (await state()).count
            await page.route('**/views/players?**', async route => {
                const params = JSON.parse(new URL(route.request().url()).searchParams.get('params'))
                if (params.offset >= baseline) { started(); await held }
                await route.continue().catch(error => routeErrors.push(error.message))
            })
            await scroll(true)
            await Promise.race([waiting, delay(10000).then(() => { throw new Error('Next page did not start') })])
            refreshAnchor = await state()
            capture('loadMore-refresh-race-pending')
            bump('player_stats', 'player_game_stats')
            await delay(500)
            release()
            await settle()
            await page.unrouteAll({ behavior: 'wait' })
        }],
    ]
    for (const entry of cases) {
        const name = String(entry[0])
        const trigger = entry[1]
        assert.equal(typeof trigger, 'function')
        if (typeof trigger !== 'function') throw new Error('Missing trigger')
        console.log(`Checking ${name}.`)
        scenario = name
        refreshAnchor = null
        await loadThree()
        const before = await state()
        capture(`${name}-before`)
        const reads = requests.filter(row => row.path.endsWith('/views/players')).length
        await trigger()
        await settle()
        const after = await state()
        capture(`${name}-after`)
        const playerReads = requests.filter(row => row.path.endsWith('/views/players')).length - reads
        const anchor = refreshAnchor ?? before
        const rowsKept = anchor.rows.every(row => after.rows.some(next => next.label === row.label && Math.abs(next.top - row.top) <= 1))
            && (name === 'loadMore-refresh-race' || after.rows.length === anchor.rows.length)
        const kept = after.count >= anchor.count && Math.abs(after.offset - anchor.offset) <= 2 && rowsKept
        records.push({ name, before, beforeRefresh: refreshAnchor ?? undefined, after, playerReads, kept })
        await writeFile(path.join(output, 'report.json'), JSON.stringify({ phase, width: 390, records }, null, 2))
        console.log(JSON.stringify({ name, before: before.count, after: after.count, offsetBefore: before.offset, offsetAfter: after.offset, playerReads, kept }))
    }
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ phase, width: 390, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), records }, null, 2))
    assert.deepEqual(routeErrors, [], 'Browser interception completed')
    if (phase === 'after') {
        for (const record of records) assert.equal(record.kept, true, record.name)
        const race = records.find(record => record.name === 'loadMore-refresh-race')
        assert.ok(race.after.count >= race.before.count + 20, 'Racing loadMore keeps its appended page')
        for (const name of ['background-trade', 'forecast', 'standings']) assert.equal(records.find(record => record.name === name).playerReads, 0, `${name} has no Players refetch`)
    } else assert.ok(records.some(record => !record.kept), 'Original bug reproduced')
} catch (error) {
    console.error(String(error))
    if (page) { await writeFile(path.join(output, 'failure.txt'), `${String(error)}\n${await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'No body')}`); try { capture('failure') } catch {} }
    throw error
} finally {
    await writeFile(path.join(output, 'requests.json'), JSON.stringify(requests, null, 2))
    if (browser) await browser.close()
    call('close')
    await checked(admin.from('league_members').update({ user_id: member.user_id }).eq('id', member.id))
    await checked(admin.auth.admin.deleteUser(user.id))
}
