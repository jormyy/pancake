import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { devices } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { openWebTarget, WEB_TARGETS, waitForWebTargetReads, pressWebControl } from './web-targets-browser.mjs'
import { prepareSweepFixtures } from './layout-stability-fixtures.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { stackEnvironment, resolveSweepPorts, requireSweepStack } from './layout-stability-ports.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
const ports = resolveSweepPorts({}, env)
requireSweepStack(env, ports)
assert.equal(ports.api, '58921')
assert.equal(ports.db, '58922')
const target = WEB_TARGETS.find(row => row.engine === 'webkit' && row.viewport.width === 390 && row.viewport.height === 844 && !row.standalone)
assert.ok(target)
await mkdir(args.output, { recursive: true })

await runWithScenarioResourceOwner('UX fixes', async resourceOwner => {
    const fixture = await prepareSweepFixtures({ env, statePath: args.state, resourceOwner, ports })
    const checked = async query => {
        const { data, error } = await query
        assert.ifError(error)
        return data
    }
    const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const session = await fixture.sessionForBrowser()
    const matchups = await checked(admin.from('matchups').select('id,home_member_id,away_member_id').eq('league_id', fixture.state.leagueId).eq('week_number', fixture.currentWeek).eq('is_voided', false))
    const matchup = matchups.find(row => [row.home_member_id, row.away_member_id].includes(fixture.me.id))
    assert.ok(matchup)
    await checked(admin.from('matchup_forecasts').upsert({
        matchup_id: matchup.id, league_id: fixture.state.leagueId, input_revision: 1,
        valid_until: new Date(Date.now() + 3600000).toISOString(),
        forecast: { modelVersion: 'independent-games-v1', status: 'available', lineupBasis: 'Saved lineups', missingInputs: [], games: [], tieProbability: 0,
            teams: [fixture.me.id, fixture.other.id].map((memberId, index) => ({ memberId, currentPoints: index ? 117 : 123, projectedFinal: index ? 1769 : 1816, winProbability: index ? 0.38 : 0.62, remainingGames: 12, coveredGames: 12, variance: 10000 })) },
    }))
    const pending = await checked(admin.from('waiver_claims').select('id').eq('member_id', fixture.me.id).eq('status', 'pending'))
    if (!pending.length) await checked(admin.from('waiver_claims').insert({ league_id: fixture.state.leagueId, league_season_id: fixture.season.id, member_id: fixture.me.id, player_id: fixture.player, priority_at_submission: 1, process_date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), bid_amount: 0, claim_order: 1 }))
    const browserStorage = [
        { name: `sb-${new URL(env.E2E_SUPABASE_URL).hostname.split('.')[0]}-auth-token`, value: JSON.stringify(session) },
        { name: `pancake:selected-league:v1:${fixture.me.user_id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: fixture.me.id }) },
    ]
    const client = await openWebTarget(target, args.output, { ...devices['iPhone 14'], viewport: target.viewport, serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage: browserStorage }] } })
    const requests = []
    const errors = []
    client.page.on('pageerror', error => errors.push(error.message))
    client.page.on('request', request => {
        const url = new URL(request.url())
        if (/\/(rest|functions)\/v1\//.test(url.pathname) && request.method() !== 'OPTIONS') requests.push({ path: url.pathname, at: Date.now() })
    })
    let pause = false
    let release = () => {}
    let gate = Promise.resolve()
    const hold = () => { pause = true; gate = new Promise(resolve => { release = resolve }) }
    const resume = () => { pause = false; release() }
    const report = []
    try {
        await client.context.route('**/*', async route => {
            const url = new URL(route.request().url())
            if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) return route.abort('blockedbyclient')
            if (pause && /\/(rest|functions)\/v1\//.test(url.pathname)) await gate
            return route.continue()
        })
        const screens = [
            ['home', '/', 'E2E Team 1'], ['roster', '/roster', 'E2E Player001'],
            ['players', '/players', 'players ·'], ['waivers', '/players?section=waivers', 'Waivers'],
            ['trades-offers', '/trades', 'Incoming'], ['trades-block', '/trades?tab=block', 'League listings'],
            ['trades-history', '/trades?tab=history', 'History'], ['league', '/league', 'Standings'],
        ]
        for (const [name, route, expected] of screens) {
            await waitForWebTargetReads(client.page)
            if (client.page.url().startsWith(env.E2E_FRONTEND_URL)) await client.page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('pancake:screen-view:v1:')) localStorage.removeItem(key) })
            const start = requests.length
            await client.page.goto(new URL(route, env.E2E_FRONTEND_URL).href)
            await client.page.getByRole('navigation', { name: 'Primary', exact: true }).waitFor()
            await waitForWebTargetReads(client.page)
            await client.page.waitForFunction(text => document.body.innerText.toLowerCase().includes(text.toLowerCase()), expected, { timeout: 20000 })
            const first = requests.slice(start)
            const text = await client.page.locator('[role="main"]').innerText()
            await writeFile(path.join(args.output, `${name}.txt`), text)
            await client.page.screenshot({ path: path.join(args.output, `${name}.png`) })
            if (args.label === 'after' && name === 'home') {
                assert.ok(text.includes('62% win'))
                assert.match(text, /starters/i)
                for (const rejected of ['Timeline', 'Matchup details', 'Your lineup', 'Daily waivers', 'Other matchups']) assert.ok(!text.includes(rejected), rejected)
            }
            if (args.label === 'after' && name === 'roster') assert.ok(text.includes('1 Waiver'))
            if (args.label === 'after' && name === 'league') {
                assert.equal(await client.page.getByRole('tab', { name: 'Standings', exact: true }).getAttribute('aria-selected'), 'true')
                for (const label of ['Activity', 'Picks', 'Draft', 'Bracket', 'Settings']) assert.equal(await client.page.getByRole('tab', { name: label, exact: true }).count(), 1)
            }
            if (args.label === 'after' && ['players', 'league'].includes(name)) {
                const decoration = await client.page.getByRole('tab', { selected: true }).evaluate(node => ({ border: getComputedStyle(node).borderBottomWidth, background: getComputedStyle(node).backgroundColor }))
                assert.equal(decoration.border, '0px')
                assert.notEqual(decoration.background, 'rgba(0, 0, 0, 0)')
            }
            const away = name === 'home' ? 'Roster' : 'Matchup'
            await pressWebControl(target, client.page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: away, exact: true }))
            await waitForWebTargetReads(client.page)
            const beforeReopen = requests.length
            hold()
            const destination = name === 'home' ? 'Matchup' : name === 'roster' ? 'Roster' : name.startsWith('trades') ? 'Trades' : name === 'league' ? 'League' : 'Players'
            await pressWebControl(target, client.page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: destination, exact: true }))
            if (name === 'waivers' && await client.page.getByRole('tab', { name: 'Waivers', exact: true }).getAttribute('aria-selected') !== 'true') await pressWebControl(target, client.page.getByRole('tab', { name: 'Waivers', exact: true }))
            if (name === 'trades-block' && await client.page.getByRole('tab', { name: 'Block', exact: true }).getAttribute('aria-selected') !== 'true') await pressWebControl(target, client.page.getByRole('tab', { name: 'Block', exact: true }))
            if (name === 'trades-history' && await client.page.getByRole('tab', { name: 'History', exact: true }).getAttribute('aria-selected') !== 'true') await pressWebControl(target, client.page.getByRole('tab', { name: 'History', exact: true }))
            await client.page.waitForTimeout(30)
            const reopened = await client.page.locator('[role="main"]').innerText()
            const beforeRefresh = requests.slice(beforeReopen)
            await client.page.screenshot({ path: path.join(args.output, `${name}-reopen.png`) })
            resume()
            await waitForWebTargetReads(client.page)
            const background = requests.slice(beforeReopen + beforeRefresh.length)
            report.push({ screen: name, firstOpen: first.map(row => row.path), reopenBeforeRefresh: beforeRefresh.map(row => row.path), background: background.map(row => row.path), cachedTextMatches: reopened === text })
            await writeFile(path.join(args.output, 'requests.json'), JSON.stringify({ device: 'iPhone 14', viewport: target.viewport, label: args.label, screens: report, errors }, null, 2))
            if (args.label === 'after') {
                assert.ok(reopened.toLowerCase().includes(expected.toLowerCase()), `${name} loses cached content`)
                assert.equal(beforeRefresh.length, 0, `${name} starts network work before its cached view paints`)
                assert.equal(first.filter(row => row.path.includes('/views/')).length, 1, `${name} first screen reads`)
            }
        }
        if (args.label === 'after') {
            const start = requests.length
            await pressWebControl(target, client.page.getByRole('button', { name: 'Open menu', exact: true }))
            for (const label of ['League settings', 'Commissioner tools', 'Invite link', 'Notification settings', 'Profile']) assert.equal(await client.page.getByRole('button', { name: label, exact: true }).count(), 1)
            await client.page.screenshot({ path: path.join(args.output, 'league-menu.png') })
            assert.equal(requests.length, start)
        }
    } catch (error) {
        await writeFile(path.join(args.output, 'failure.txt'), `${String(error)}\n${await client.page.locator('body').innerText()}\n${JSON.stringify({ requests, errors })}`)
        await client.page.screenshot({ path: path.join(args.output, 'failure.png') })
        throw error
    } finally {
        resume()
        await client.context.close()
        await client.browser.close()
    }
    assert.deepEqual(errors, [])
})
