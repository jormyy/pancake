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
const output = path.resolve('../dynasty-points-header')
await mkdir(output, { recursive: true })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const sql = statement => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafableli', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const member = JSON.parse(sql(`SELECT row_to_json(m) FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id WHERE l.deleted_at IS NULL ORDER BY (SELECT count(*) FROM public.roster_players r WHERE r.member_id=m.id) DESC,m.joined_at LIMIT 1;`))
const admin = createClient(stack.API_URL, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `dynasty-points-${randomUUID()}@example.invalid`, password = randomUUID()
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
    await page.route('**/views/player?*', async route => {
        const response = await route.fetch()
        const body = await response.json()
        const view = body.view ?? body.data ?? body
        assert.ok(view.player)
        view.player.five_year_points = 3.9
        view.player.three_year_points = 4.1
        await route.fulfill({ response, json: body })
    })
    const playerId = sql(`SELECT player_id FROM public.roster_players WHERE member_id='${member.id}' ORDER BY id LIMIT 1;`)
    await page.goto(`${origin}/player/${playerId}`, { waitUntil: 'networkidle' })
    await page.getByText('5yr: 3.9', { exact: true }).waitFor()
    await page.getByText('3yr: 4.1', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('5-year points 3.9', { exact: true }).count(), 1)
    assert.equal(await page.getByLabel('3-year points 4.1', { exact: true }).count(), 1)
    for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('pancake-theme', theme) }, theme)
        await promisify(execFile)('node_modules/.bin/agent-browser', ['--session', 'fable-ui23', '--cdp', 'http://127.0.0.1:63789', 'screenshot', path.join(output, `player-header-${theme}.png`)])
        const summary = await page.getByTestId('player-summary-line').evaluate(node => {
            const bounds = node.getBoundingClientRect()
            return { text: node.textContent, left: bounds.left, right: bounds.right, width: innerWidth }
        })
        assert.ok(summary.left >= 0 && summary.right <= summary.width)
        assert.doesNotMatch(summary.text, /[35]-year points/)
        screens.push({ theme, summary })
    }
    assert.deepEqual(errors, [])
} finally {
    if (browser) await browser.close()
    await checked(admin.from('league_members').update({ user_id: member.user_id }).eq('id', member.id))
    await checked(admin.auth.admin.deleteUser(user.id))
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ fixture: { fiveYear: 3.9, threeYear: 4.1 }, screens, errors, blockedRequests }, null, 2))
}
