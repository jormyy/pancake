import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createClient } from '@supabase/supabase-js'
import { chromium, devices, webkit } from 'playwright'
import { calculateFantasyPoints } from '@pancake/core'

const api = 'http://127.0.0.1:60521'
const frontend = 'http://127.0.0.1:60590'
const output = process.env.PANCAKE_LAYOUT_OUTPUT
assert.ok(output, 'Set PANCAKE_LAYOUT_OUTPUT outside the checkout')
assert.match(await readFile('supabase/config.toml', 'utf8'), /project_id = "pt4bafabledl"/)
const stack = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
assert.equal(stack.API_URL, api)
const admin = createClient(api, stack.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const checked = async operation => {
    const { data, error } = await operation
    assert.ifError(error)
    return data
}
const sql = statement => execFileSync('psql', ['postgresql://postgres:postgres@127.0.0.1:60522/postgres', '-X', '-v', 'ON_ERROR_STOP=1', '-c', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const league = 'faab8d8f-6a60-4bbc-8f5d-44050b652cdd'
const matchup = '9e002ea0-c1d7-40f1-bca6-4afea03eb931'
const actorId = 'a0886fc8-37ba-4fe7-bec7-8a58c3c330c3'
const actor = await checked(admin.from('league_members').select('user_id').eq('id', actorId).single())
const email = `daily-total-${randomUUID()}@example.invalid`
const password = randomUUID()
const { user } = await checked(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { display_name: 'Daily total check' } }))
let browser
let page
await mkdir(output, { recursive: true })
try {
    await checked(admin.from('league_members').update({ user_id: user.id }).eq('id', actorId))
    const auth = createClient(api, stack.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const { session } = await checked(auth.auth.signInWithPassword({ email, password }))
    const readView = async (date, detail = false) => {
        const params = { date, ...(detail ? { matchupId: matchup } : {}) }
        const response = await fetch(`${api}/functions/v1/api/views/home?leagueId=${league}&memberId=${actorId}&params=${encodeURIComponent(JSON.stringify(params))}`, { headers: { Authorization: `Bearer ${session.access_token}` } })
        const body = await response.json()
        assert.equal(response.ok, true, JSON.stringify(body))
        assert.ok(body.view.myLineup?.starters.some(slot => slot.player), `No starters on ${date}`)
        return body.view
    }
    const liveDate = '2026-10-28'
    const pastDate = '2026-10-26'
    const futureDate = '2026-10-29'
    const livePlayers = []
    const view = await readView(liveDate)
    for (const [side, lineup] of [view.myLineup, view.oppLineup].entries()) {
        const players = lineup.starters.flatMap(slot => slot.player ? [slot.player] : [])
        await checked(admin.from('player_game_stats').delete().eq('game_date', liveDate).in('player_id', players.map(player => player.playerId)))
        const playing = players.filter(player => view.todaysGames.some(game => [game.home_team, game.away_team].includes(player.nbaTeam))).slice(-2)
        assert.equal(playing.length, 2, 'Each side needs two starter stat lines')
        for (const [index, player] of playing.entries()) {
            const game = view.todaysGames.find(game => [game.home_team, game.away_team].includes(player.nbaTeam))
            await checked(admin.from('nba_games').update({ status: 'InProgress', game_status_text: 'Q2 5:00', started_at: new Date(`${liveDate}T23:00:00Z`).toISOString() }).eq('id', game.id))
            await checked(admin.from('player_game_stats').upsert({ player_id: player.playerId, game_id: game.id, game_date: liveDate, season_year: view.context.seasonYear, points: 12 + side * 6 + index * 4, rebounds: side ? 2 : 3, assists: 4, steals: 1, blocks: 0, turnovers: 2, three_pointers_made: 2, field_goals_made: 4, field_goals_attempted: 8, free_throws_made: 2, free_throws_attempted: 2, personal_fouls: 1, double_double: false, triple_double: false, minutes_played: 14, did_not_play: false }, { onConflict: 'player_id,game_id' }))
            livePlayers.push(player)
        }
    }
    const score = (view, player) => {
        const line = player && view.liveStats[player.playerId]
        return line && !line.didNotPlay ? calculateFantasyPoints({ ...line, threePointersMade: line.threeMade, fieldGoalsMade: line.fgMade, fieldGoalsAttempted: line.fgAttempted, freeThrowsMade: line.ftMade, freeThrowsAttempted: line.ftAttempted }, view.context.league.scoring_settings) : null
    }
    const expected = view => [view.myLineup, view.oppLineup].map(lineup => {
        const points = lineup.starters.map(slot => score(view, slot.player)).filter(value => value !== null)
        return points.length ? points.reduce((a, b) => a + b, 0).toFixed(1) : '—'
    })
    assert.ok(expected(await readView(pastDate)).every(total => total !== '—' && Number(total) > 0))
    browser = await webkit.launch()
    const context = await browser.newContext({ ...devices['iPhone 14'], viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const blocked = new Set()
    await context.route('**/*', route => {
        const target = new URL(route.request().url())
        if (target.hostname === '127.0.0.1' && ['60521', '60590'].includes(target.port) || ['data:', 'blob:'].includes(target.protocol)) return route.continue()
        blocked.add(target.origin)
        return route.abort()
    })
    await context.addInitScript(({ session, userId, actorId }) => {
        localStorage.setItem('sb-127-auth-token', JSON.stringify(session))
        localStorage.setItem(`pancake:selected-league:v1:${userId}`, JSON.stringify({ version: 1, savedAt: Date.now(), value: actorId }))
    }, { session, userId: user.id, actorId })
    page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const records = []
    const band = page.getByTestId('matchup-daily-total')
    const readTotals = () => Promise.all(['left', 'right'].map(side => page.getByTestId(`matchup-daily-total-${side}`).innerText()))
    const waitTotals = async values => {
        await page.waitForFunction(values => ['left', 'right'].every((side, index) => document.querySelector(`[data-testid="matchup-daily-total-${side}"]`)?.textContent === values[index]), values)
    }
    const inspect = async (name, date, capture = true) => {
        const view = await readView(date, name.startsWith('detail'))
        const values = expected(view)
        await waitTotals(values)
        const starters = page.getByRole('heading', { name: 'Starters', exact: true }).locator('..')
        const visible = []
        for (const lineup of [view.myLineup, view.oppLineup]) {
            const rows = []
            for (const { player } of lineup.starters) {
                if (!player) continue
                const text = await starters.getByRole('button', { name: `Score breakdown for ${player.displayName}`, exact: true }).innerText()
                const value = score(view, player)
                assert.equal(text, (value ?? 0).toFixed(1))
                if (value !== null) rows.push(Number(text))
            }
            visible.push(rows.length ? rows.reduce((a, b) => a + b, 0).toFixed(1) : '—')
        }
        assert.deepEqual(await readTotals(), visible)
        await band.scrollIntoViewIfNeeded()
        const geometry = await band.evaluate(node => {
            const box = node.getBoundingClientRect()
            const style = getComputedStyle(node)
            const children = Array.from(node.children).map(child => {
                const bounds = child.getBoundingClientRect()
                const css = getComputedStyle(child)
                return { text: child.textContent, x: bounds.x, right: bounds.right, width: bounds.width, font: parseFloat(css.fontSize), clipped: child.scrollWidth > child.clientWidth, color: css.color }
            })
            const section = node.parentElement
            const next = section.nextElementSibling
            return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, x: box.x, right: box.right, height: box.height, background: style.backgroundColor, border: style.borderTopWidth, lastInStarters: node === section.lastElementChild, nextIsBench: next?.textContent?.startsWith('Bench'), children }
        })
        assert.equal(geometry.width, 390)
        assert.equal(geometry.overflow, false)
        assert.equal(geometry.lastInStarters, true)
        assert.equal(geometry.nextIsBench, true)
        assert.equal(geometry.border, '1px')
        assert.ok(geometry.x >= 0 && geometry.right <= 390)
        assert.ok(geometry.children.every(child => !child.clipped))
        assert.equal(geometry.children[0].font, 24)
        assert.equal(geometry.children[2].font, 24)
        assert.ok(Math.abs(geometry.children[1].x + geometry.children[1].width / 2 - (geometry.x + geometry.right) / 2) < 1)
        if (capture) {
            await page.screenshot({ path: path.join(output, `${name}-390.png`), scale: 'css' })
            await page.setViewportSize({ width: 390, height: 1240 })
            await page.getByTestId('matchup-page-scroll').evaluate(node => { node.scrollTop = 0 })
            await page.screenshot({ path: path.join(output, `${name}-roster-390.png`), scale: 'css' })
            await page.setViewportSize({ width: 390, height: 844 })
        }
        records.push({ name, date, totals: values, visibleStarterSums: visible, geometry })
    }
    await page.goto(frontend, { waitUntil: 'domcontentloaded' })
    await band.waitFor()
    for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { localStorage.setItem('pancake-theme', theme); document.documentElement.setAttribute('data-theme', theme) }, theme)
        await page.getByRole('button', { name: 'Wednesday, October 28', exact: true }).click()
        await inspect(`live-${theme}`, liveDate)
        await page.getByRole('button', { name: 'Monday, October 26', exact: true }).click()
        await inspect(`past-${theme}`, pastDate)
        await page.getByRole('button', { name: /^Thursday, October 29/ }).click()
        assert.deepEqual(expected(await readView(futureDate)), ['—', '—'])
        await inspect(`future-${theme}`, futureDate)
    }
    await page.getByRole('button', { name: 'Wednesday, October 28', exact: true }).click()
    await waitTotals(expected(await readView(liveDate)))
    const revised = livePlayers[0]
    await checked(admin.from('player_game_stats').update({ points: 25 }).eq('player_id', revised.playerId).eq('game_date', liveDate))
    sql(`BEGIN; SELECT private.league_version_enqueue('${league}', 'score', 'player_game_stats'); COMMIT;`)
    await inspect('live-update', liveDate, false)
    await page.goto(`${frontend}/matchup?matchupId=${matchup}`, { waitUntil: 'domcontentloaded' })
    await band.waitFor()
    await inspect('detail-live', liveDate, false)
    assert.deepEqual(errors, [])
    await writeFile(path.join(output, 'webkit-evidence.json'), JSON.stringify({ records, errors, blockedExternalOrigins: [...blocked] }, null, 2))
    const cli = path.resolve('node_modules/.bin/agent-browser')
    const browserSession = `daily-total-${randomUUID()}`
    const runBrowser = args => execFileSync(cli, ['--session', browserSession, ...args], { encoding: 'utf8', timeout: 60000 })
    execFileSync(cli, ['session', 'list'], { encoding: 'utf8' })
    try {
        runBrowser(['--executable-path', chromium.executablePath(), '--allowed-domains', '127.0.0.1', 'open', frontend])
        runBrowser(['eval', `(() => { localStorage.setItem('sb-127-auth-token', ${JSON.stringify(JSON.stringify(session))}); localStorage.setItem('pancake:selected-league:v1:${user.id}', ${JSON.stringify(JSON.stringify({ version: 1, savedAt: Date.now(), value: actorId }))}); return true })()`])
        runBrowser(['set', 'viewport', '390', '844'])
        runBrowser(['open', frontend])
        runBrowser(['wait', '--text', 'Daily Total'])
        const snapshot = runBrowser(['snapshot'])
        assert.ok(snapshot.includes('Daily Total') && snapshot.includes('Bench'))
        await writeFile(path.join(output, 'agent-browser-snapshot.txt'), snapshot)
        runBrowser(['screenshot', path.join(output, 'agent-browser-live-390.png')])
    } finally {
        runBrowser(['close'])
        let sessions = ''
        for (let attempt = 0; attempt < 25; attempt++) {
            sessions = execFileSync(cli, ['session', 'list'], { encoding: 'utf8' })
            if (!sessions.includes(browserSession)) break
            await delay(200)
        }
        assert.ok(!sessions.includes(browserSession))
    }
    console.log('PASS: six WebKit/iPhone captures, visible starter sums, day selection, live revision, other matchup, and agent-browser')
} catch (error) {
    if (page) {
        await page.screenshot({ path: path.join(output, 'failure.png') })
        await writeFile(path.join(output, 'failure.txt'), await page.locator('body').innerText())
    }
    throw error
} finally {
    await browser?.close()
    sql(`SET session_replication_role=replica; UPDATE public.league_members SET user_id='${actor.user_id}' WHERE id='${actorId}';`)
    await checked(admin.auth.admin.deleteUser(user.id))
}
