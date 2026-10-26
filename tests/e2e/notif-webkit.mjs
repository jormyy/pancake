import { strict as assert } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { webkit } from 'playwright'
import { createClient } from '@supabase/supabase-js'

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
const admin = createClient(api, secret, { auth: { persistSession: false, autoRefreshToken: false } })
const league = randomUUID(), member = randomUUID()
let userId
async function query(operation) {
    const { data, error } = await operation
    assert.equal(error, null)
    return data
}
await mkdir(path.join(evidence, 'screenshots'), { recursive: true })
const browser = await webkit.launch({ headless: true })
const report = []
try {
    const email = `${randomUUID()}@example.test`, password = randomUUID()
    const created = await query(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `notif${randomUUID().replaceAll('-', '').slice(0, 12)}` } }))
    userId = created.user.id
    await query(admin.from('leagues').insert({ id: league, name: 'Notification WebKit', slug: league, commissioner_id: userId, status: 'offseason' }))
    await query(admin.from('league_members').insert({ id: member, league_id: league, user_id: userId, role: 'commissioner', team_name: 'WebKit Team' }))
    await query(admin.from('league_seasons').insert({ league_id: league, season_year: 2026, is_current: true }))
    const client = createClient(api, publicKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const signed = await query(client.auth.signInWithPassword({ email, password }))
    for (const viewport of [{ name: 'iphone', width: 393, height: 852, mobile: true }, { name: 'desktop', width: 1440, height: 900, mobile: false }]) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: viewport.mobile ? 3 : 1, isMobile: viewport.mobile, hasTouch: viewport.mobile })
        try {
            await context.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), { key: `sb-${new URL(api).hostname.split('.')[0]}-auth-token`, session: signed.session })
            const page = await context.newPage()
            const errors = []
            page.on('pageerror', error => errors.push(error.message))
            await page.goto(`${origin}/commissioner-settings`)
            let publishTaps = 0
            const composer = page.getByRole('textbox', { name: 'League announcement', exact: true })
            await composer.click()
            publishTaps++
            await composer.fill(`WebKit ${viewport.name}`)
            await page.getByRole('button', { name: 'Publish announcement', exact: true }).click()
            publishTaps++
            await page.getByRole('status').filter({ hasText: 'Published' }).waitFor()
            await page.screenshot({ path: path.join(evidence, 'screenshots', `${viewport.name}-announcement.png`) })
            const geometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollWidth: document.documentElement.scrollWidth }))
            assert.ok(geometry.scrollWidth <= viewport.width)
            assert.equal(geometry.dpr, viewport.mobile ? 3 : 1)
            assert.deepEqual(errors, [])
            report.push({ viewport: viewport.name, publishTaps, textEntryPerTask: 1, geometry })
        } finally { await context.close() }
    }
    await writeFile(path.join(evidence, 'tap-counts.json'), JSON.stringify({ provenance: 'SYNTHETIC', engine: 'Playwright WebKit', report }, null, 2))
} finally {
    await browser.close()
    await admin.from('leagues').delete().eq('id', league)
    if (userId) await admin.auth.admin.deleteUser(userId)
}
console.log(JSON.stringify({ provenance: 'SYNTHETIC', engine: 'Playwright WebKit', report }))
