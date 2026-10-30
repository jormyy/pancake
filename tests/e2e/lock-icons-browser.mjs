import assert from 'node:assert/strict'
import { execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableli"$/m)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, 'http://127.0.0.1:63721')
const { origin } = JSON.parse(await readFile('../browser-origin.json', 'utf8'))
assert.equal(new URL(origin).port, '63784')
const phase = process.argv[2] ?? 'before'
assert.ok(['before', 'after'].includes(phase))
const output = path.resolve(`../lock-icons-${phase}`)
await mkdir(output, { recursive: true })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const sql = statement => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafableli', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const member = JSON.parse(sql(`SELECT row_to_json(m) FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id WHERE l.deleted_at IS NULL ORDER BY (SELECT count(*) FROM public.roster_players r WHERE r.member_id=m.id) DESC,m.joined_at LIMIT 1;`))
const admin = createClient(stack.API_URL, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `lock-icons-${randomUUID()}@example.invalid`, password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true }))
const screens = [], errors = [], blockedRequests = []
let browser
try {
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', member.id))
    const auth = createClient(stack.API_URL, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=63789', `--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1`] })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.origin === origin || url.hostname === '127.0.0.1' && url.port.startsWith('637') || ['data:', 'blob:'].includes(url.protocol)) return route.continue()
        blockedRequests.push(url.origin)
        return route.abort()
    })
    await context.addInitScript(({ session, member }) => {
        localStorage.setItem(`sb-${location.hostname.split('.')[0]}-auth-token`, JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${session.user.id}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: member.id }))
    }, { session, member })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    const capture = async name => {
        for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('pancake-theme', theme) }, theme)
            await promisify(execFile)('node_modules/.bin/agent-browser', ['--session', 'fable-ui23', '--cdp', 'http://127.0.0.1:63789', 'screenshot', path.join(output, `${name}-${theme}.png`)])
            screens.push({ name, theme, text: await page.locator('body').innerText(), locks: await page.getByRole('button', { name: /^Locked by a pending/ }).count(), rows: await page.getByTestId('player-row-content').evaluateAll(nodes => nodes.map(node => ({ name: node.textContent, height: node.getBoundingClientRect().height }))) })
        }
        if (phase === 'after' && !name.includes('toast')) assert.ok(await page.getByRole('button', { name: /^Locked by a pending/ }).count() > 0, `${name} includes its reserved assets`)
        if (phase === 'after') assert.doesNotMatch(await page.locator('body').innerText(), /Locked by (trade|waiver claim) [a-f0-9]|Resolve the trade|Cancel the trade to change/)
    }
    for (const name of ['lineup', 'roster', 'league-picks']) {
        await page.goto(`${origin}/${name === 'league-picks' ? 'league?tab=picks' : 'roster'}`, { waitUntil: 'networkidle' })
        if (name === 'lineup') {
            await page.getByRole('button', { name: 'Open auto-set lineup options', exact: true }).click()
            await page.getByRole('button', { name: 'Edit lineup manually', exact: true }).click()
            await page.waitForURL('**/lineup')
        }
        await page.waitForTimeout(1500)
        await capture(name)
    }
    await page.goto(`${origin}/trades?tab=analyzer`, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /^Analyze with / }).first().click()
    await page.waitForTimeout(1500)
    const player = page.getByRole('button', { name: /^Select .* for trade$/ }).filter({ hasText: 'Jeremiah Fears' }).first()
    if (await player.count()) await player.scrollIntoViewIfNeeded()
    await capture('trade-players')
    const pick = page.getByRole('button', { name: /^Select .*Round .*pick via .* for trade$/ }).first()
    await pick.scrollIntoViewIfNeeded()
    await capture('trade-picks')
    if (phase === 'after') {
        const icon = page.getByRole('button', { name: 'Locked by a pending trade', exact: true }).last()
        await icon.scrollIntoViewIfNeeded()
        assert.equal(await icon.isEnabled(), true)
        await icon.click()
        await page.getByText('Locked by a pending trade', { exact: true }).waitFor()
        await capture('lock-toast')
        for (const dismiss of await page.getByRole('button', { name: 'Dismiss', exact: true }).all()) await dismiss.click()
        const bounds = await icon.boundingBox()
        assert.ok(bounds)
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        await page.mouse.down()
        await page.waitForTimeout(650)
        await page.mouse.up()
        await page.getByText('Locked by a pending trade', { exact: true }).waitFor()
        for (const dismiss of await page.getByRole('button', { name: 'Dismiss', exact: true }).all()) await dismiss.click()
        await page.goto(`${origin}/roster`, { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: 'Open Jeremiah Fears', exact: true }).click({ position: { x: 12, y: 12 } })
        assert.equal(await page.getByRole('button', { name: 'Drop Jeremiah Fears', exact: true }).isDisabled(), true)
        await page.getByRole('button', { name: 'Explain unavailable Drop player', exact: true }).click()
        await page.getByText('Locked by a pending trade', { exact: true }).waitFor()
        await capture('disabled-drop-toast')
    }
    assert.deepEqual(errors, [])
} finally {
    if (browser) await browser.close()
    await checked(admin.from('league_members').update({ user_id: member.user_id }).eq('id', member.id))
    await checked(admin.auth.admin.deleteUser(user.id))
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ phase, screens, errors, blockedRequests }, null, 2))
}
