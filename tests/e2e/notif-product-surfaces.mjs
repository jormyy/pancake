import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { installRuntimeOverrides } from './browser-runtime-overrides.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { createBrowser, listBrowserSessions, openCdpClient, selectCdpPageTarget } from './browser-agent.mjs'

const api = process.env.E2E_SUPABASE_URL
const secret = process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY
const publicKey = process.env.E2E_SUPABASE_PUBLISHABLE_KEY
const origin = process.env.E2E_FRONTEND_URL
const evidence = process.env.NOTIF_EVIDENCE
assert.ok(api && secret && publicKey && origin && evidence)
assert.ok(path.isAbsolute(evidence) && !evidence.startsWith(process.cwd() + path.sep))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(api).hostname))
assert.equal(new URL(api).port, String(Number(process.env.PANCAKE_TEST_DB_PORT ?? 54322) - 1))
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
assert.ok(path.isAbsolute(evidence))
const admin = createClient(api, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const browser = createBrowser({ cwd: process.cwd() })
const session = `notif-products-${process.pid}`
const league = randomUUID(), member = randomUUID(), player = randomUUID()
const report = []
let userId, cdp
let taps = 0
async function query(operation) {
    const result = await operation
    assert.equal(result.error, null)
    return result.data
}
async function wait(selector) { await browser(session, ['wait', selector], { timeout: 15000 }) }
async function click(label, role = 'button') {
    await browser(session, ['snapshot', '-i'])
    await browser(session, ['find', 'role', role, 'click', '--name', label, '--exact'])
    taps++
}
const parse = value => {
    const last = JSON.parse(value.split('\n').filter(Boolean).at(-1))
    return typeof last === 'string' ? JSON.parse(last) : last
}
await runWithScenarioResourceOwner('notification product surfaces', async () => {
    try {
        await listBrowserSessions({ cwd: process.cwd() })
        await mkdir(path.join(evidence, 'screenshots'), { recursive: true })
        const email = `${randomUUID()}@example.test`, password = randomUUID()
        const created = await query(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `notif${randomUUID().replaceAll('-', '').slice(0, 12)}` } }))
        userId = created.user.id
        await query(admin.from('leagues').insert({ id: league, name: 'Notification UI', slug: league, commissioner_id: userId, status: 'offseason' }))
        await query(admin.from('league_members').insert({ id: member, league_id: league, user_id: userId, role: 'commissioner', team_name: 'Notification Team' }))
        await query(admin.from('league_seasons').insert({ league_id: league, season_year: 2026, is_current: true }))
        await query(admin.from('players').insert({ id: player, first_name: 'Watch', last_name: 'Fixture', position: 'PG', eligible_positions: ['PG'], nba_team: 'BOS' }))
        const client = createClient(api, publicKey, { auth: { persistSession: false, autoRefreshToken: false } })
        const auth = await query(client.auth.signInWithPassword({ email, password }))
        await installRuntimeOverrides(browser, session, { frontendUrl: `${origin}/sign-in`, apiBaseUrl: process.env.E2E_API_BASE_URL, supabaseUrl: api, anonKey: publicKey })
        await browser(session, ['eval', `localStorage.setItem('sb-${new URL(api).hostname.split('.')[0]}-auth-token',${JSON.stringify(JSON.stringify(auth.session))}); true`])
        for (const viewport of [{ name: 'iphone', width: 393, height: 852, mobile: true }, { name: 'desktop', width: 1440, height: 900, mobile: false }]) {
            const endpoint = (await browser(session, ['get', 'cdp-url'])).match(/ws:\/\/\S+/)?.[0]
            assert.ok(endpoint)
            cdp?.close()
            cdp = await openCdpClient(endpoint)
            const { targetInfos } = await cdp.send('Target.getTargets')
            const target = selectCdpPageTarget(targetInfos)
            const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
            await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.mobile ? 3 : 1, mobile: viewport.mobile }, sessionId)
            await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: viewport.mobile ? 59 : 0, bottom: viewport.mobile ? 34 : 0, left: 0, right: 0 } }, sessionId)
            console.log('Players ' + viewport.name)
            await browser(session, ['open', `${origin}/players`])
            await wait('[aria-label="Search players"]')
            await browser(session, ['fill', '[aria-label="Search players"]', 'Watch Fixture'])
            await browser(session, ['wait', '700'])
            await browser(session, ['snapshot', '-i'])
            taps = 0
            await browser(session, ['find', 'text', 'Watch Fixture', 'click', '--exact'])
            taps++
            await wait('[aria-label="Watch player for drops"]:not([aria-disabled="true"])')
            await click('Watch player for drops', 'switch')
            await wait('[aria-label="Watch player for drops"][aria-checked="true"]')
            const watches = await query(admin.from('player_watches').select('player_id').eq('member_id', member))
            assert.equal(watches.length, 1)
            await browser(session, ['screenshot', path.join(evidence, 'screenshots', `${viewport.name}-watch.png`)], { timeout: 60000 })
            report.push({ viewport: viewport.name, task: 'Watch player from searched Players list', taps, textEntry: 1 })
            await click('Watch player for drops', 'switch')
            await wait('[aria-label="Watch player for drops"][aria-checked="false"]')
            await browser(session, ['open', `${origin}/commissioner-settings`])
            await wait('[aria-label="League announcement"]')
            taps = 0
            await browser(session, ['snapshot', '-i'])
            await browser(session, ['click', '[aria-label="League announcement"]'])
            taps++
            await browser(session, ['fill', '[aria-label="League announcement"]', `Announcement for ${viewport.name}`])
            await click('Publish announcement')
            await wait('[role="status"]')
            assert.equal(parse(await browser(session, ['eval', `JSON.stringify(document.querySelector('[role="status"]').textContent)`])), 'Published')
            const announcements = await query(admin.from('league_announcements').select('id').eq('league_id', league))
            assert.equal(announcements.length, report.filter(row => row.task === 'Publish announcement from league settings').length + 1)
            await browser(session, ['screenshot', path.join(evidence, 'screenshots', `${viewport.name}-announcement.png`)], { timeout: 60000 })
            const geometry = parse(await browser(session, ['eval', `JSON.stringify({ width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scrollWidth:document.documentElement.scrollWidth,buttons:[...document.querySelectorAll('[aria-label="League announcement"],[aria-label="Publish announcement"]')].map(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})})`]))
            assert.equal(geometry.width, viewport.width)
            assert.equal(geometry.dpr, viewport.mobile ? 3 : 1)
            assert.ok(geometry.scrollWidth <= viewport.width)
            assert.ok(geometry.buttons.every(r => r.x >= 0 && r.x + r.width <= viewport.width && r.height >= 44))
            report.push({ viewport: viewport.name, task: 'Publish announcement from league settings', taps, textEntry: 1, geometry })
        }
        await writeFile(path.join(evidence, 'tap-counts.json'), JSON.stringify({ provenance: 'SYNTHETIC', report }, null, 2))
        await writeFile(path.join(evidence, 'console.log'), await browser(session, ['console']))
        await writeFile(path.join(evidence, 'errors.log'), await browser(session, ['errors']))
    } catch (error) {
        await writeFile(path.join(evidence, 'failure.snapshot.txt'), await browser(session, ['snapshot']).catch(() => 'Unavailable'))
        await writeFile(path.join(evidence, 'failure.errors.log'), await browser(session, ['errors']).catch(() => 'Unavailable'))
        throw error
    } finally {
        cdp?.close()
        await browser(session, ['close']).catch(() => undefined)
        await admin.from('leagues').delete().eq('id', league)
        await admin.from('players').delete().eq('id', player)
        if (userId) await admin.auth.admin.deleteUser(userId)
        await new Promise(resolve => setTimeout(resolve, 500))
        assert.ok(!(await listBrowserSessions({ cwd: process.cwd() })).includes(session))
    }
})
console.log(JSON.stringify({ provenance: 'SYNTHETIC', report }))
