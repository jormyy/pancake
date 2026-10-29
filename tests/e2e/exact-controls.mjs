import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { readPwaRelease } from './pwa-update-release.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.EXACT_CONTROLS_PLAYWRIGHT ?? 'playwright')
const { createClient } = require('@supabase/supabase-js')
assert.equal(process.env.E2E_SUPABASE_URL, 'http://127.0.0.1:57121')
const target = new URL(process.env.SUPABASE_DB_URL)
assert.ok(['postgres:', 'postgresql:'].includes(target.protocol))
assert.equal(target.hostname, '127.0.0.1')
assert.equal(target.port, '57122')
assert.equal(target.pathname, '/postgres')
assert.equal(target.search, '')
assert.equal(target.hash, '')
const databaseEnvironment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['PGSERVICE', 'PGSERVICEFILE'].includes(key))),
    PGHOST: target.hostname,
    PGHOSTADDR: target.hostname,
    PGPORT: target.port,
    PGDATABASE: target.pathname.slice(1),
    PGUSER: decodeURIComponent(target.username),
    PGPASSWORD: decodeURIComponent(target.password),
}
const sql = query => {
    const result = spawnSync('psql', ['-XAt', '-v', 'ON_ERROR_STOP=1', '-c', query], {
        encoding: 'utf8',
        env: databaseEnvironment,
    })
    if (result.error || result.status !== 0) throw new Error('Local database query failed: ' + (result.stderr?.trim() || 'psql unavailable'))
    return result.stdout.trim()
}
if (process.argv.includes('--check-sql-errors')) {
    assert.equal(sql('select 42'), '42')
    assert.throws(() => sql('select 1/0'), error => String(error).includes('division by zero') && !String(error).includes(process.env.SUPABASE_DB_URL))
    console.log('Local SQL success and failure checks pass without connection details')
    process.exit(0)
}
const output = path.resolve(process.env.EXACT_CONTROLS_OUTPUT)
const release = await readPwaRelease(path.resolve(process.env.EXACT_CONTROLS_RELEASE))
const origin = 'http://127.0.0.1:57198'
const admin = createClient(process.env.E2E_SUPABASE_URL, process.env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const rows = query => JSON.parse(sql(`select coalesce(json_agg(result),'[]') from (${query}) result`))
const db = async query => {
    const { data, error } = await query
    assert.ifError(error)
    return data
}
const id = () => randomBytes(6).toString('hex')
const run = id()
const users = [], leagues = [], players = [], years = [], contexts = [], secrets = []
const report = { passed: false, started: new Date().toISOString(), release, cases: [], fixture: { users, leagues, players, years }, requests: [], errors: [] }
const selected = process.env.EXACT_CONTROLS_ONLY?.split(',') ?? ['home-auto-set', 'dense-row-accept', 'dense-row-reject', 'pending-claim-taxi-edit']
const save = async () => {
    const body = JSON.stringify(report, null, 2)
    for (const secret of secrets) assert.ok(!body.includes(secret))
    await writeFile(path.join(output, 'summary.json'), body + '\n')
}
const waitFor = async read => {
    for (let n = 0; n < 100; n++) {
        const value = await read()
        if (value) return value
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('Saved state did not reach the expected result')
}
const shot = async name => {
    await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, timeout: 20000 })
    await writeFile(path.join(output, name + '.txt'), await page.locator('body').innerText())
}
const makeUser = async label => {
    const password = randomBytes(24).toString('base64url') + 'aA1!'
    secrets.push(password)
    const email = `exact_${run}_${label}@example.test`
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { username: `exact_${run}_${label}`, display_name: 'Exact ' + label } })
    assert.ifError(error)
    users.push(data.user.id)
    await save()
    const client = createClient(process.env.E2E_SUPABASE_URL, process.env.E2E_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
    const signed = await client.auth.signInWithPassword({ email, password })
    assert.ifError(signed.error)
    return { id: data.user.id, client, session: signed.data.session }
}
const makePlayer = async (label, team = 'FA', position = 'PG') => {
    const player = await db(admin.from('players').insert({ first_name: 'Exact', last_name: label + ' ' + run, nba_id: 'exact-' + run + '-' + label, nba_team: team, position, eligible_positions: [position], status: 'Active', years_exp: 0, career_regular_season_games: 0 }).select('*').single())
    players.push(player.id)
    await save()
    return player
}
let browser, server, page
await mkdir(output, { recursive: true })
try {
    assert.equal(await fetch(origin).then(() => true).catch(() => false), false, 'Owned web port must be free')
    server = spawn('node', ['tests/e2e/static-web-server.mjs', '--root=' + release.root, '--port=57198', '--host=127.0.0.1'], { stdio: 'ignore' })
    await waitFor(() => fetch(origin).then(response => response.ok).catch(() => false))
    const owner = await makeUser('owner'), manager = await makeUser('manager')
    const league = await db(owner.client.rpc('create_league', { p_name: 'Exact controls ' + run, p_team_name: 'Exact opponent', p_auction_budget: 200 }))
    leagues.push(league.id)
    await save()
    await db(manager.client.rpc('join_league_by_invite_code', { p_invite_code: league.invite_code, p_team_name: 'Exact manager' }))
    const members = await db(admin.from('league_members').select('*').eq('league_id', league.id))
    const mine = members.find(member => member.user_id === manager.id), other = members.find(member => member.user_id === owner.id)
    const season = await db(admin.from('league_seasons').select('*').eq('league_id', league.id).eq('is_current', true).single())
    let year = 9000 + Math.floor(Math.random() * 900)
    while (sql(`select count(*) from season_weeks where season_year=${year}`) !== '0') year++
    years.push(year)
    await save()
    await db(admin.from('league_seasons').update({ season_year: year }).eq('id', season.id))
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    const offset = n => { const date = new Date(today + 'T12:00:00Z'); date.setUTCDate(date.getUTCDate() + n); return date.toISOString().slice(0, 10) }
    const day = new Date(today + 'T12:00:00Z').getUTCDay(), startOffset = day === 0 ? -6 : 1 - day
    await db(admin.from('season_weeks').insert({ season_year: year, week_number: 1, week_start: offset(startOffset), week_end: offset(startOffset + 6) }))
    await db(admin.from('leagues').update({ status: 'active', waiver_mode: 'faab', faab_starting_budget: 100, taxi_slots: 3, trade_veto_mode: 'member_vote', trade_veto_window_hours: 24 }).eq('id', league.id))
    await db(admin.from('matchups').insert({ league_id: league.id, league_season_id: season.id, home_member_id: mine.id, away_member_id: other.id, week_number: 1 }))
    const unlocked = await makePlayer('Ready', 'BOS'), locked = await makePlayer('Locked', 'NYK', 'C'), claimPlayer = await makePlayer('Claim')
    const acceptA = await makePlayer('AcceptA'), acceptB = await makePlayer('AcceptB'), rejectA = await makePlayer('RejectA'), rejectB = await makePlayer('RejectB')
    await db(admin.from('roster_players').insert([unlocked, locked, acceptB, rejectB].map(player => ({ league_id: league.id, league_season_id: season.id, member_id: mine.id, player_id: player.id, acquired_via: 'draft', acquisition_cost: 1 }))))
    await db(admin.from('roster_players').insert([acceptA, rejectA].map(player => ({ league_id: league.id, league_season_id: season.id, member_id: other.id, player_id: player.id, acquired_via: 'draft', acquisition_cost: 1 }))))
    await db(admin.from('nba_games').insert([
        { sportsdata_game_id: 'exact-' + run + '-ready', nba_game_id: 'exact-' + run + '-ready', season_year: year, week_number: 1, game_date: today, home_team: 'BOS', away_team: 'LAL', status: 'Scheduled', game_time: today + 'T23:59:59Z' },
        { sportsdata_game_id: 'exact-' + run + '-locked', nba_game_id: 'exact-' + run + '-locked', season_year: year, week_number: 1, game_date: today, home_team: 'NYK', away_team: 'MIA', status: 'InProgress', game_time: new Date(Date.now() - 60000).toISOString() },
    ]))
    await db(admin.from('weekly_lineups').insert({ league_id: league.id, league_season_id: season.id, member_id: mine.id, player_id: locked.id, game_date: today, week_number: 1, slot_type: 'C', is_auto_set: false }).select('*').single())
    const claim = await db(admin.from('waiver_claims').insert({ league_id: league.id, league_season_id: season.id, member_id: mine.id, player_id: claimPlayer.id, bid_amount: 7, priority_at_submission: 1, process_date: offset(2), to_taxi: false }).select('*').single())
    const seedTrade = async (a, b, label) => {
        const trade = await db(admin.from('trades').insert({ league_id: league.id, league_season_id: season.id, proposer_member_id: other.id, recipient_member_id: mine.id, status: 'pending', notes: label }).select('*').single())
        await db(admin.from('trade_participants').insert([{ trade_id: trade.id, member_id: other.id, sort_order: 0, is_initiator: true, accepted_at: new Date().toISOString() }, { trade_id: trade.id, member_id: mine.id, sort_order: 1, is_initiator: false }]))
        await db(admin.from('trade_items').insert([{ trade_id: trade.id, side: 'proposer', player_id: a.id, from_member_id: other.id, to_member_id: mine.id }, { trade_id: trade.id, side: 'recipient', player_id: b.id, from_member_id: mine.id, to_member_id: other.id }]))
        return trade
    }
    const accept = await seedTrade(acceptA, acceptB, 'Accept exact list offer'), reject = await seedTrade(rejectA, rejectB, 'Reject exact list offer')
    Object.assign(report.fixture, { member: mine.id, other: other.id, season: season.id, claim: claim.id, accept: accept.id, reject: reject.id, today, unlocked: unlocked.id, locked: locked.id })
    await save()
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: 'sb-127-auth-token', value: JSON.stringify(manager.session) }] }] } })
    contexts.push(context)
    page = await context.newPage()
    page.setDefaultTimeout(20000)
    page.on('pageerror', error => report.errors.push(error.message))
    page.on('response', async response => {
        const url = new URL(response.url())
        if (url.pathname.includes('/functions/v1/api/') && response.request().method() !== 'GET') report.requests.push({ path: url.pathname, status: response.status(), body: response.request().postDataJSON(), result: await response.json().catch(() => null) })
    })
    if (selected.includes('home-auto-set')) {
    await page.goto(origin)
    const auto = page.getByRole('button', { name: 'Open auto-set lineup options', exact: true })
    await auto.waitFor({ state: 'visible' })
    assert.equal(new URL(page.url()).pathname, '/')
    await shot('home-before')
    await auto.click()
    const sheet = page.getByRole('dialog', { name: 'Auto-set lineup', exact: true })
    await sheet.getByRole('button', { name: 'Edit lineup manually', exact: true }).waitFor({ state: 'visible' })
    assert.deepEqual(await sheet.getByRole('button').allTextContents(), ['Close', 'Edit lineup manually'])
    await shot('home-scope')
    const beforeLineups = rows(`select * from weekly_lineups where league_id='${league.id}' order by id`)
    await sheet.getByRole('button', { name: 'Edit lineup manually', exact: true }).click()
    await page.waitForURL('**/lineup')
    await page.getByRole('switch', { name: 'Keep lineup updated automatically', exact: true }).waitFor({ state: 'visible' })
    const savedLineups = rows(`select * from weekly_lineups where league_id='${league.id}' order by id`)
    assert.deepEqual(savedLineups, beforeLineups)
    await shot('home-after')
    report.cases.push({ name: 'home-auto-set', scope: 'Manual editor navigation', beforeLineups, savedLineups, passed: true })
    await save()
    }
    const assets = () => ({ roster: rows(`select * from roster_players where league_id='${league.id}' order by id`), balances: rows(`select * from faab_balances where league_id='${league.id}' order by id`), transactions: rows(`select * from roster_transactions where league_id='${league.id}' order by id`) })
    await page.goto(origin + '/trades')
    if (selected.includes('dense-row-accept')) {
    const acceptControl = page.locator(`[data-testid="trade-accept-${accept.id}"]`)
    await acceptControl.waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('dialog').count(), 0)
    const beforeAccept = assets()
    await shot('accept-before')
    await acceptControl.click()
    const confirmAccept = page.getByRole('dialog', { name: 'Accept trade?', exact: true })
    await confirmAccept.getByRole('button', { name: 'Accept', exact: true }).click()
    const savedAccept = await waitFor(() => { const value = rows(`select * from trades where id='${accept.id}'`)[0]; return value.status === 'accepted' ? value : null })
    assert.ok(savedAccept.accepted_at)
    assert.equal(savedAccept.completed_at, null)
    assert.ok(Date.parse(savedAccept.veto_window_expires_at) > Date.now() + 23 * 3600000)
    assert.deepEqual(assets(), beforeAccept)
    const reservations = rows(`select player_id,from_member_id,private.is_reserved_trade_asset('${league.id}','${season.id}',from_member_id,player_id) as reserved from trade_items where trade_id='${accept.id}' order by player_id`)
    assert.equal(reservations.length, 2)
    assert.ok(reservations.every(row => row.reserved))
    await page.waitForTimeout(700)
    await shot('accept-after')
    report.cases.push({ name: 'dense-row-accept', reviewRule: { mode: 'member_vote', hours: 24 }, before: beforeAccept, saved: savedAccept, after: assets(), reservations, passed: true })
    await save()
    }
    if (selected.includes('dense-row-reject')) {
    const beforeReject = assets()
    await page.locator(`[data-testid="trade-reject-${reject.id}"]`).waitFor({ state: 'visible' })
    await page.locator(`[data-testid="trade-reject-${reject.id}"]`).click()
    await shot('reject-confirm')
    await page.getByRole('dialog').getByRole('button', { name: 'Reject', exact: true }).click()
    const savedReject = await waitFor(() => { const value = rows(`select * from trades where id='${reject.id}'`)[0]; return value.status === 'rejected' ? value : null })
    assert.equal(savedReject.accepted_at, null)
    assert.equal(savedReject.completed_at, null)
    assert.deepEqual(assets(), beforeReject)
    const rejectCase = { name: 'dense-row-reject', before: beforeReject, saved: savedReject, after: assets(), passed: false }
    report.cases.push(rejectCase)
    await save()
    await page.locator(`[data-testid="trade-reject-${reject.id}"]`).waitFor({ state: 'hidden' })
    await page.getByText('History', { exact: true }).click()
    await page.getByText('Rejected', { exact: true }).first().waitFor({ state: 'visible' })
    await shot('reject-after')
    Object.assign(rejectCase, { feedback: 'Offer leaves the incoming list; History shows Rejected', passed: true })
    await save()
    }
    if (selected.includes('pending-claim-taxi-edit')) {
    await page.goto(origin + '/roster')
    const taxi = page.getByRole('switch', { name: `Place ${claimPlayer.display_name} on taxi`, exact: true })
    await taxi.waitFor({ state: 'visible' })
    assert.equal(await taxi.isChecked(), false)
    const beforeClaim = rows(`select * from waiver_claims where id='${claim.id}'`)[0], beforeEdit = assets()
    await taxi.scrollIntoViewIfNeeded()
    await shot('claim-before')
    await taxi.click()
    const savedClaim = await waitFor(() => { const value = rows(`select * from waiver_claims where id='${claim.id}'`)[0]; return value.to_taxi ? value : null })
    assert.ok(Date.parse(savedClaim.submitted_at) >= Date.parse(beforeClaim.submitted_at))
    assert.deepEqual(savedClaim, { ...beforeClaim, to_taxi: true, submitted_at: savedClaim.submitted_at })
    assert.equal(savedClaim.status, 'pending')
    assert.equal(savedClaim.processed_at, null)
    assert.deepEqual(assets(), beforeEdit)
    assert.equal(sql(`select count(*) from roster_players where player_id='${claimPlayer.id}'`), '0')
    await page.reload()
    await page.getByRole('switch', { name: `Place ${claimPlayer.display_name} on taxi`, exact: true }).waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('switch', { name: `Place ${claimPlayer.display_name} on taxi`, exact: true }).isChecked(), true)
    await page.getByRole('switch', { name: `Place ${claimPlayer.display_name} on taxi`, exact: true }).scrollIntoViewIfNeeded()
    await shot('claim-after')
    report.cases.push({ name: 'pending-claim-taxi-edit', before: beforeClaim, saved: savedClaim, beforeAssets: beforeEdit, afterAssets: assets(), player: { id: claimPlayer.id, yearsExp: claimPlayer.years_exp, careerGames: claimPlayer.career_regular_season_games }, taxiCapacity: 3, persistedAfterReload: true, passed: true })
    }
    assert.equal(report.errors.length, 0)
    assert.equal(report.cases.length, selected.length)
    report.passed = true
} catch (error) {
    report.failure = error.message
    await save()
    if (page) await shot('failure').catch(() => {})
    process.exitCode = 1
} finally {
    for (const context of contexts) await context.close()
    if (browser) await browser.close()
    if (server) { server.kill(); await new Promise(resolve => server.once('exit', resolve)) }
    report.cleanup = { browserClosed: true, webStopped: true }
    for (const league of leagues) {
        await db(admin.from('trades').update({ status: 'vetoed', vetoed_at: new Date().toISOString() }).eq('league_id', league).eq('status', 'accepted'))
        await db(admin.from('roster_transactions').delete().eq('league_id', league))
        await db(admin.from('leagues').delete().eq('id', league))
        sql(`delete from league_change_hints where league_id='${league}'`)
    }
    for (const user of users) {
        const { error } = await admin.auth.admin.deleteUser(user)
        assert.ifError(error)
        sql(`delete from auth.audit_log_entries where payload->>'actor_id'='${user}'`)
    }
    for (const year of years) {
        await db(admin.from('nba_games').delete().eq('season_year', year))
        await db(admin.from('season_weeks').delete().eq('season_year', year))
    }
    for (const player of players) await db(admin.from('players').delete().eq('id', player))
    report.cleanup.fixturesRemoved = true
    report.ended = new Date().toISOString()
    await save()
    console.log(JSON.stringify({ passed: report.passed, cases: report.cases.map(row => row.name), failure: report.failure, cleanup: report.cleanup }))
}
