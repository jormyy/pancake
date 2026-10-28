import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { chromium, webkit, devices } from 'playwright'

const api = 'http://127.0.0.1:59521'
const frontend = 'http://127.0.0.1:59590'
const league = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const member = '6d9faceb-6d4a-479b-ace7-ac65a73fc982'
const matchup = '9e002ea0-c1d7-40f1-bca6-4afea03eb931'
const output = path.resolve(process.env.PANCAKE_LAYOUT_OUTPUT ?? '../screenshots')
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8' }))
assert.equal(stack.API_URL, api)
assert.match(execFileSync('git', ['diff', '--', 'supabase/config.toml'], { encoding: 'utf8' }), /pt4bafableub/)
const admin = createClient(api, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
await mkdir(output, { recursive: true })
const saved = await checked(admin.from('matchup_forecasts').select('forecast').eq('matchup_id', matchup).single())
await writeFile(path.join(output, 'saved-forecast.json'), JSON.stringify(saved.forecast, null, 2))
execFileSync('psql', ['postgresql://postgres:postgres@127.0.0.1:59522/postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-c', `UPDATE private.matchup_forecast_queue SET dirty=false; UPDATE private.matchup_forecast_queue SET dirty=true, available_at=now(), claimed_at=NULL, claim_token=NULL WHERE matchup_id='${matchup}';`], { stdio: 'pipe' })
const workerResponse = await fetch(`${api}/functions/v1/matchup-forecast`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-internal-function-token': 'pancake-local-edge-auth-probe-token' }, body: '{}' })
const worker = await workerResponse.json()
assert.equal(workerResponse.ok, true, JSON.stringify(worker))
assert.equal(worker.completed, 1)
const published = await checked(admin.from('matchup_forecasts').select('forecast').eq('matchup_id', matchup).single())
const justin = published.forecast.teams.find(team => team.memberId === member)
assert.equal(typeof justin.projectedFinal, 'number')
assert.equal(typeof justin.winProbability, 'number')
assert.equal(published.forecast.status, 'available')
assert.ok(published.forecast.games.some(game => game.source === 'Recent games'))
await writeFile(path.join(output, 'worker-forecast.json'), JSON.stringify({ worker, forecast: published.forecast }, null, 2))
const actor = (await checked(admin.from('league_members').select('id,user_id').eq('league_id', league).neq('id', member).neq('id', 'a0886fc8-37ba-4fe7-bec7-8a58c3c330c3').limit(1)))[0]
const email = `matchup-${randomUUID()}@example.invalid`
const password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Layout check' } }))
let browser
try {
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', actor.id))
    const auth = createClient(api, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    const routeUrl = `${api}/functions/v1/api/views/home?leagueId=${league}&memberId=${actor.id}&params=${encodeURIComponent(JSON.stringify({ matchupId: matchup }))}`
    const routeResponse = await fetch(routeUrl, { headers: { Authorization: `Bearer ${session.access_token}` } })
    const routeView = await routeResponse.json()
    assert.equal(routeResponse.ok, true, JSON.stringify(routeView))
    assert.deepEqual(routeView.view.forecast.teams, published.forecast.teams)
    await writeFile(path.join(output, 'view-forecast.json'), JSON.stringify({ route: '/views/home', matchupId: matchup, teams: routeView.view.forecast.teams }, null, 2))
    browser = await webkit.launch()
    const context = await browser.newContext({ ...devices['iPhone 14'], serviceWorkers: 'block' })
    let scenario = null
    await context.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (!(['127.0.0.1', 'localhost'].includes(url.hostname) && ['59521', '59590'].includes(url.port)) && !['data:', 'blob:'].includes(url.protocol)) return route.abort()
        if (scenario !== null && url.pathname.endsWith('/views/home')) {
            const response = await route.fetch()
            const body = await response.json()
            const view = body.view
            if (view?.forecast) view.forecast.teams = view.forecast.teams.map(team => {
                const left = team.memberId === view.matchup.myMemberId
                return { ...team, projectedFinal: left ? 1199 : 342, winProbability: left ? scenario : 1 - scenario }
            })
            return route.fulfill({ response, json: body })
        }
        return route.continue()
    })
    await context.addInitScript(({ session, userId, actorId }) => {
        localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${userId}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: actorId }))
    }, { session, userId: user.id, actorId: actor.id })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const records = []
    const visit = async url => {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.getByTestId('matchup-forecast').waitFor()
    }
    const clearViews = () => page.evaluate(() => {
        for (const key of Object.keys(localStorage)) if (key !== 'sb-127-auth-token' && !key.startsWith('pancake:selected-league:')) localStorage.removeItem(key)
    })
    const inspect = async label => {
        const header = page.getByTestId('matchup-forecast')
        await header.waitFor()
        const geometry = await header.evaluate(node => {
            const children = Array.from(node.children).map(child => {
                const box = child.getBoundingClientRect()
                const style = getComputedStyle(child)
                return { text: child.textContent, x: box.x, right: box.right, y: box.y, height: box.height, width: box.width, font: parseFloat(style.fontSize), clipped: child.scrollWidth > child.clientWidth }
            })
            const bar = node.querySelector('[data-testid="matchup-probability-bar"]')
            return { viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, children, portions: Array.from(bar.children).map(part => ({ width: part.getBoundingClientRect().width, color: getComputedStyle(part).backgroundColor })) }
        })
        assert.equal(geometry.overflow, false)
        assert.equal(geometry.children.length, 5)
        assert.ok(geometry.children[0].x >= 0)
        assert.ok(geometry.children[4].right <= geometry.viewport)
        for (let index = 0; index < geometry.children.length; index++) {
            const child = geometry.children[index]
            assert.equal(child.clipped, false, `${label}: clipped ${child.text}`)
            if (index !== 2) { assert.ok(child.font >= 11); assert.ok(child.height <= 16) }
            if (index > 0) assert.ok(child.x - geometry.children[index - 1].right >= 3.5, `${label}: overlapping items`)
        }
        assert.ok(geometry.children[2].width >= 16)
        if (scenario !== null) {
            const sum = geometry.portions.reduce((total, part) => total + part.width, 0)
            assert.ok(Math.abs(geometry.portions[0].width / sum - scenario) < 0.015)
            assert.deepEqual(geometry.portions.map(part => part.color), scenario >= 0.5 ? ['rgb(47, 122, 91)', 'rgb(220, 38, 38)'] : ['rgb(220, 38, 38)', 'rgb(47, 122, 91)'])
        }
        const box = await header.boundingBox()
        await page.screenshot({ path: path.join(output, `${label}.png`), clip: { x: 0, y: Math.max(0, box.y - 150), width: geometry.viewport, height: Math.min(844, box.y + box.height + 28) - Math.max(0, box.y - 150) } })
        records.push({ label, ...geometry })
    }
    for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 })
        scenario = null
        if (page.url().startsWith(frontend)) await clearViews()
        await visit(`${frontend}/matchup?matchupId=${matchup}`)
        await page.getByTestId('matchup-projection-right').filter({ hasText: `${Math.round(justin.projectedFinal)} proj` }).waitFor()
        await inspect(`justin-${width}`)
        for (const probability of [0.68, 0.5, 0.95]) {
            scenario = probability
            await clearViews()
            await visit(`${frontend}/matchup?matchupId=${matchup}`)
            await page.getByTestId('matchup-odds-left').filter({ hasText: `${Math.round(probability * 100)}% win` }).waitFor()
            await inspect(`detail-${width}-${Math.round(probability * 100)}`)
            await clearViews()
            await visit(frontend)
            await page.getByTestId('matchup-odds-left').filter({ hasText: `${Math.round(probability * 100)}% win` }).waitFor()
            await inspect(`home-${width}-${Math.round(probability * 100)}`)
        }
    }
    scenario = null
    await page.setViewportSize({ width: 390, height: 844 })
    await clearViews()
    await visit(`${frontend}/matchup?matchupId=${matchup}`)
    const selected = page.getByTestId('other-matchups').locator('[aria-current="true"]')
    await selected.scrollIntoViewIfNeeded()
    assert.equal(await selected.count(), 1)
    const borders = await page.getByTestId('other-matchups').locator('[role="button"]').evaluateAll(nodes => nodes.map(node => ({ selected: node.getAttribute('aria-current'), width: getComputedStyle(node).borderTopWidth, color: getComputedStyle(node).borderTopColor })))
    assert.equal(borders.find(row => row.selected === 'true').width, '2px')
    assert.ok(borders.filter(row => row.selected !== 'true').every(row => row.width === '1px'))
    await page.screenshot({ path: path.join(output, 'current-matchup-outline.png') })
    assert.deepEqual(pageErrors, [])
    await writeFile(path.join(output, 'layout-evidence.json'), JSON.stringify({ records, borders, pageErrors }, null, 2))
    const cli = path.resolve('node_modules/.bin/agent-browser')
    const browserSession = `matchup-${randomUUID()}`
    const runBrowser = args => execFileSync(cli, ['--session', browserSession, ...args], { encoding: 'utf8', timeout: 60000 })
    try {
        runBrowser(['--executable-path', chromium.executablePath(), '--allowed-domains', '127.0.0.1,localhost', 'open', frontend])
        runBrowser(['eval', `(() => { localStorage.setItem('sb-127-auth-token', ${JSON.stringify(JSON.stringify(session))}); localStorage.setItem('pancake:selected-league:v1:${user.id}', ${JSON.stringify(JSON.stringify({ version: 1, savedAt: Date.now(), value: actor.id }))}); return true })()`])
        runBrowser(['set', 'viewport', '390', '844'])
        runBrowser(['open', `${frontend}/matchup?matchupId=${matchup}`])
        runBrowser(['wait', '--text', `${Math.round(justin.projectedFinal)} proj`])
        const snapshot = runBrowser(['snapshot'])
        assert.ok(snapshot.includes(`${Math.round(justin.projectedFinal)} proj`))
        await writeFile(path.join(output, 'agent-browser-snapshot.txt'), snapshot)
        runBrowser(['screenshot', path.join(output, 'agent-browser-justin-390.png')])
    } catch {
        throw new Error('The separate agent-browser check failed.')
    } finally {
        runBrowser(['close'])
        const deadline = Date.now() + 5000
        let sessions = ''
        do {
            sessions = execFileSync(cli, ['session', 'list'], { encoding: 'utf8' })
            if (!sessions.includes(browserSession)) break
            await delay(100)
        } while (Date.now() < deadline)
        assert.ok(!sessions.includes(browserSession))
    }
    console.log(`PASS: ${records.length} WebKit/iPhone header checks, selected border, worker publication, and real view route`)
} finally {
    await browser?.close()
    await checked(admin.from('league_members').update({ user_id: actor.user_id }).eq('id', actor.id))
    await checked(admin.auth.admin.deleteUser(user.id))
}
