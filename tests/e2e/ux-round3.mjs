import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { devices } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { todayLeague } from '../../lib/timezone.ts'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { openWebTarget, WEB_TARGETS, navigateWebTarget, waitForWebTargetReads, pressWebControl } from './web-targets-browser.mjs'
import { stackEnvironment, requireSweepStack, resolveSweepPorts } from './layout-stability-ports.mjs'

const today = todayLeague('America/Los_Angeles')
const todayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${today}T12:00:00Z`))
const age = Number(today.slice(0, 4)) - 1996 - Number(today.slice(5) < '10-24')
const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
env.E2E_FRONTEND_URL = args.url
env.LAYOUT_STABILITY_FRONTEND_PORT = new URL(args.url).port
requireSweepStack(env, resolveSweepPorts({}, env))
assert.equal(new URL(env.E2E_SUPABASE_URL).port, '59221')
const originalFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    assert.equal(new URL(request.url).origin, new URL(env.E2E_SUPABASE_URL).origin)
    const headers = new Headers(request.headers)
    headers.set('x-request-id', randomUUID())
    return originalFetch(new Request(request, { headers }))
}
const checked = async query => {
    const { data, error } = await query
    assert.ifError(error)
    return data
}
await mkdir(args.output, { recursive: true })
await runWithScenarioResourceOwner('Round 3 screens', async () => {
    const fixture = await setupTradeGameplayFixture({ supabaseUrl: env.E2E_SUPABASE_URL, serviceRoleKey: env.E2E_PANCAKE_SUPABASE_SECRET_KEY, anonKey: env.E2E_SUPABASE_PUBLISHABLE_KEY }, 0, { includeFuturePicks: false, isolatedPlayers: true })
    const claims = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 2, fixture.registerCreatedPlayer, { createOnly: true })
    await checked(fixture.admin.from('leagues').update({ timezone: 'America/Los_Angeles', waiver_mode: 'faab', faab_starting_budget: 100, weekly_add_limit: 2 }).eq('id', fixture.league.id))
    await checked(fixture.admin.from('players').update({ birthdate: '1996-10-24', years_exp: 8, nba_team: 'BOS' }).in('id', [fixture.proposerPlayer.id, fixture.recipientPlayer.id]))
    const week = await checked(fixture.admin.from('season_weeks').select('week_number').eq('season_year', fixture.currentSeason.season_year).lte('week_start', today).gte('week_end', today).single())
    await checked(fixture.admin.from('matchups').insert({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, week_number: week.week_number, home_member_id: fixture.proposer.id, away_member_id: fixture.recipient.id }))
    await checked(fixture.admin.from('weekly_lineups').insert([
        { member_id: fixture.proposer.id, player_id: fixture.proposerPlayer.id, slot_type: 'PG' },
        { member_id: fixture.recipient.id, player_id: fixture.recipientPlayer.id, slot_type: 'SG' },
    ].map(row => ({ ...row, league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, game_date: today, week_number: week.week_number }))))
    await checked(fixture.admin.from('waiver_claims').insert(claims.map((player, index) => ({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: fixture.proposer.id, player_id: player.id, priority_at_submission: 1, status: 'pending', process_date: '2099-10-28', claim_order: index + 1, bid_amount: 1 }))))
    const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const session = await checked(auth.auth.signInWithPassword({ email: fixture.users[0].email, password: fixture.password }))
    await checked(auth.rpc('view_home', { p_league_id: fixture.league.id, p_member_id: fixture.proposer.id, p_params: {} }))
    const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && row.viewport.height === 844 && !row.standalone)
    assert.ok(target)
    const localStorage = [
        { name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(session.session) },
        { name: `pancake:selected-league:v1:${fixture.users[0].id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: fixture.proposer.id }) },
    ]
    const client = await openWebTarget(target, args.output, { ...devices['iPhone 14'], viewport: target.viewport, serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage }] } })
    const errors = [], readErrors = [], screens = [], requests = [], playerPayloads = []
    client.page.on('pageerror', error => errors.push(error.message))
    client.page.on('request', request => { if (/\/(?:rest|functions)\/v1\//.test(request.url())) requests.push(new URL(request.url()).pathname) })
    client.page.on('response', response => {
        if (response.url().includes('/views/players')) void response.json().then(row => playerPayloads.push(row.view))
        if (response.status() >= 400 && response.url().includes('/functions/v1/api/')) void response.text().then(body => readErrors.push({ path: new URL(response.url()).pathname, status: response.status(), body }))
    })
    await client.context.route('**/*', route => {
        const url = new URL(route.request().url())
        return ['http://127.0.0.1:59221', 'http://127.0.0.1:59280', 'http://127.0.0.1:59290'].includes(url.origin) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient')
    })
    const visit = async route => {
        await navigateWebTarget(client.page, new URL(route, env.E2E_FRONTEND_URL).href)
        await client.page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
        await waitForWebTargetReads(client.page)
    }
    const capture = async name => {
        await waitForWebTargetReads(client.page)
        await client.page.evaluate(() => window.scrollTo(0, 0))
        await client.page.waitForTimeout(200)
        const overflow = await client.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
        assert.equal(overflow, false, `${name} overflows`)
        await client.page.screenshot({ path: path.join(args.output, `${name}.png`), animations: 'disabled' })
        await writeFile(path.join(args.output, `${name}.txt`), await client.page.locator('body').innerText())
        screens.push(name)
    }
    try {
        await visit('/')
        const selected = client.page.getByRole('button', { name: todayLabel, exact: true })
        await selected.waitFor()
        assert.equal(await selected.getAttribute('aria-current'), 'date')
        assert.equal(await selected.evaluate(node => [...node.querySelectorAll('*')].some(child => child.getBoundingClientRect().width === 5 && child.getBoundingClientRect().height === 5)), true)
        const border = await client.page.getByTestId('matchup-player-name').first().evaluate(node => {
            for (let row = node; row; row = row.parentElement) if (getComputedStyle(row).borderBottomWidth === '1px') return getComputedStyle(row).borderBottomColor
            return null
        })
        assert.ok(border && border !== 'rgba(0, 0, 0, 0)')
        await capture('home')
        await visit('/league')
        await pressWebControl(target, client.page.getByRole('tab', { name: 'Bracket', exact: true }))
        await client.page.getByTestId('mobile-topbar').waitFor()
        await client.page.getByText('Playoffs', { exact: true }).waitFor()
        const header = await client.page.getByTestId('mobile-topbar').evaluate(node => {
            const rect = node.getBoundingClientRect()
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            return { top: rect.top, height: rect.height, visible: Boolean(hit && node.contains(hit)), covering: hit?.outerHTML.slice(0, 400) }
        })
        console.log(JSON.stringify({ bracketHeader: header }))
        assert.equal(header.visible, true, 'Bracket must keep the app header visible above its content')
        await capture('bracket')
        await visit('/roster')
        await pressWebControl(target, client.page.getByRole('button', { name: `Open ${fixture.proposerPlayer.display_name}`, exact: true }).first())
        const meta = client.page.getByRole('dialog').getByTestId('player-meta-line')
        await meta.waitFor()
        const metadata = await meta.innerText()
        assert.ok(metadata.indexOf(String(age)) >= 0 && metadata.indexOf('Yr 9') > metadata.indexOf(String(age)))
        await capture('roster-sheet')
        requests.length = 0
        await visit('/players')
        await client.page.getByText(/20 players.*FAAB \$100/).first().waitFor()
        await waitForWebTargetReads(client.page)
        assert.equal(requests.filter(row => row.endsWith('/views/players')).length, 1)
        assert.equal(playerPayloads.at(-1).transactionState.weeklyAddLimit, 2)
        assert.equal(playerPayloads.at(-1).transactionState.faabBalance, 100)
        await capture('players')
        await pressWebControl(target, client.page.getByRole('tab', { name: 'Waivers', exact: true }))
        const heading = client.page.getByText('Pending claims (2)', { exact: true })
        await heading.waitFor()
        assert.equal(await heading.evaluate(node => getComputedStyle(node).borderTopWidth), '1px')
        const rowBorders = await client.page.getByRole('button', { name: /Edit claim and drop for/ }).evaluateAll(nodes => nodes.map(node => getComputedStyle(node.parentElement).borderBottomWidth))
        assert.deepEqual(rowBorders, ['1px', '1px'])
        await capture('waivers')
        assert.deepEqual(errors, [])
        await writeFile(path.join(args.output, 'report.json'), JSON.stringify({ device: 'iPhone 14', engine: 'webkit', viewport: target.viewport, screens, playersRequests: 1, errors }, null, 2))
    } catch (error) {
        await writeFile(path.join(args.output, 'failure.txt'), `${String(error)}\n${JSON.stringify(readErrors)}\n${await client.page.locator('body').innerText()}`)
        await client.page.screenshot({ path: path.join(args.output, 'failure.png') })
        throw error
    } finally {
        await client.context.close()
        await client.browser.close()
        await auth.auth.signOut({ scope: 'local' })
    }
})
