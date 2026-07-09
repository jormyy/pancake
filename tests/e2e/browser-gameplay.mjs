import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { captureBrowserScreenshot, clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'

const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-gameplay-report.md')

const browser = createBrowser({ cwd: ROOT })
const listSessions = () => listBrowserSessions({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const createConfirmedUser = async (admin, user) => {
  const { data, error } = await admin.auth.admin.createUser({
    email: user.email,
    password: user.password,
    email_confirm: true,
    user_metadata: {
      username: user.username,
      display_name: user.displayName,
    },
  })
  if (error) throw new Error(`createUser ${user.email}: ${error.message}`)
  if (!data.user) throw new Error(`createUser ${user.email}: no user returned`)
  return { ...user, id: data.user.id }
}

const signInClient = async (env, email, password) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return client
}

const fetchCurrentSeason = async (admin, leagueId) => {
  const { data, error } = await admin
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', leagueId)
    .eq('is_current', true)
    .single()
  if (error) throw new Error(`current season lookup: ${error.message}`)
  return data
}

const sortedLeagueMembers = async (admin, leagueId) => {
  const { data, error } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(`league members lookup: ${error.message}`)
  return data ?? []
}

const findAvailablePlayer = async (admin, leagueId, leagueSeasonId) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin
      .from('roster_players')
      .select('player_id')
      .eq('league_id', leagueId)
      .eq('league_season_id', leagueSeasonId),
    admin
      .from('players')
      .select('id, display_name')
      .order('display_name', { ascending: true })
      .limit(200),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const player = (players ?? []).find((row) => row.display_name && !rosteredIds.has(row.id))
  if (!player) throw new Error('D.SET.4 browser auction: no available player found')
  return player
}

const setupAuctionGameplayFixture = async (env, season) => {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}`
  const password = `Pancake-gameplay-${runId}!`
  const users = [1, 2].map((n) => ({
    email: `pancake-gameplay-${runId}-${n}@example.com`,
    password,
    username: `pancake_gameplay_${runId}_${n}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Gameplay ${runId} #${n}`,
    teamName: `Gameplay Team ${n}`,
  }))

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const createdUsers = []
  for (const user of users) {
    createdUsers.push(await createConfirmedUser(admin, user))
  }

  const { error: profileError } = await admin.from('profiles').upsert(
    createdUsers.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    })),
    { onConflict: 'id' },
  )
  if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

  const commissioner = await signInClient(env, createdUsers[0].email, password)
  const { data: league, error: createError } = await commissioner.rpc('create_league', {
    p_name: `Pancake Browser Gameplay ${runId}`,
    p_team_name: createdUsers[0].teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)

  const bidderClient = await signInClient(env, createdUsers[1].email, password)
  const { error: joinError } = await bidderClient.rpc('join_league_by_invite_code', {
    p_invite_code: league.invite_code,
    p_team_name: createdUsers[1].teamName,
  })
  if (joinError) throw new Error(`join_league_by_invite_code: ${joinError.message}`)

  const currentSeason = await fetchCurrentSeason(admin, league.id)
  const members = await sortedLeagueMembers(admin, league.id)
  if (members.length !== 2) throw new Error(`D.SET.4 browser auction: expected 2 members, got ${members.length}`)
  const nominator = members.find((member) => member.user_id === createdUsers[0].id)
  const bidder = members.find((member) => member.user_id === createdUsers[1].id)
  if (!nominator || !bidder) throw new Error('D.SET.4 browser auction: member lookup failed')

  const player = await findAvailablePlayer(admin, league.id, currentSeason.id)
  const now = new Date().toISOString()
  const { data: draft, error: draftError } = await admin
    .from('drafts')
    .insert({
      league_id: league.id,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'in_progress',
      budget_per_team: 200,
      started_at: now,
      current_nomination_order: 1,
    })
    .select('id')
    .single()
  if (draftError) throw new Error(`auction draft insert: ${draftError.message}`)

  const [{ error: orderError }, { error: budgetError }] = await Promise.all([
    admin.from('draft_orders').insert(members.map((member, index) => ({
      draft_id: draft.id,
      member_id: member.id,
      position: index + 1,
    }))),
    admin.from('draft_budgets').insert(members.map((member) => ({
      draft_id: draft.id,
      member_id: member.id,
      initial_budget: 200,
      remaining: 200,
    }))),
  ])
  if (orderError) throw new Error(`auction order insert: ${orderError.message}`)
  if (budgetError) throw new Error(`auction budget insert: ${budgetError.message}`)

  const { data: nomination, error: nominationError } = await admin
    .from('nominations')
    .insert({
      draft_id: draft.id,
      nominating_member_id: nominator.id,
      player_id: player.id,
      nomination_order: 1,
      status: 'open',
      current_bid_amount: 1,
      current_bidder_id: null,
      countdown_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (nominationError) throw new Error(`auction nomination insert: ${nominationError.message}`)

  return {
    admin,
    runId,
    password,
    league,
    users: createdUsers,
    members,
    currentSeason,
    draft,
    nomination,
    player,
    bidder,
  }
}

const signInBrowser = async (session, env, user, password) => {
  await installRuntimeOverrides(browser, session, env)
  await browser(session, ['wait', '1500'])
  await fillSignInCredentials(browser, session, user.email, password)
  await clickButtonByName(browser, session, 'Sign In')
  await browser(session, ['wait', '4000'])
}

const assertPageText = async (session, required, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const text = document.body?.innerText || '';
      const required = ${JSON.stringify(required)};
      return JSON.stringify({
        ok: required.every((value) => text.includes(value)),
        missing: required.filter((value) => !text.includes(value)),
        sample: text.slice(0, 800)
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label} missing page text: ${parsed.missing.join(', ')}. Sample: ${parsed.sample}`)
  return parsed
}

const clickExactText = async (session, text, label, { preferDom = false } = {}) => {
  if (!preferDom) {
    try {
    await browser(session, ['find', 'role', 'button', 'click', '--name', text])
    return { ok: true, method: 'agent-browser-find-role-button' }
    } catch {
      // Continue through the text and DOM fallbacks below.
    }
  }

  const output = await browser(session, [
    'eval',
    `(() => {
      const exact = ${JSON.stringify(text)};
      const exactText = (value) => (value || '').replace(/\\s+/g, ' ').trim() === exact;
      const buttonTarget = [...document.querySelectorAll('[role="button"], button, [tabindex]')]
        .reverse()
        .find((element) => exactText(element.getAttribute('aria-label')) || exactText(element.textContent));
      const textNode = [...document.querySelectorAll('*')]
        .reverse()
        .find((element) => exactText(element.textContent));
      const target = buttonTarget || textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1000) });
      const rect = target.getBoundingClientRect?.() || { left: 0, top: 0, width: 1, height: 1 };
      const clientX = rect.left + rect.width / 2;
      const clientY = rect.top + rect.height / 2;
      const pointerInit = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX, clientY };
      const mouseInit = { bubbles: true, cancelable: true, clientX, clientY };
      target.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
      target.dispatchEvent(new MouseEvent('mousedown', mouseInit));
      target.dispatchEvent(new PointerEvent('pointerup', pointerInit));
      target.dispatchEvent(new MouseEvent('mouseup', mouseInit));
      target.click();
      return JSON.stringify({
        ok: true,
        method: 'dom-dispatch',
        tagName: target.tagName,
        role: target.getAttribute('role'),
        ariaLabel: target.getAttribute('aria-label'),
        ariaDisabled: target.getAttribute('aria-disabled'),
        text: target.textContent,
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: text not found: ${text}. Body: ${parsed.body}`)
  return parsed
}

const waitForAuctionBid = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyAuctionBid(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyAuctionBid(fixture)
  }
  return last
}

const verifyAuctionBid = async (fixture) => {
  const [{ data: nomination, error: nominationError }, { data: bids, error: bidsError }] = await Promise.all([
    fixture.admin
      .from('nominations')
      .select('id, current_bid_amount, current_bidder_id, countdown_expires_at')
      .eq('id', fixture.nomination.id)
      .single(),
    fixture.admin
      .from('bids')
      .select('id, nomination_id, member_id, amount')
      .eq('nomination_id', fixture.nomination.id)
      .eq('member_id', fixture.bidder.id)
      .eq('amount', 2),
  ])
  if (nominationError) throw new Error(`auction nomination verify: ${nominationError.message}`)
  if (bidsError) throw new Error(`auction bids verify: ${bidsError.message}`)
  const failures = []
  if (nomination.current_bid_amount !== 2) {
    failures.push(`current_bid_amount=${nomination.current_bid_amount}; expected 2`)
  }
  if (nomination.current_bidder_id !== fixture.bidder.id) {
    failures.push(`current_bidder_id=${nomination.current_bidder_id}; expected ${fixture.bidder.id}`)
  }
  if ((bids ?? []).length !== 1) {
    failures.push(`bid rows=${(bids ?? []).length}; expected 1`)
  }
  return { nomination, bids: bids ?? [], failures }
}

const closeTestNomination = async (fixture) => {
  const past = new Date(Date.now() - 1000).toISOString()
  const { error: expireError } = await fixture.admin
    .from('nominations')
    .update({ countdown_expires_at: past })
    .eq('id', fixture.nomination.id)
    .eq('status', 'open')
  if (expireError) throw new Error(`auction nomination cleanup expire: ${expireError.message}`)

  const { error: closeError } = await fixture.admin.rpc('close_auction_nomination_atomic', {
    p_nomination_id: fixture.nomination.id,
  })
  if (closeError) throw new Error(`auction nomination cleanup close: ${closeError.message}`)
}

export async function runBrowserGameplayScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupAuctionGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-gameplay-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-gameplay')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Bidder: ${fixture.users[1].email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[1], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${fixture.draft.id}`)])
    await browser(session, ['wait', '2500'])
    await assertPageText(session, ['Auction Draft', fixture.player.display_name, 'Bid $2'], 'auction draft room before bid')
    debug = { ...debug, beforeScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'auction-before-bid.png') }
    let clickResult = await clickExactText(session, 'Bid $2', 'auction bid button')
    let auctionBid = await waitForAuctionBid(fixture, 3_000)
    if (auctionBid.failures.length > 0 && clickResult.method === 'agent-browser-find-role-button') {
      const retryClick = await clickExactText(session, 'Bid $2', 'auction bid button', { preferDom: true })
      auctionBid = await waitForAuctionBid(fixture)
      clickResult = { ...clickResult, retryClick }
    }
    debug = { ...debug, clickResult, auctionBid }
    if (auctionBid.failures.length > 0) {
      throw new Error(`auction bid did not persist: ${auctionBid.failures.join('; ')}`)
    }
    await browser(session, ['wait', '5500'])
    await assertPageText(session, ['$2', "You're leading"], 'auction draft room after bid')
    debug = { ...debug, afterScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'auction-after-bid.png') }

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...auctionBid.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    await closeTestNomination(fixture)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        draftId: fixture.draft.id,
        nominationId: fixture.nomination.id,
        playerId: fixture.player.id,
        bidderMemberId: fixture.bidder.id,
      },
      auctionBid,
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser gameplay scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const auctionBid = await verifyAuctionBid(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    const cleanupError = await closeTestNomination(fixture).then(() => null).catch((cleanup) => cleanup.message)
    debug = { ...debug, auctionBid, cleanupError, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        draftId: fixture.draft.id,
        nominationId: fixture.nomination.id,
        playerId: fixture.player.id,
        bidderMemberId: fixture.bidder.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  runBrowserGameplayScenario({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
