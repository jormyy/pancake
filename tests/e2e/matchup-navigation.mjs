import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { chromium, devices, webkit } from 'playwright'

const api = 'http://127.0.0.1:60521'
const frontend = 'http://127.0.0.1:60590'
const date = '2026-10-26'
const output = process.env.PANCAKE_LAYOUT_OUTPUT
assert.ok(output)
assert.match(await readFile('supabase/config.toml', 'utf8'), /project_id = "pt4bafabledl"/)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, api)
const admin = createClient(api, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const checked = async operation => { const { data, error } = await operation; assert.ifError(error); return data }
const league = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const actorId = 'a0886fc8-37ba-4fe7-bec7-8a58c3c330c3'
const actor = await checked(admin.from('league_members').select('user_id').eq('id', actorId).single())
const email = `navigation-${randomUUID()}@example.invalid`, password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Navigation check' } }))
let browser, page
const records = []
await mkdir(output, { recursive: true })
try {
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', actorId))
    const auth = createClient(api, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    const response = await fetch(`${api}/functions/v1/api/views/home?leagueId=${league}&memberId=${actorId}&params=${encodeURIComponent(JSON.stringify({ date }))}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
    assert.equal(response.ok, true)
    const { view } = await response.json()
    const own = view.leagueMatchups.find(matchup => matchup.isMine)
    const others = view.leagueMatchups.filter(matchup => !matchup.isMine)
    assert.ok(own && others.length > 1)
    const ordered = [own, ...others]
    const label = matchup => `Open ${matchup.homeTeamName} versus ${matchup.awayTeamName}`
    browser = await webkit.launch()
    const context = await browser.newContext({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    await context.route('**/*', route => {
        const target = new URL(route.request().url())
        return target.hostname === '127.0.0.1' && ['60521', '60590'].includes(target.port) || ['data:', 'blob:'].includes(target.protocol) ? route.continue() : route.abort()
    })
    await context.addInitScript(({ session, userId, actorId }) => {
        localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${userId}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: actorId }))
    }, { session, userId: user.id, actorId })
    page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const card = page.getByTestId('matchup-score-card').last()
    const strip = page.getByTestId('other-matchups').last()
    const waitMatchup = async matchup => {
        await card.getByText(matchup.homeTeamName, { exact: true }).waitFor()
        await card.getByText(matchup.awayTeamName, { exact: true }).waitFor()
        await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid="matchup-score-card"]')).at(-1)?.parentElement?.querySelector('[aria-current="date"]')?.getAttribute('aria-label') === 'Monday, October 26')
        assert.equal(await card.locator('..').locator('[aria-current="date"]').getAttribute('aria-label'), 'Monday, October 26')
        assert.equal(await strip.getByRole('button').first().getAttribute('aria-label'), label(own))
        assert.equal(await strip.locator('[aria-current="true"]').getAttribute('aria-label'), label(matchup))
    }
    const geometry = async (matchup, width) => {
        await waitMatchup(matchup)
        const data = await card.evaluate(node => {
            const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, width: r.width, height: r.height, centerY: r.y + r.height / 2 } }
            const previous = node.querySelector('[aria-label="Previous matchup"]')
            const next = node.querySelector('[aria-label="Next matchup"]')
            const left = node.querySelector('[data-testid="matchup-team-left"]')
            const right = node.querySelector('[data-testid="matchup-team-right"]')
            return { card: box(node), previous: box(previous), next: box(next), left: box(left), right: box(right), overflow: document.documentElement.scrollWidth > innerWidth,
                names: [left, right].map(team => ({ text: team.textContent, clipped: team.scrollWidth > team.clientWidth })) }
        })
        assert.equal(data.overflow, false)
        assert.ok(data.previous.width >= 44 && data.previous.height >= 44)
        assert.ok(data.next.width >= 44 && data.next.height >= 44)
        assert.ok(data.previous.right <= data.left.x && data.right.right <= data.next.x)
        assert.ok(data.left.right <= data.right.x)
        assert.ok(Math.abs(data.previous.centerY - data.left.centerY) < 1)
        assert.ok(Math.abs(data.next.centerY - data.right.centerY) < 1)
        assert.ok(data.card.x >= 0 && data.card.right <= width)
        assert.ok(data.names.every(name => !name.clipped))
        const outlines = await strip.getByRole('button').evaluateAll(nodes => nodes.map(node => ({ selected: node.getAttribute('aria-current') === 'true', border: getComputedStyle(node).borderTopWidth, color: getComputedStyle(node).borderTopColor })))
        assert.equal(outlines.filter(row => row.selected).length, 1)
        assert.equal(outlines.find(row => row.selected).border, '2px')
        assert.ok(outlines.filter(row => !row.selected).every(row => row.border === '1px'))
        records.push({ width, matchupId: matchup.id, date, ...data, outlines })
    }
    await page.goto(frontend, { waitUntil: 'domcontentloaded' })
    await card.waitFor()
    await page.getByRole('button', { name: 'Monday, October 26', exact: true }).click()
    for (const width of [320, 390, 768]) {
        await page.setViewportSize({ width, height: 844 })
        for (const matchup of ordered) {
            await geometry(matchup, width)
            if (matchup.id === own.id || matchup.id === others[0].id) {
                await card.scrollIntoViewIfNeeded()
                await page.screenshot({ path: path.join(output, `webkit-${matchup.id === own.id ? 'own' : 'other'}-${width}.png`), scale: 'css' })
            }
            await card.getByRole('button', { name: 'Next matchup', exact: true }).click()
        }
        await waitMatchup(own)
        assert.equal(new URL(page.url()).searchParams.get('matchupId'), own.id)
        assert.equal(new URL(page.url()).searchParams.get('date'), date)
        await card.getByRole('button', { name: 'Previous matchup', exact: true }).click()
        await waitMatchup(ordered.at(-1))
        await card.getByRole('button', { name: 'Next matchup', exact: true }).click()
        await waitMatchup(own)
    }
    assert.deepEqual(errors, [])
    const cli = path.resolve('node_modules/.bin/agent-browser')
    const browserSession = `matchup-nav-${randomUUID()}`
    const run = args => {
        try { return execFileSync(cli, ['--session', browserSession, ...args], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }) }
        catch { throw new Error(`agent-browser action failed: ${args[0]}`) }
    }
    const read = () => JSON.parse(run(['eval', `(() => ({url:location.href, heading:Array.from(document.querySelectorAll('[data-testid="matchup-score-card"]')).at(-1)?.textContent, day:Array.from(document.querySelectorAll('[data-testid="matchup-score-card"]')).at(-1)?.parentElement?.querySelector('[aria-current="date"]')?.getAttribute('aria-label'), selected:Array.from(document.querySelectorAll('[data-testid="other-matchups"]')).at(-1)?.querySelector('[aria-current="true"]')?.getAttribute('aria-label'), first:Array.from(document.querySelectorAll('[data-testid="other-matchups"]')).at(-1)?.querySelector('[role="button"]')?.getAttribute('aria-label')}))()`]))
    const ready = async matchup => {
        for (let attempt = 0; attempt < 40; attempt++) {
            const current = read()
            if (current.heading?.includes(matchup.homeTeamName) && current.heading?.includes(matchup.awayTeamName) && current.selected === label(matchup) && current.day === 'Monday, October 26') {
                assert.equal(current.first, label(own))
                records.push({ agentBrowser: true, matchupId: matchup.id, ...current })
                return
            }
            await delay(250)
        }
        throw new Error(`The expected matchup and date did not appear: ${JSON.stringify({ expected: label(matchup), current: read() })}`)
    }
    const click = name => {
        const reference = () => {
            const snapshot = run(['snapshot'])
            const row = snapshot.split('\n').reverse().find(row => row.includes(`button "${name}"`))
            assert.ok(row, `Missing button ${name}`)
            const ref = row.match(/\[ref=([^\]]+)\]/)?.[1]
            assert.ok(ref)
            return `@${ref}`
        }
        run(['scrollintoview', reference()])
        run(['click', reference()])
    }
    const capture = name => {
        run(['eval', '(() => { window.scrollTo(0, 0); return true })()'])
        return run(['screenshot', path.join(output, `${name}-390.png`)])
    }
    execFileSync(cli, ['session', 'list'], { encoding: 'utf8' })
    try {
        run(['--executable-path', chromium.executablePath(), '--allowed-domains', '127.0.0.1', 'open', frontend])
        run(['eval', `(() => { localStorage.setItem('sb-127-auth-token', ${JSON.stringify(JSON.stringify(session))}); localStorage.setItem('pancake:selected-league:v1:${user.id}', ${JSON.stringify(JSON.stringify({ version: 1, savedAt: Date.now(), value: actorId }))}); return true })()`])
        run(['set', 'viewport', '390', '844'])
        run(['open', frontend])
        run(['wait', '[aria-label="Next matchup"]'])
        click('Monday, October 26')
        await ready(own)
        capture('own-header')
        run(['scrollintoview', '[data-testid="other-matchups"]'])
        capture('own-selector')
        click('Next matchup')
        await ready(ordered[1])
        capture('other-right-arrow')
        run(['scrollintoview', '[data-testid="other-matchup-page"] [data-testid="other-matchups"] [aria-current="true"]'])
        run(['eval', `(() => {
            const selected = document.querySelector('[data-testid="other-matchup-page"] [data-testid="other-matchups"] [aria-current="true"]');
            let rail = selected?.parentElement;
            while (rail && rail.scrollWidth <= rail.clientWidth) rail = rail.parentElement;
            if (rail instanceof HTMLElement && selected instanceof HTMLElement) rail.scrollLeft = selected.offsetLeft + selected.offsetWidth - rail.clientWidth;
            return true;
        })()`])
        capture('other-selector')
        click(label(own))
        await ready(own)
        assert.equal(new URL(read().url).pathname, '/matchup')
        for (let index = 1; index < ordered.length; index++) {
            click('Next matchup')
            await ready(ordered[index])
        }
        capture('last-header')
        click('Next matchup')
        await ready(own)
        capture('wrap-last-to-first')
        click('Previous matchup')
        await ready(ordered.at(-1))
        capture('wrap-first-to-last')
        await writeFile(path.join(output, 'agent-browser-snapshot.txt'), run(['snapshot']))
        assert.match(run(['errors']), /No page errors|\[\]|^\s*$/)
    } catch (error) {
        await writeFile(path.join(output, 'agent-browser-failure.txt'), run(['snapshot']))
        capture('agent-browser-failure')
        throw error
    } finally {
        run(['close'])
        let sessions = ''
        for (let attempt = 0; attempt < 25; attempt++) {
            sessions = execFileSync(cli, ['session', 'list'], { encoding: 'utf8' })
            if (!sessions.includes(browserSession)) break
            await delay(200)
        }
        assert.ok(!sessions.includes(browserSession))
    }
    await writeFile(path.join(output, 'navigation-evidence.json'), JSON.stringify({ records, errors, order: ordered.map(matchup => ({ id: matchup.id, label: label(matchup) })) }, null, 2))
    console.log(`PASS: ${ordered.length} matchups at 320/390/768, both wrap directions, date preservation, own-card return, and agent-browser screenshots`)
} catch (error) {
    if (page) {
        await page.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' })
        await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText())
    }
    throw error
} finally {
    await browser?.close()
    execFileSync('psql', ['postgresql://postgres:postgres@127.0.0.1:60522/postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-c', `SET session_replication_role=replica; UPDATE public.league_members SET user_id='${actor.user_id}' WHERE id='${actorId}';`], { stdio: 'ignore' })
    await checked(admin.auth.admin.deleteUser(user.id))
}
