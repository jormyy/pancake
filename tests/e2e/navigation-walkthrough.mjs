import { navigationEvidenceFailures } from './navigation-evidence.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv } from './env.mjs'
import { ensureSweepDrafts } from './browser-smoke.mjs'
import { ensureSyntheticSeasonWeeks } from './soak-fixtures.mjs'
import { openWebTarget, WEB_TARGETS, waitForWebAuthForm, waitForWebTargetReady, waitForWebTargetReads, readWebLayout } from './web-targets-browser.mjs'

const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
const frontend = process.env.E2E_FRONTEND_URL
for (const address of [env.supabaseUrl, frontend]) {
  const url = new URL(address)
  assert.equal(url.hostname, '127.0.0.1', 'Navigation evidence requires isolated loopback services')
  assert.match(url.port, /^598\d\d$/)
}
const output = path.resolve(process.env.E2E_NAVIGATION_EVIDENCE_DIR ?? '../navigation-evidence')
assert.ok(!output.startsWith(`${process.cwd()}/`), 'Evidence stays outside the checkout')
await mkdir(output, { recursive: true })
const state = JSON.parse(await readFile('tests/e2e-state.json', 'utf8'))
const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
const checked = async query => {
  const result = await query
  if (result.error) throw new Error(result.error.message)
  return result.data
}
const season = await checked(admin.from('league_seasons').select('id,season_year').eq('league_id', state.leagueId).eq('is_current', true).single())
await ensureSyntheticSeasonWeeks(admin, season.season_year, 26, 'Navigation calendar')
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
const week = await checked(admin.from('season_weeks').select('week_number').eq('season_year', season.season_year).lte('week_start', today).gte('week_end', today).single())
const members = await checked(admin.from('league_members').select('id,user_id,team_name,role').eq('league_id', state.leagueId))
const me = members.find(member => member.user_id === state.users[0].id)
const manager = members.find(member => member.user_id === state.users[1].id)
assert.ok(me && manager)
await checked(admin.from('leagues').update({ status: 'active', waiver_mode: 'faab' }).eq('id', state.leagueId))
await checked(admin.from('matchups').delete().eq('league_id', state.leagueId))
await checked(admin.from('matchups').insert({ league_id: state.leagueId, league_season_id: season.id, week_number: week.week_number, home_member_id: me.id, away_member_id: manager.id, home_points: 124.5, away_points: 118.2 }))
const fixturePlayers = await checked(admin.from('players').select('id,nba_team').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id').limit(2))
for (const [index, member] of [me, manager].entries()) {
  const existing = await checked(admin.from('roster_players').select('id').eq('league_id', state.leagueId).eq('member_id', member.id).limit(1))
  if (!existing.length) await checked(admin.from('roster_players').insert({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: fixturePlayers[index].id, acquired_via: 'navigation-fixture', acquisition_cost: 1 }))
}
const player = await checked(admin.from('players').select('id').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id').limit(1).single())
const claimPlayer = await checked(admin.from('players').select('id').like('sportsdata_id', 'e2e-player-%').order('sportsdata_id', { ascending: false }).limit(1).single())
const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86400000).toISOString().slice(0, 10)
for (const [index, member] of [me, manager].entries()) {
  await checked(admin.from('faab_balances').upsert({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, balance: 100 }, { onConflict: 'league_id,league_season_id,member_id' }))
  const claims = await checked(admin.from('waiver_claims').select('id').eq('member_id', member.id).eq('player_id', claimPlayer.id).eq('status', 'pending'))
  if (!claims.length) await checked(admin.from('waiver_claims').insert({ league_id: state.leagueId, league_season_id: season.id, member_id: member.id, player_id: claimPlayer.id, priority_at_submission: index + 1, process_date: tomorrow, bid_amount: 5 }))
}
const drafts = await ensureSweepDrafts(admin, state, members)
const routes = [
  ['home', '/'], ['roster', '/roster'], ['players', '/players'], ['trades', '/trades'], ['league', '/league'],
  ['dynasty', '/dynasty'], ['profile', '/profile'], ['create-league', '/create-league'], ['join-league', '/join-league'],
  ['commissioner-settings', '/commissioner-settings'], ['change-password', '/change-password'], ['notification-settings', '/notification-settings'],
  ['lineup', '/lineup'], ['bracket', '/bracket'], ['timeline', '/timeline'], ['draft-launcher', '/draft'], ['not-found', '/navigation-missing'],
  ['claim-player', `/claim-player?playerId=${claimPlayer.id}`], ['player-detail', `/player/${player.id}`],
  ['propose-trade', `/propose-trade?recipientMemberId=${manager.id}`], ['team-roster', `/team-roster?memberId=${manager.id}`],
  ['draft-room', `/draft-room?draftId=${drafts.auctionDraft.id}`], ['rookie-draft-room', `/rookie-draft-room?draftId=${drafts.rookieDraft.id}`],
  ...['results', 'history', 'picks', 'draft', 'settings'].map(tab => [`league-${tab}`, `/league?tab=${tab}`]),
  ...['waivers', 'rankings', 'news'].map(section => [`players-${section}`, `/players?section=${section}`]),
]
const report = { status: 'FAIL', generatedAt: new Date().toISOString(), viewport: { width: 390, height: 844 }, engine: 'WebKit', simulation: 'iPhone viewport and safe areas; no physical device claims', accounts: [], timelinePresent: false }
const target = WEB_TARGETS.find(item => item.id === 'iphone-webkit-390-tab')
for (const [role, user] of [['commissioner', state.users[0]], ['manager', state.users[1]]].filter(([role]) => !process.env.E2E_NAVIGATION_ROLE || role === process.env.E2E_NAVIGATION_ROLE)) {
  const directory = path.join(output, role)
  await mkdir(directory, { recursive: true })
  const { browser, context, page } = await openWebTarget(target, directory)
  let lockGameId = null
  const result = { role, routes: [], journeys: [], errors: [], blockedRemoteRequests: [], authRequests: [], authResponses: [], targets: [] }
  report.accounts.push(result)
  page.on('pageerror', error => result.errors.push(error.message))
  page.on('request', request => {
    if (!request.url().includes('/auth/v1/token')) return
    const body = request.postDataJSON()
    const detail = { emailMatches: body.email === user.email, passwordMatches: body.password === state.password, apiKeyMatches: request.headers().apikey === env.anonKey, origin: new URL(request.url()).origin }
    assert.equal(detail.origin, new URL(env.supabaseUrl).origin, 'The browser must use this lane’s local auth server')
    result.authRequests.push(detail)
    console.log(JSON.stringify({ role, authRequest: detail }))
  })
  page.on('response', async response => {
    if (response.url().includes('/auth/v1/token')) {
      result.authResponses.push(response.status())
      const body = await response.json().catch(() => ({}))
      console.log(JSON.stringify({ role, authStatus: response.status(), errorCode: body.error_code, message: body.msg ?? body.message }))
    }
  })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (![new URL(env.supabaseUrl).origin, new URL(frontend).origin].includes(url.origin)) {
      result.blockedRemoteRequests.push(`${url.origin}${url.pathname}`)
      return route.abort()
    }
    return route.continue()
  })
  const targetSize = async locator => {
    const box = await locator.boundingBox()
    assert.ok(box && box.width >= 44 && box.height >= 44, 'Daily and navigation targets must be at least 44 pixels')
    result.targets.push({ label: await locator.getAttribute('aria-label') ?? await locator.innerText(), width: box.width, height: box.height })
  }
  const save = async name => {
    await waitForWebTargetReads(page)
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, timeout: 20000 })
    const layout = await readWebLayout(page, target.insets)
    assert.ok(layout.overflow <= 1, `${role}/${name}: horizontal overflow ${layout.overflow}`)
    for (const input of layout.inputs) assert.ok(input.font >= 16, `${role}/${name}: small input ${input.label}`)
    return layout
  }
  const visit = async route => {
    await page.goto(new URL(route, frontend).href)
    await waitForWebTargetReady(page)
    await waitForWebTargetReads(page)
  }
  try {
    await page.goto(new URL('/sign-up', frontend).href)
    await waitForWebAuthForm(page, 'you@example.com')
    await save('auth-sign-up')
    result.routes.push({ name: 'auth-sign-up', status: 'PASS' })
    await page.goto(new URL('/sign-in', frontend).href)
    await waitForWebAuthForm(page, 'you@example.com')
    await save('auth-sign-in')
    result.routes.push({ name: 'auth-sign-in', status: 'PASS' })
    await page.getByPlaceholder('you@example.com', { exact: true }).fill(user.email)
    await page.locator('input[type="password"]').fill(state.password)
    assert.equal(await page.getByPlaceholder('you@example.com', { exact: true }).inputValue(), user.email)
    assert.equal(await page.locator('input[type="password"]').inputValue(), state.password)
    await page.getByRole('button', { name: 'Sign In', exact: true }).tap()
    await page.waitForURL(url => url.pathname === '/', { timeout: 45000 })
    await waitForWebTargetReady(page)
    for (const [name, route] of routes) {
      console.log(`${role}: ${name}`)
      const entry = { name, route: route.split('?')[0], status: 'FAIL' }
      result.routes.push(entry)
      try {
        await visit(route)
        const content = await page.getByRole('main').innerText()
        assert.ok(content.trim().length > 5, `${name}: blank main content`)
        entry.layout = await save(name)
        entry.status = 'PASS'
        if (name === 'home') {
          assert.ok(content.includes('Keep updated automatically'), 'Home must contain the shared inline preference')
          assert.ok(content.includes('Next run') || content.includes('due for processing'), 'Home must contain waiver timing')
          assert.ok(content.includes('pending claim'), 'Home must show a loaded pending count')
          const headings = await page.getByRole('main').getByRole('heading').allTextContents()
          entry.headings = headings
        }
        if (name === 'timeline') {
          report.timelinePresent ||= !content.includes('The season timeline could not load.')
          entry.contentState = content.includes('The season timeline could not load.') ? 'guarded-missing-screen' : 'timeline-screen'
        }
      } catch (error) {
        entry.status = 'FAIL'
        entry.error = error.message
        await page.screenshot({ path: path.join(directory, `${name}-failure.png`), fullPage: true }).catch(() => {})
      }
      await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
    }
    const journeys = [
      ['Standings', '/league', 'Standings'], ['Activity', '/league', 'Activity'], ['Picks', '/league', 'Picks and draft board'],
      ['Playoffs', '/bracket', 'Playoffs'], ['Settings', '/league', 'League settings'], ['Timeline', '/timeline', 'Season timeline'],
      ['Draft', '/draft', 'Draft Room'], ['Profile', '/profile', 'Profile & settings'], ['Notifications', '/notification-settings', 'Notifications'],
      ['Password', '/change-password', 'Change password'], ['Create league', '/create-league', 'Create a League'], ['Join league', '/join-league', 'Join with Invite Code'],
      ...(role === 'commissioner' ? [['Commissioner', '/commissioner-settings', 'Commissioner']] : []),
    ]
    for (const [name, expected, label] of journeys) {
      const journey = { name, taps: 0, status: 'FAIL' }
      result.journeys.push(journey)
      try {
        await visit('/')
        await page.getByRole('navigation', { name: 'Primary', exact: true }).getByRole('link', { name: 'League', exact: true }).tap()
        journey.taps += 1
        await targetSize(page.getByRole('button', { name: label, exact: true }))
        await page.getByRole('button', { name: label, exact: true }).tap()
        journey.taps += 1
        await page.waitForURL(url => url.pathname === expected)
        await waitForWebTargetReady(page)
        await save(`entry-${name.toLowerCase().replaceAll(' ', '-')}`)
        journey.status = 'PASS'
      } catch (error) { journey.error = error.message }
    }
    await visit('/league')
    if (role === 'manager') assert.equal(await page.getByRole('button', { name: 'Commissioner', exact: true }).count(), 0)
    await visit('/')
    await page.getByRole('button', { name: 'Toggle matchup details', exact: true }).tap()
    await save('matchup-details')
    result.journeys.push({ name: 'Matchup details', taps: 1, status: 'PASS' })
    await visit('/')
    await page.getByRole('button', { name: /^Edit claim: / }).tap()
    await page.waitForURL(url => url.pathname === '/claim-player' && url.searchParams.has('claimId'))
    await save('entry-edit-claim')
    result.journeys.push({ name: 'Edit pending claim', taps: 1, status: 'PASS' })
    await visit('/')
    const slot = role === 'commissioner' ? 'PG' : 'SG'
    const bench = page.getByRole('button', { name: /^Bench E2E Player/ }).first()
    const starter = page.getByRole('button', { name: new RegExp(`^${slot} E2E Player`) }).first()
    if (await starter.count()) {
      await starter.tap()
      await page.getByRole('button', { name: 'Empty bench slot', exact: true }).first().tap()
      await bench.waitFor()
    }
    const playerLabel = (await bench.getAttribute('aria-label')).replace(/^Bench /, '')
    await targetSize(bench)
    await bench.tap()
    await targetSize(page.getByRole('button', { name: `Empty ${slot} slot`, exact: true }))
    await page.getByRole('button', { name: `Empty ${slot} slot`, exact: true }).tap()
    await page.getByRole('button', { name: `${slot} ${playerLabel}`, exact: true }).waitFor()
    await page.getByRole('button', { name: `${slot} ${playerLabel}`, exact: true }).scrollIntoViewIfNeeded()
    await save('inline-lineup-saved')
    result.journeys.push({ name: 'Inline lineup swap', taps: 2, status: 'PASS' })
    await visit('/')
    await page.getByRole('button', { name: 'Manage claims', exact: true }).scrollIntoViewIfNeeded()
    await save('home-waivers')
    await targetSize(page.getByRole('button', { name: 'Manage claims', exact: true }))
    await page.getByRole('button', { name: 'Manage claims', exact: true }).tap()
    await page.waitForURL(url => url.searchParams.get('section') === 'waivers')
    await save('entry-waivers')
    result.journeys.push({ name: 'Waivers', taps: 1, status: 'PASS' })
    lockGameId = `e2e-navigation-lock-${state.runId}-${role}`
    const team = fixturePlayers[role === 'commissioner' ? 0 : 1].nba_team
    await checked(admin.from('nba_games').insert({ sportsdata_game_id: lockGameId, nba_game_id: lockGameId, season_year: season.season_year, game_date: today, week_number: week.week_number, home_team: team, away_team: 'MIA', status: 'Scheduled', game_status_text: 'Navigation past tipoff', game_time: new Date(Date.now() - 60000).toISOString() }))
    await visit('/')
    const locked = page.getByRole('button', { name: `${slot} ${playerLabel}`, exact: true })
    await locked.scrollIntoViewIfNeeded()
    assert.equal(await locked.isDisabled(), true, 'Started players must stay locked on Home')
    await save('inline-lineup-locked')
    result.journeys.push({ name: 'Locked lineup', taps: 0, status: 'PASS' })
  } catch (error) {
    result.error = error.message
    await page.screenshot({ path: path.join(directory, 'walkthrough-failure.png'), fullPage: true }).catch(() => {})
  } finally {
    if (lockGameId) await checked(admin.from('nba_games').delete().eq('sportsdata_game_id', lockGameId))
    await context.close()
    await browser.close()
    await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}
const expectedRoles = process.env.E2E_NAVIGATION_ROLE ? [process.env.E2E_NAVIGATION_ROLE] : ['commissioner', 'manager']
assert.ok(expectedRoles.every(role => ['commissioner', 'manager'].includes(role)))
report.failures = navigationEvidenceFailures(report, ['auth-sign-in', 'auth-sign-up', ...routes.map(([label]) => label)], expectedRoles)
report.status = report.failures.length ? 'FAIL' : 'PASS'
await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ status: report.status, accounts: report.accounts.map(account => ({ role: account.role, routePass: account.routes.filter(route => route.status === 'PASS').length, routeFail: account.routes.filter(route => route.status === 'FAIL').length, journeyPass: account.journeys.filter(journey => journey.status === 'PASS').length, error: account.error })), timelinePresent: report.timelinePresent }))
if (report.status !== 'PASS') process.exitCode = 1
