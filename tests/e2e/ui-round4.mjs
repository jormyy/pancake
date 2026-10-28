import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { devices } from 'playwright'
import { prepareSweepFixtures } from './layout-stability-fixtures.mjs'
import { requireSweepStack, stackEnvironment } from './layout-stability-ports.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'
import { openWebTarget, WEB_TARGETS, waitForWebTargetReads, waitForWebTargetReady } from './web-targets-browser.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const env = await stackEnvironment(args.env)
requireSweepStack(env, { api: '58921', db: '58922', frontend: '58990' })
assert.equal(env.E2E_FRONTEND_URL, 'http://127.0.0.1:58990')
const output = path.resolve(args.output)
await mkdir(output, { recursive: true })
const checked = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
}
await runWithScenarioResourceOwner('UI round four', async resourceOwner => {
    const fixture = await prepareSweepFixtures({ env, statePath: args.state, resourceOwner })
    const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { fetch: (input, init) => {
            const headers = new Headers(init?.headers)
            headers.set('x-request-id', randomUUID())
            headers.set('x-request-actor', fixture.me.user_id)
            return fetch(input, { ...init, headers })
        } },
    })
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    await checked(admin.from('leagues').update({ timezone: 'America/Los_Angeles' }).eq('id', fixture.state.leagueId))
    await checked(admin.from('players').update({ birthdate: '2001-10-29', years_exp: 2, injury_status: 'DTD' }).like('sportsdata_id', 'e2e-player-%'))
    const lineups = await checked(admin.from('weekly_lineups').select('player_id,member_id').eq('league_id', fixture.state.leagueId).eq('game_date', today).eq('slot_type', 'PG'))
    assert.ok(lineups.length >= 2)
    for (const row of lineups) await checked(admin.from('players').update({ nba_team: row.member_id === fixture.me.id ? 'WAS' : 'CLE', birthdate: '2001-10-29', years_exp: 2, injury_status: 'DTD' }).eq('id', row.player_id))
    const game = await checked(admin.from('nba_games').insert({ nba_game_id: `002ui6-${randomUUID()}`, season_year: fixture.season.season_year,
        week_number: fixture.currentWeek, home_team: 'CLE', away_team: 'WAS', game_date: today, game_time: `${today}T23:00:42Z`, status: 'Scheduled' }).select('id').single())
    resourceOwner.register('UI fixture game', async () => { await checked(admin.from('nba_games').delete().eq('id', game.id)) })
    const reports = []
    for (const targetId of ['iphone-webkit-390-tab', 'desktop-webkit-1440']) {
        const target = WEB_TARGETS.find(item => item.id === targetId)
        assert.ok(target)
        const session = await fixture.sessionForBrowser()
        const client = await openWebTarget(target, output, { ...(target.viewport.width === 390 ? devices['iPhone 14'] : {}), viewport: target.viewport, timezoneId: 'UTC', serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: env.E2E_FRONTEND_URL, localStorage: [
            { name: 'sb-127-auth-token', value: JSON.stringify(session) },
            { name: `pancake:selected-league:v1:${fixture.me.user_id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: fixture.me.id }) },
        ] }] } })
        const errors = []
        client.page.on('pageerror', error => errors.push(error.message))
        await client.context.route('**/*', route => {
            const url = new URL(route.request().url())
            return url.hostname === '127.0.0.1' && ['58921', '58990'].includes(url.port) || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort('blockedbyclient')
        })
        try {
            for (const [name, route] of [['matchup', '/'], ['roster', '/roster'], ['players', '/players']]) {
                await client.page.goto(env.E2E_FRONTEND_URL + route)
                await waitForWebTargetReady(client.page)
                await waitForWebTargetReads(client.page)
                if (name === 'matchup') await client.page.getByText('WAS @ CLE 4:00 PM', { exact: true }).first().waitFor()
                else await client.page.getByLabel('Age 24', { exact: true }).first().waitFor()
                await client.page.evaluate(() => document.fonts.ready)
                await client.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
                const measurements = await client.page.evaluate(() => {
                    const visible = node => node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0
                    const badges = [...document.querySelectorAll('[aria-label="Day-To-Day"]')].filter(visible).map(node => {
                        const text = [...node.querySelectorAll('*')].find(child => child.textContent === 'DTD' && child.children.length === 0)
                        return { height: node.getBoundingClientRect().height, font: parseFloat(getComputedStyle(text ?? node).fontSize) }
                    })
                    const ages = [...document.querySelectorAll('[aria-label="Age 24"]')].filter(visible).map(node => ({ age: node.textContent, next: node.nextElementSibling?.textContent }))
                    const gameLines = [...document.querySelectorAll('[data-testid="matchup-game-line"]')].filter(visible).filter(node => node.textContent.includes('WAS @ CLE')).map(node => ({ text: node.textContent, clipped: node.scrollWidth > node.clientWidth, overflowStyle: getComputedStyle(node).textOverflow, nameFont: parseFloat(getComputedStyle(node.closest('[role="button"]')?.querySelector('[data-testid="matchup-player-name"]') ?? node).fontSize), nameWeight: Number(getComputedStyle(node.closest('[role="button"]')?.querySelector('[data-testid="matchup-player-name"]') ?? node).fontWeight), weight: Number(getComputedStyle(node).fontWeight), font: parseFloat(getComputedStyle(node).fontSize) }))
                    return { gameLines, overflow: document.documentElement.scrollWidth > innerWidth, badges, ages, text: document.querySelector('[role="main"]')?.textContent }
                })
                await client.page.screenshot({ path: path.join(output, `${targetId}-${name}.png`), fullPage: true })
                assert.equal(measurements.overflow, false, `${name} horizontal overflow`)
                assert.ok(measurements.badges.length > 0, `${name} displays injury badges`)
                assert.ok(measurements.badges.every(badge => badge.font === 9 && badge.height === 12), `${name} compact status badges`)
                if (name === 'matchup') {
                    assert.equal(measurements.ages.length, 0, 'Matchup rows omit age')
                    assert.ok(measurements.gameLines.length >= 2)
                    assert.ok(measurements.gameLines.every(line => line.text === 'WAS @ CLE 4:00 PM' && !line.clipped && line.overflowStyle === 'clip' && line.font > 9 && line.nameFont > 9 && (line.nameFont > line.font || line.nameWeight > line.weight)), `Both sides show the full tip time: ${JSON.stringify(measurements.gameLines)}`)
                }
                else {
                    assert.ok(measurements.ages.length > 0)
                    assert.ok(measurements.ages.every(age => age.next === 'Yr 3'), `${name} age precedes experience`)
                }
                reports.push({ target: targetId, name, ...measurements })
            }
            await checked(admin.from('nba_games').update({ status: 'Final' }).eq('id', game.id))
            await client.page.goto(env.E2E_FRONTEND_URL + '/')
            await waitForWebTargetReady(client.page)
            await client.page.getByText('WAS @ CLE Final', { exact: true }).first().waitFor()
            await client.page.screenshot({ path: path.join(output, `${targetId}-final.png`), fullPage: true })
            await checked(admin.from('nba_games').update({ status: 'Scheduled' }).eq('id', game.id))
            assert.deepEqual(errors, [])
        } catch (error) {
            await client.page.screenshot({ path: path.join(output, `${targetId}-failure.png`), fullPage: true })
            await writeFile(path.join(output, `${targetId}-failure.txt`), String(error) + '\n' + await client.page.locator('body').innerText())
            throw error
        } finally {
            await client.context.close()
            await client.browser.close()
            await writeFile(path.join(output, 'report.json'), JSON.stringify({ reports, errors }, null, 2))
        }
    }
})
