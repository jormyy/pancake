import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { devices } from 'playwright'
import { prepareSweepFixtures } from '../e2e/layout-stability-fixtures.mjs'
import { requireSweepStack, stackEnvironment } from '../e2e/layout-stability-ports.mjs'
import { runWithScenarioResourceOwner } from '../e2e/scenario-resource-owner.mjs'
import { WEB_TARGETS, openWebTarget, waitForWebTargetReady, waitForWebTargetReads } from '../e2e/web-targets-browser.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    assert.ok(arg.startsWith('--') && arg.includes('='), 'Use --name=value arguments')
    return arg.slice(2).split(/=(.*)/s).slice(0, 2)
}))
assert.ok(args['stack-env'] && args.state && args['output-dir'])
assert.match(await readFile('supabase/config.toml', 'utf8'), /^project_id = "pt4bafablepolish"$/m)
const env = await stackEnvironment(args['stack-env'])
const ports = { api: '58821', db: '58822', frontend: '58890' }
requireSweepStack(env, ports)
const origin = env.E2E_FRONTEND_URL
const output = path.resolve(args['output-dir'])
assert.ok(!output.startsWith(process.cwd() + path.sep), 'Evidence must stay outside the repository')
await mkdir(output, { recursive: true })
const checked = async operation => {
    const { data, error } = await operation
    if (error) throw new Error(error.message)
    return data
}
const originalFetch = globalThis.fetch
const admin = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
globalThis.fetch = (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    assert.equal(url.origin, env.E2E_SUPABASE_URL, 'Only the private API is allowed')
    if (request.method === 'POST' && url.pathname.startsWith('/rest/v1/rpc/')) {
        const headers = new Headers(request.headers)
        const token = headers.get('authorization')?.replace(/^Bearer /i, '')
        let authenticated = false
        try { authenticated = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).role === 'authenticated' } catch {}
        if (authenticated && !headers.has('x-request-id')) headers.set('x-request-id', randomUUID())
        return originalFetch(new Request(request, { headers }))
    }
    return originalFetch(request)
}
const report = { label: args.label ?? 'after', device: 'iPhone 14', viewport: { width: 390, height: 844 }, cases: [], errors: [] }
await runWithScenarioResourceOwner('claims navigation', async resourceOwner => {
    const state = JSON.parse(await readFile(args.state, 'utf8'))
    assert.ok(state.leagueId && state.users?.[0]?.id)
    await checked(admin.from('drafts').update({ status: 'completed' }).eq('league_id', state.leagueId).eq('draft_type', 'auction'))
    await checked(admin.from('leagues').update({ status: 'active', waiver_mode: 'faab', weekly_add_limit: 2 }).eq('id', state.leagueId))
    const fixture = await prepareSweepFixtures({ env, statePath: args.state, resourceOwner, ports })
    const memberId = fixture.me.id
    const seasonId = fixture.season.id
    const pending = await checked(admin.from('waiver_claims').select('id').eq('member_id', memberId).eq('league_season_id', seasonId).eq('status', 'pending'))
    assert.equal(pending.length, 0, 'Use a clean disposable seed')
    const priorities = await checked(admin.from('waiver_priorities').select('id,member_id,priority').eq('league_season_id', seasonId))
    const mine = priorities.find(row => row.member_id === memberId)
    if (mine.priority !== 6) {
        const sixth = priorities.find(row => row.priority === 6)
        if (sixth) await checked(admin.from('waiver_priorities').update({ priority: Math.max(...priorities.map(row => row.priority)) + 1 }).eq('id', sixth.id))
        await checked(admin.from('waiver_priorities').update({ priority: 6 }).eq('id', mine.id))
        if (sixth) await checked(admin.from('waiver_priorities').update({ priority: mine.priority }).eq('id', sixth.id))
    }
    const balances = await checked(admin.from('faab_balances').select('id').eq('member_id', memberId).eq('league_season_id', seasonId))
    if (balances.length) await checked(admin.from('faab_balances').update({ balance: 100 }).eq('id', balances[0].id))
    else await checked(admin.from('faab_balances').insert({ league_id: state.leagueId, league_season_id: seasonId, member_id: memberId, balance: 100 }))
    const roster = await checked(admin.from('roster_players').select('player_id').eq('league_id', state.leagueId))
    const players = await checked(admin.from('players').select('id').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id'))
    const free = players.filter(player => !roster.some(row => row.player_id === player.id)).slice(0, 3)
    assert.equal(free.length, 3)
    const player = await checked(admin.from('players').select('id,nba_team,sleeper_id').eq('id', fixture.rosterPlayer).single())
    const gameTime = new Date(Date.now() + 86_400_000)
    gameTime.setUTCHours(22, 0, 0, 0)
    const gameDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(gameTime)
    const week = await checked(admin.from('season_weeks').select('week_number').eq('season_year', fixture.season.season_year).lte('week_start', gameDate).gte('week_end', gameDate).single())
    const game = await checked(admin.from('nba_games').insert({ nba_game_id: `002polish-${randomUUID()}`, season_year: fixture.season.season_year,
        week_number: week.week_number, home_team: player.nba_team, away_team: 'SAS', game_date: gameDate, game_time: gameTime.toISOString(), status: 'Scheduled' }).select('id').single())
    const projection = await checked(admin.from('sleeper_projection_rows').insert({ player_id: player.id, sleeper_id: player.sleeper_id, source_game_id: game.id,
        season_year: fixture.season.season_year, week_number: week.week_number, game_date: gameDate, team: player.nba_team, opponent: 'SAS',
        points: 0, rebounds: 0, assists: 0, steals: 0, blocks: 0, three_pointers_made: 0, three_pointers_attempted: 0,
        turnovers: 0, field_goals_made: 0, field_goals_attempted: 0, free_throws_made: 0, free_throws_attempted: 0, minutes: 0, last_modified: Date.now(),
    }).select('id').single())
    const created = []
    try {
        for (const count of [0, 1, 3]) {
            while (created.length < count) created.push(await checked(admin.rpc('create_waiver_claim_atomic', {
                p_league_id: state.leagueId, p_member_id: memberId, p_player_id: free[created.length].id, p_user_id: fixture.me.user_id,
            })))
            const target = WEB_TARGETS.find(target => target.id === 'iphone-webkit-390-tab')
            const client = await openWebTarget(target, output, { ...devices['iPhone 14'], storageState: { cookies: [], origins: [{ origin, localStorage: [
                { name: 'sb-127-auth-token', value: JSON.stringify(await fixture.sessionForBrowser()) },
                { name: `pancake:selected-league:v1:${fixture.me.user_id}`, value: JSON.stringify({ version: 1, savedAt: Date.now(), value: memberId }) },
            ] }] } })
            try {
                const { page, context } = client
                page.on('pageerror', error => report.errors.push(error.message))
                await context.route('**/*', route => {
                    const url = new URL(route.request().url())
                    return url.hostname === '127.0.0.1' && ['58821', '58890'].includes(url.port) ? route.continue() : route.abort('blockedbyclient')
                })
                await page.goto(`${origin}/roster`)
                await waitForWebTargetReady(page)
                await waitForWebTargetReads(page)
                const section = count ? 'Waivers' : 'Players'
                const pill = page.getByRole('button', { name: `${count} pending claims, open ${section}`, exact: true })
                await pill.waitFor({ state: 'visible' })
                const box = await pill.boundingBox()
                assert.ok(box.width >= 44 && box.height >= 44)
                assert.equal(await pill.innerText(), String(count))
                assert.equal(await page.getByText('Waiver claims', { exact: true }).count(), 0)
                await page.screenshot({ path: path.join(output, `roster-${count}.png`) })
                await pill.tap()
                await page.waitForURL(url => url.pathname === '/players' && url.searchParams.get('section') === (count ? 'waivers' : 'players'))
                await waitForWebTargetReads(page)
                if (count) {
                    await page.getByText(`Pending claims (${count})`, { exact: true }).waitFor({ state: 'visible' })
                    assert.ok(await page.getByText('Available FAAB $100 · Priority #6', { exact: true }).isVisible())
                    if (report.label === 'after') {
                        assert.ok(await page.getByText('Pickups 0/2 this week', { exact: true }).isVisible())
                        assert.doesNotMatch(await page.locator('body').innerText(), /Dropped players wait|Bids stay private|Higher bids go first|Claim order decides|Successful pickups/)
                    }
                } else {
                    await page.getByRole('textbox', { name: /Search/ }).first().waitFor({ state: 'visible' })
                    assert.equal(await page.getByText('Waivers', { exact: true }).count(), 1)
                }
                const controls = await page.locator('[role="button"],input').evaluateAll(nodes => nodes.filter(node => { const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 }).map(node => { const box = node.getBoundingClientRect(); return { label: node.getAttribute('aria-label') ?? node.textContent, width: box.width, height: box.height } }))
                for (const control of controls) assert.ok(control.width >= 44 && control.height >= 44, `${control.label}: target is smaller than 44px`)
                await page.screenshot({ path: path.join(output, `destination-${count}.png`) })
                report.cases.push({ count, section, url: page.url(), target: { width: box.width, height: box.height }, controls })
                if (count === 3) {
                    await page.goto(`${origin}/player/${player.id}`)
                    await waitForWebTargetReady(page)
                    await waitForWebTargetReads(page)
                    const summary = page.getByText(/^vs SAS .+proj$/).first()
                    await summary.waitFor({ state: 'visible' })
                    if (report.label === 'after') {
                        assert.match(await summary.innerText(), /^vs SAS \w+ .+ · 0\.0 proj$/)
                        const geometry = await summary.evaluate(node => ({ height: node.getBoundingClientRect().height, line: parseFloat(getComputedStyle(node).lineHeight), clipped: node.scrollWidth > node.clientWidth }))
                        assert.ok(!geometry.clipped && geometry.height <= geometry.line)
                        report.playerProjection = geometry
                    }
                    await page.screenshot({ path: path.join(output, 'player-projection.png') })
                }
                console.log(`${count} claims opens ${section}`)
            } finally {
                await client.context.close()
                await client.browser.close()
            }
        }
        assert.equal(report.errors.length, 0)
    } finally {
        if (created.length) await checked(admin.from('waiver_claims').delete().in('id', created).eq('member_id', memberId))
        await checked(admin.from('sleeper_projection_rows').delete().eq('id', projection.id))
        await checked(admin.from('nba_games').delete().eq('id', game.id))
        await writeFile(path.join(output, 'claims-navigation.json'), JSON.stringify(report, null, 2))
    }
})
