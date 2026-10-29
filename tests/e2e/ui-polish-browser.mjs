import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'

assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafableup"$/m)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, 'http://127.0.0.1:62821')
const { origin } = JSON.parse(await readFile('../browser-origin.json', 'utf8'))
assert.equal(new URL(origin).port, '62884')
const phase = process.argv[2] ?? 'before'
assert.ok(['before', 'cache-before', 'after'].includes(phase))
const output = path.resolve(`../ui-polish-${phase}`)
await mkdir(output, { recursive: true })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const sql = statement => execFileSync('docker', ['exec', '-i', 'supabase_db_pt4bafableup', 'psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const member = JSON.parse(sql(`SELECT row_to_json(m) FROM public.league_members m JOIN public.leagues l ON l.id=m.league_id WHERE l.deleted_at IS NULL ORDER BY (SELECT count(*) FROM public.roster_players r WHERE r.league_id=l.id) DESC,m.joined_at LIMIT 1;`))
const admin = createClient(stack.API_URL, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const email = `ui-polish-${randomUUID()}@example.invalid`, password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'UI polish check' } }))
const requests = [], screens = [], errors = []
await writeFile('../ui-polish-member.json', JSON.stringify({ memberId: member.id, originalUserId: member.user_id, testUserId: user.id }))
let browser
try {
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', member.id))
    const auth = createClient(stack.API_URL, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    browser = await chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1`] })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, serviceWorkers: 'block' })
    await context.route('**/*', route => {
        const url = new URL(route.request().url())
        return url.origin === origin || url.hostname === '127.0.0.1' && url.port.startsWith('628') || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort()
    })
    await context.addInitScript(({ session, member }) => {
        localStorage.setItem(`sb-${location.hostname.split('.')[0]}-auth-token`, JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${session.user.id}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: member.id }))
    }, { session, member })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', async response => {
        const request = response.request()
        const url = new URL(request.url())
        if (/\/(estimate|revalue)$/.test(url.pathname)) requests.push({ path: url.pathname, body: request.postDataJSON(), status: response.status(), response: await response.json(), at: Date.now() })
    })
    for (const route of ['lineup', 'bracket']) {
        if (route === 'lineup') {
            await page.goto(`${origin}/roster`, { waitUntil: 'networkidle' })
            await page.getByRole('button', { name: 'Open auto-set lineup options', exact: true }).click()
            await page.getByRole('button', { name: 'Edit lineup manually', exact: true }).click()
            await page.waitForURL('**/lineup')
        } else await page.goto(`${origin}/${route}`, { waitUntil: 'networkidle' })
        await page.waitForTimeout(1500)
        if (phase === 'after') {
            const label = route === 'lineup' ? 'Back to lineup' : 'Back to league standings'
            await page.getByRole('button', { name: label, exact: true }).waitFor()
            const header = page.getByTestId(route === 'lineup' ? 'page-header-compact' : 'page-header-standard')
            assert.match(await header.innerText(), route === 'lineup' ? /Week \d+ lineup/ : /Playoffs/)
            if (route === 'bracket') assert.equal(await header.evaluate(node => getComputedStyle(node).borderBottomWidth), '0px')
        }
        for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => { document.documentElement.setAttribute('data-theme', theme); localStorage.setItem('pancake-theme', theme) }, theme)
            await page.screenshot({ path: path.join(output, `${route}-${theme}.png`) })
            screens.push({ route, theme, text: (await page.locator('body').innerText()).slice(0, 3500), headers: await page.locator('[data-testid^="page-header-"]').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, borderBottomWidth: getComputedStyle(node).borderBottomWidth, top: node.getBoundingClientRect().top, height: node.getBoundingClientRect().height }))) })
        }
        if (phase === 'after') {
            await page.getByRole('button', { name: route === 'lineup' ? 'Back to lineup' : 'Back to league standings', exact: true }).click()
            await page.waitForURL(route === 'lineup' ? '**/roster' : '**/league?tab=results')
        }
    }
    await page.goto(`${origin}/trades?tab=analyzer`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1200)

    const team = page.getByRole('button', { name: /^Analyze with / }).first()
    await team.click()
    await page.waitForTimeout(1200)


    const select = page.getByRole('button', { name: /^Select .* for trade$/ }).filter({ hasNotText: 'Round' })
    const captureAnalysis = async name => {
        for (const theme of ['light', 'dark']) {
            await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
            await page.screenshot({ path: path.join(output, `${name}-${theme}.png`) })
        }
        screens.push({ route: name, url: page.url(), text: await page.locator('body').innerText() })
    }
    let response = page.waitForResponse(response => response.url().endsWith('/trades/estimate'))
    await select.nth(0).click()
    const initialQuote = (await (await response).json()).quote
    await page.waitForTimeout(500)
    await page.getByRole('button', { name: 'View trade analysis', exact: true }).click()
    await captureAnalysis('analyzer-initial')
    console.log('INITIAL', (await page.locator('body').innerText()).slice(-3000))
    await page.getByRole('button', { name: 'Edit assets', exact: true }).click()
    await page.route('**/trades/estimate', async route => { await new Promise(resolve => setTimeout(resolve, 600)); await route.continue() })
    response = page.waitForResponse(response => response.url().endsWith('/trades/estimate'))
    const startedAt = Date.now()
    await select.nth(1).click()
    const view = page.getByRole('button', { name: 'View trade analysis', exact: true })
    if (await view.isEnabled()) await view.click()
    await page.waitForTimeout(400)
    if (phase === 'after') await page.getByLabel('Updating trade values', { exact: true }).waitFor()
    await captureAnalysis('analyzer-changed-pending')
    const changedQuote = (await (await response).json()).quote
    assert.notEqual(changedQuote.id, initialQuote.id)
    assert.notEqual(changedQuote.inputVersion, initialQuote.inputVersion)
    assert.ok(changedQuote.analysis.teams.reduce((total, team) => total + team.valuesReceived, 0) > initialQuote.analysis.teams.reduce((total, team) => total + team.valuesReceived, 0))
    await page.waitForTimeout(300)
    if (await view.isVisible()) await view.click()
    await captureAnalysis('analyzer-changed-fresh')
    screens.push({ route: 'analyzer-timing', elapsedMs: Date.now() - startedAt, observationDelayMs: 600 })
    console.log('CHANGED', (await page.locator('body').innerText()).slice(-3000))
    const revalue = page.getByRole('button', { name: 'Revalue trade analysis', exact: true })
    if (await revalue.count()) {
        response = page.waitForResponse(response => response.url().endsWith('/trades/estimate'))
        await revalue.click()
        await captureAnalysis('analyzer-revalue-pending')
        await response
        await page.waitForTimeout(300)
        await captureAnalysis('analyzer-revalue-fresh')
    }

    const tradeId = sql(`SELECT id FROM public.trades WHERE league_id='${member.league_id}' AND status='accepted' ORDER BY proposed_at LIMIT 1;`)
    assert.ok(tradeId)
    const openSaved = async name => {
        await page.goto(`${origin}/trades?tab=history&tradeId=${tradeId}`, { waitUntil: 'networkidle' })
        await page.getByRole('button', { name: 'Revalue this trade with current inputs', exact: true }).waitFor({ timeout: 8000 })
        await captureAnalysis(`${name}-details`)
        const control = page.getByRole('button', { name: 'Revalue this trade with current inputs', exact: true })
        if (await control.isDisabled()) {
            screens.push({ route: 'saved-revalue-disabled', requestsSent: requests.filter(request => request.path.endsWith('/revalue')).length })
            assert.equal(phase, 'before', 'Revalue is enabled independently from mutation snapshot gates')
            return false
        }
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith(`/trades/${tradeId}/revalue`), { timeout: 8000 }),
            page.getByRole('button', { name: 'Revalue this trade with current inputs', exact: true }).click({ timeout: 4000 }).then(async () => console.log('SAVED CLICKED', page.url(), (await page.locator('body').innerText()).slice(0, 500))),
        ]).catch(async error => { await captureAnalysis(`${name}-error`); console.log('SAVED ERROR STATE', await page.locator('body').innerText()); throw error })
        await page.waitForTimeout(500)
        await captureAnalysis(name)
        return true
    }
    const savedOpened = await openSaved('analyzer-saved-fresh')
    if (savedOpened) {
    sql(`UPDATE public.trade_value_cache SET revaluation=jsonb_set(revaluation,'{expiresAt}',to_jsonb((now()-interval '1 minute')::text)) WHERE trade_id='${tradeId}';`)
    await openSaved('analyzer-saved-expired')
    console.log('SAVED EXPIRED', (await page.locator('body').innerText()).slice(-3000))
    if (phase === 'after') {
        assert.equal(await page.getByText('Trade estimate expired. Try again.', { exact: true }).count(), 0)
        await page.getByLabel('Dynasty trade analysis', { exact: true }).waitFor()
        assert.equal(errors.length, 0)
    }
    }
} finally {
    if (browser) await browser.close()
    await checked(admin.from('league_members').update({ user_id: member.user_id }).eq('id', member.id))
    await checked(admin.auth.admin.deleteUser(user.id))
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ phase, memberId: member.id, leagueId: member.league_id, screens, requests, errors }, null, 2))
}
