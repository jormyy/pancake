import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { inspectSession } from '../../lib/auth-session.ts'
import { webkit } from 'playwright'
import { setupTradeGameplayFixture, findAvailablePlayers } from './trade-fixture.mjs'
import { runWithScenarioResourceOwner } from './scenario-resource-owner.mjs'

const env = Object.fromEntries((await readFile('.env', 'utf8')).trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
const url = 'http://127.0.0.1:57990'
assert.equal(env.E2E_SUPABASE_URL, 'http://127.0.0.1:57921')
const output = process.env.PANCAKE_LAYOUT_OUTPUT
assert.ok(output)
await mkdir(output, { recursive: true })
const checked = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
}
await runWithScenarioResourceOwner('Other matchup navigation', async () => {
    const fixture = await setupTradeGameplayFixture({ supabaseUrl: env.E2E_SUPABASE_URL, serviceRoleKey: env.E2E_PANCAKE_SUPABASE_SECRET_KEY, anonKey: env.E2E_SUPABASE_PUBLISHABLE_KEY }, 0, { memberCount: 6, includeFuturePicks: false, isolatedPlayers: true })
    const members = await checked(fixture.admin.from('league_members').select('id,team_name').eq('league_id', fixture.league.id).order('team_name'))
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const week = await checked(fixture.admin.from('season_weeks').select('week_number').eq('season_year', fixture.currentSeason.season_year).lte('week_start', today).gte('week_end', today).single())
    const matchups = await checked(fixture.admin.from('matchups').insert([0, 2, 4].map(index => ({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, week_number: week.week_number, home_member_id: members[index].id, away_member_id: members[index + 1].id }))).select('id'))
    const players = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 6, fixture.registerCreatedPlayer, { createOnly: true })
    await checked(fixture.admin.from('roster_players').insert(members.map((member, index) => ({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: member.id, player_id: players[index].id, acquired_via: 'draft' }))))
    await checked(fixture.admin.from('weekly_lineups').insert(members.map((member, index) => ({ league_id: fixture.league.id, league_season_id: fixture.currentSeason.id, member_id: member.id, player_id: players[index].id, game_date: today, week_number: week.week_number, slot_type: 'PG' }))))
    const auth = createClient(env.E2E_SUPABASE_URL, env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const session = await checked(auth.auth.signInWithPassword({ email: fixture.users[0].email, password: fixture.password }))
    assert.equal(inspectSession(session.session, env.E2E_SUPABASE_URL).status, 'valid')
    const browser = await webkit.launch()
    try {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', storageState: { cookies: [], origins: [{ origin: url, localStorage: [
            { name: 'sb-127-auth-token', value: JSON.stringify(session.session) },
            { name: `pancake:selected-league:v1:${fixture.users[0].id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: fixture.proposer.id }) },
        ] }] } })
        await context.route('**/*', route => {
            const target = new URL(route.request().url())
            return target.hostname === '127.0.0.1' && ['57921', '57990'].includes(target.port) || ['data:', 'blob:'].includes(target.protocol) ? route.continue() : route.abort()
        })
        const page = await context.newPage()
        try {
            const reads = []
            const errors = []
            page.on('request', request => { if (request.url().includes('/views/home')) reads.push(request.url()) })
            page.on('pageerror', error => errors.push(error.message))
            page.on('console', message => { if (message.type() === 'error') console.log('Browser error:', message.text()) })
            await page.goto(url)
            const strip = page.getByTestId('other-matchups')
            await strip.waitFor()
            assert.equal(reads.length, 1)
            await Promise.all([page.waitForResponse(response => response.url().includes('/views/home') && response.ok()), page.reload()])
            await strip.waitFor()
            const own = reads.length
            const first = 'Open Trade Team 3 versus Trade Team 4'
            const second = 'Open Trade Team 5 versus Trade Team 6'
            await page.getByRole('button', { name: first, exact: true }).click()
            await page.getByTestId('other-matchup-page').waitFor()
            const otherStrip = page.getByTestId('other-matchup-page').getByTestId('other-matchups')
            await otherStrip.getByRole('button', { name: second, exact: true }).waitFor()
            assert.equal(await page.getByRole('button', { name: 'Back to Home', exact: true }).count(), 0)
            assert.equal(reads.length, own + 1)
            await otherStrip.getByRole('button', { name: second, exact: true }).click()
            await page.waitForURL(`**matchupId=${matchups[2].id}`)
            await page.waitForTimeout(500)
            assert.equal(reads.length, own + 2)
            await otherStrip.getByRole('button', { name: first, exact: true }).click()
            await page.waitForURL(`**matchupId=${matchups[1].id}`)
            await page.waitForTimeout(500)
            assert.equal(reads.length, own + 2)
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
            await otherStrip.scrollIntoViewIfNeeded()
            const stripBox = await otherStrip.boundingBox()
            const navBox = await page.getByRole('navigation', { name: 'Primary', exact: true }).boundingBox()
            assert.ok(stripBox && navBox && stripBox.y + stripBox.height <= navBox.y)
            await page.screenshot({ path: `${output}/other-matchup-live.png`, fullPage: true })
            await page.getByRole('link', { name: 'Matchup', exact: true }).click()
            await page.getByTestId('other-matchup-page').waitFor({ state: 'detached' })
            assert.equal(new URL(page.url()).pathname, '/')
            await page.getByText('Trade Team 1', { exact: true }).first().waitFor()
            await page.getByText('Trade Team 2', { exact: true }).first().waitFor()
            assert.equal(reads.length, own + 2)
            assert.deepEqual(errors, [])
            await page.getByText('Trade Team 1', { exact: true }).first().scrollIntoViewIfNeeded()
            await page.screenshot({ path: `${output}/home-return.png`, fullPage: true })
            await writeFile(`${output}/navigation.json`, JSON.stringify({ viewport: { width: 390, height: 844 }, newMatchupRequests: 1, cachedReturnRequests: 0, homeReturnRequests: 0, pageErrors: errors.length }, null, 2))
            console.log('PASS: Home → other → another → cached other → Home; one request per new matchup, zero on cached returns')
        } catch (error) {
            await page.screenshot({ path: `${output}/navigation-failure.png`, fullPage: true })
            await writeFile(`${output}/navigation-failure.txt`, await page.locator('body').innerText())
            throw error
        }
    } finally {
        await browser.close()
        await auth.auth.signOut()
    }
})
