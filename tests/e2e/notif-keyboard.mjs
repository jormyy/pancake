import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, webkit } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { createBrowser, listBrowserSessions } from './browser-agent.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    assert.ok(arg.startsWith('--') && arg.includes('='), 'Use --name=value')
    const split = arg.indexOf('=')
    return [arg.slice(2, split), arg.slice(split + 1)]
}))
for (const key of Object.keys(args)) assert.ok(['frontend-url', 'frontend-port', 'api-port', 'db-port', 'build-sha', 'engines', 'cycles', 'output-dir'].includes(key), `Unknown option ${key}`)
const dbPort = Number(args['db-port'] ?? process.env.PANCAKE_TEST_DB_PORT ?? 54322)
const apiPort = Number(args['api-port'] ?? dbPort - 1)
const frontendPort = Number(args['frontend-port'] ?? new URL(process.env.E2E_FRONTEND_URL ?? 'http://127.0.0.1:8082').port)
const origin = args['frontend-url'] ?? process.env.E2E_FRONTEND_URL ?? `http://127.0.0.1:${frontendPort}`
const api = process.env.E2E_SUPABASE_URL ?? process.env.SUPABASE_URL
const secret = process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY ?? process.env.PANCAKE_SUPABASE_SECRET_KEY
const publicKey = process.env.E2E_SUPABASE_PUBLISHABLE_KEY ?? process.env.PANCAKE_SUPABASE_PUBLISHABLE_KEY
const evidence = args['output-dir'] ?? process.env.NOTIF_EVIDENCE
const engines = (args.engines ?? 'chromium,webkit').split(',')
const cycles = Number(args.cycles ?? 2)
assert.ok(api && secret && publicKey && evidence)
assert.ok(Number.isInteger(cycles) && cycles > 0)
for (const engine of engines) assert.ok(['chromium', 'webkit'].includes(engine))
for (const { url, port } of [{ url: api, port: apiPort }, { url: origin, port: frontendPort }]) {
    const parsed = new URL(url)
    assert.ok(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && Number(parsed.port) === port)
}
assert.ok(path.isAbsolute(evidence) && !evidence.startsWith(process.cwd() + path.sep))
await mkdir(evidence, { recursive: true })
const release = await fetch(`${origin}/release-provenance.json`).then(async response => { assert.equal(response.status, 200); return response.json() })
if (args['build-sha']) assert.equal(release.commitSha, args['build-sha'])
const admin = createClient(api, secret, { auth: { persistSession: false, autoRefreshToken: false } })
async function query(operation) {
    const { data, error } = await operation
    assert.equal(error, null)
    return data
}
const failures = [], report = []
let userId
const browser = createBrowser({ cwd: process.cwd() })
const sessionName = `notif-keyboard-${process.pid}-${randomUUID().slice(0, 8)}`
let agentOpened = false, cdp
async function target(engine, storage) {
    if (engine === 'chromium') {
        await listBrowserSessions({ cwd: process.cwd() })
        agentOpened = true
        await browser(sessionName, ['open', origin])
        const endpoint = (await browser(sessionName, ['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
        assert.ok(endpoint)
        cdp = await chromium.connectOverCDP(endpoint)
        const context = await cdp.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: storage })
        return { context, close: () => context.close() }
    }
    const launched = await webkit.launch({ headless: true })
    const context = await launched.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, storageState: storage })
    return { context, close: async () => { await context.close(); await launched.close() } }
}
await runWithScenarioResourceOwner('notification keyboard', async () => {
try {
    const email = `notif-keyboard-${randomUUID()}@example.test`, password = randomUUID()
    userId = (await query(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `notif${randomUUID().replaceAll('-', '').slice(0, 12)}` } }))).user.id
    const client = createClient(api, publicKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const signed = await query(client.auth.signInWithPassword({ email, password }))
    const storage = { cookies: [], origins: [{ origin, localStorage: [
        { name: `sb-${new URL(api).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(signed.session) },
        { name: 'PANCAKE_SUPABASE_URL', value: api }, { name: 'PANCAKE_SUPABASE_PUBLIC_KEY', value: publicKey },
    ] }] }
    for (const engine of engines) {
        const opened = await target(engine, storage)
        try {
            await opened.context.route('**/*', route => {
                const url = new URL(route.request().url())
                if (![new URL(origin).origin, new URL(api).origin, new URL(process.env.E2E_API_BASE_URL ?? `${api}/functions/v1/api`).origin].includes(url.origin)) return route.abort('blockedbyclient')
                return route.continue()
            })
            const page = await opened.context.newPage(), errors = []
            page.on('pageerror', error => errors.push(error.message))
            const saves = []
            page.on('request', request => {
                if (request.method() === 'POST' && new URL(request.url()).pathname === '/rest/v1/notification_preferences') saves.push(request.postDataJSON())
            })
            const controls = [
                { id: 'master', label: 'All notifications', value: row => row.master_enabled },
                { id: 'category', label: 'All trades notifications', value: row => row.category_settings?.trade ?? row.trade_enabled },
                { id: 'event', label: 'Trades: New offer', value: row => row.event_settings?.trade_offered },
            ]
            const scroll = control => control.evaluate(node => {
                const positions = [[window.scrollX, window.scrollY]]
                for (let element = node; element; element = element.parentElement) positions.push([element.scrollLeft, element.scrollTop])
                return positions
            })
            async function tabTo(control) {
                for (let i = 0; i < 160; i++) {
                    await page.keyboard.press('Tab')
                    if (await control.evaluate(node => document.activeElement === node)) return i + 1
                }
                throw Error('Tab cannot reach switch')
            }
            for (let cycle = 1; cycle <= cycles; cycle++) {
                await query(admin.from('notification_preferences').upsert({ user_id: userId, master_enabled: true, trade_enabled: true, waiver_enabled: true, draft_enabled: true, activity_enabled: true, category_settings: {}, event_settings: { trade_offered: true } }))
                await page.goto(`${origin}/notification-settings`)
                await page.getByRole('switch', { name: 'All notifications', exact: true }).waitFor()
                assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]), [393, 852, 3])
                for (const item of controls) {
                    const control = page.getByRole('switch', { name: item.label, exact: true })
                    const tabs = await tabTo(control)
                    for (const [index, action] of ['Space', 'Space', 'Enter', 'Enter', 'click', 'click'].entries()) {
                        if (action !== 'click') assert.ok(await control.evaluate(node => document.activeElement === node), 'Keyboard must operate the Tab-focused switch')
                        const before = await control.getAttribute('aria-checked'), expected = before !== 'true'
                        const position = await scroll(control), saveCount = saves.length
                        const prefix = `${engine}-${cycle}-${item.id}`
                        if (index === 0) await page.screenshot({ path: path.join(evidence, `${prefix}-before-space.png`) })
                        if (action === 'click') await control.click()
                        else await page.keyboard.press(action)
                        await page.waitForTimeout(600)
                        const after = await control.getAttribute('aria-checked')
                        const saved = await query(admin.from('notification_preferences').select('*').eq('user_id', userId).single())
                        const afterPosition = await scroll(control)
                        const result = { engine, cycle, control: item.id, action, tabs, before, after, expected, saved: item.value(saved), writes: saves.length - saveCount, scrollBefore: position, scrollAfter: afterPosition }
                        if (index === 0) await page.screenshot({ path: path.join(evidence, `${prefix}-after-space.png`) })
                        try {
                            assert.equal(after, String(expected), 'aria-checked must flip')
                            assert.equal(item.value(saved), expected, 'Stored preference must flip')
                            assert.equal(result.writes, 1, 'One gesture must save exactly once')
                            if (action === 'Space') assert.deepEqual(afterPosition, position, 'Space must not scroll any ancestor')
                        } catch (error) { result.failure = error.message; failures.push(result) }
                        report.push(result)
                    }
                }
            }
            assert.deepEqual(errors, [], 'No browser runtime errors')
        } finally { await opened.close() }
    }
} finally {
    await writeFile(path.join(evidence, 'keyboard-results.json'), JSON.stringify({ provenance: 'SYNTHETIC', release: { commitSha: release.commitSha, bundleDigest: release.bundleDigest }, failures, report }, null, 2) + '\n')
    if (cdp) await cdp.close()
    cdp = null
    try {
        if (agentOpened) {
            await browser(sessionName, ['close'])
            let sessions = await listBrowserSessions({ cwd: process.cwd() })
            for (let attempt = 0; sessions.includes(sessionName) && attempt < 30; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 100))
                sessions = await listBrowserSessions({ cwd: process.cwd() })
            }
            assert.ok(!sessions.includes(sessionName), 'Owned browser session must close')
        }
    } finally {
        if (userId) await query(admin.auth.admin.deleteUser(userId))
    }
    await writeFile(path.join(evidence, 'keyboard-results.json'), JSON.stringify({ provenance: 'SYNTHETIC', release: { commitSha: release.commitSha, bundleDigest: release.bundleDigest }, failures, report }, null, 2) + '\n')
}
console.log(JSON.stringify({ actions: report.length, failures: failures.length, release: { commitSha: release.commitSha, bundleDigest: release.bundleDigest } }))
assert.deepEqual(failures, [], 'Every keyboard and click action must toggle once, save once and preserve Space scroll position')

})
