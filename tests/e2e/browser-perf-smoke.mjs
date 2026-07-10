import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { browserDiagnosticFailures, installRuntimeOverrides } from './browser-runtime-overrides.mjs'
import { clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { combineNavigationPhases, measureJavaScriptDelivery, measureNavigationTiming, measureWorkflowFeedback } from './browser-performance-evidence.mjs'
import { createDisposableLeagueFromSeedUsers } from './soak-fixtures.mjs'
import { resolveReleaseProvenance } from './release-provenance.mjs'

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-perf-report.md')
const PERFORMANCE_BUDGETS = JSON.parse(readFileSync(path.join(ROOT, 'tests/e2e/performance-budgets.json'), 'utf8')).globalBudgets

const BROWSER_SETTLE_MS = Number(process.env.E2E_BROWSER_PERF_SETTLE_MS ?? 2000)
const MUTATION_COUNT = Number(process.env.E2E_BROWSER_PERF_MUTATIONS ?? 24)
const MAX_HEARTBEAT_LAG_MS = Number(process.env.E2E_BROWSER_PERF_MAX_LAG_MS ?? 600)
const MAX_SCRIPT_MS = Number(process.env.E2E_BROWSER_PERF_MAX_SCRIPT_MS ?? 30000)
const MAX_FEEDBACK_MS = Number(process.env.E2E_BROWSER_PERF_MAX_FEEDBACK_MS ?? 100)
const MAX_LONG_TASK_MS = Number(process.env.E2E_BROWSER_PERF_MAX_LONG_TASK_MS ?? PERFORMANCE_BUDGETS.longTaskMs)
const BROWSER_COMMAND_TIMEOUT_MS = Number(process.env.E2E_BROWSER_PERF_COMMAND_TIMEOUT_MS ?? 90_000)

const readState = async () => JSON.parse(await readFile(STATE_PATH, 'utf8'))

const browser = createBrowser({ cwd: ROOT, defaultTimeout: BROWSER_COMMAND_TIMEOUT_MS })

const listSessions = () => listBrowserSessions({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const postDraftLifecycle = async (env, user, password, draftId, action) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { data, error } = await client.auth.signInWithPassword({ email: user.email, password })
  if (error || !data.session?.access_token) throw new Error(`D.X.4 ${action} sign-in failed: ${error?.message ?? 'missing access token'}`)
  const response = await fetch(joinUrl(env.apiBaseUrl, `draft/${draftId}/${action}`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const ensurePerfSeasonWeek = async (supabase, seasonYear, resourceOwner) => {
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  const { error } = await supabase.from('season_weeks').insert({
    season_year: seasonYear,
    week_number: 1,
    week_start: start.toISOString().slice(0, 10),
    week_end: end.toISOString().slice(0, 10),
  })
  if (error) throw new Error(`D.X.4 perf season week insert failed: ${error.message}`)
  resourceOwner.register(`perf season week ${seasonYear}`, async () => {
    const { error: deleteError } = await supabase.from('season_weeks').delete()
      .eq('season_year', seasonYear).eq('week_number', 1)
    if (deleteError) throw new Error(`D.X.4 perf season week cleanup failed: ${deleteError.message}`)
  })
}

const fetchSingle = async (supabase, table, select, filters) => {
  let query = supabase.from(table).select(select)
  for (const [key, value] of Object.entries(filters)) {
    query = query.eq(key, value)
  }
  const { data, error } = await query.single()
  if (error) throw new Error(`${table} lookup failed: ${error.message}`)
  return data
}

const sortedLeagueMembers = async (supabase, leagueId) => {
  const { data, error } = await supabase
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(`league_members lookup failed: ${error.message}`)
  return data ?? []
}

const findAvailablePlayer = async (supabase, leagueId, leagueSeasonId) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    supabase
      .from('roster_players')
      .select('player_id')
      .eq('league_id', leagueId)
      .eq('league_season_id', leagueSeasonId),
    supabase
      .from('players')
      .select('id, display_name')
      .order('display_name', { ascending: true })
      .limit(200),
  ])
  if (rosterError) throw new Error(`roster_players lookup failed: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup failed: ${playersError.message}`)

  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const player = (players ?? []).find((row) => row.display_name && !rosteredIds.has(row.id))
  if (player) return player
  throw new Error('D.X.4 perf fixture has no available player among the first 200 player rows')
}

const ensurePerfAuction = async (supabase, state) => {
  if (!state.leagueId) throw new Error('D.X.4: tests/e2e-state.json is missing leagueId')
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: state.leagueId, is_current: true },
  )
  const members = (await sortedLeagueMembers(supabase, state.leagueId)).slice(0, 2)
  if (members.length !== 2) throw new Error('D.X.4: browser perf auction requires two league members')
  const player = await findAvailablePlayer(supabase, state.leagueId, currentSeason.id)
  const now = new Date().toISOString()

  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .insert({
      league_id: state.leagueId,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'paused',
      budget_per_team: 1000,
      started_at: now,
      paused_at: now,
      pause_reason: 'manual',
      timer_paused_remaining_seconds: 600,
      current_nomination_order: 1,
    })
    .select('id')
    .single()
  if (draftError) throw new Error(`D.X.4 auction draft insert failed: ${draftError.message}`)

  const [{ error: orderError }, { error: budgetError }] = await Promise.all([
    supabase.from('draft_orders').insert(members.map((member, index) => ({
      draft_id: draft.id,
      member_id: member.id,
      position: index + 1,
    }))),
    supabase.from('draft_budgets').insert(members.map((member) => ({
      draft_id: draft.id,
      member_id: member.id,
      initial_budget: 1000,
      remaining: 1000,
    }))),
  ])
  if (orderError) throw new Error(`D.X.4 auction order insert failed: ${orderError.message}`)
  if (budgetError) throw new Error(`D.X.4 auction budget insert failed: ${budgetError.message}`)

  const { data: nomination, error: nominationError } = await supabase
    .from('nominations')
    .insert({
      draft_id: draft.id,
      nominating_member_id: members[1].id,
      player_id: player.id,
      nomination_order: 1,
      status: 'open',
      current_bid_amount: 1,
      current_bidder_id: null,
      countdown_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (nominationError) throw new Error(`D.X.4 auction nomination insert failed: ${nominationError.message}`)

  return {
    draftId: draft.id,
    leagueSeasonId: currentSeason.id,
    nominationId: nomination.id,
    members,
    player,
  }
}

const waitForDraftInProgress = async (supabase, draftId) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await supabase.from('drafts').select('status').eq('id', draftId).single()
    if (error) throw new Error(`D.X.4 draft status lookup failed: ${error.message}`)
    if (data.status === 'in_progress') return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('D.X.4 commissioner resume did not put the auction draft in progress')
}

const ensurePerfMatchup = async (supabase, state, leagueSeasonId, members) => {
  const { data, error } = await supabase
    .from('matchups')
    .select('id, home_points, away_points')
    .eq('league_id', state.leagueId)
    .eq('league_season_id', leagueSeasonId)
    .order('week_number', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`D.X.4 matchup lookup failed: ${error.message}`)
  if (data) return data
  if (members.length < 2) return null

  const { data: created, error: createError } = await supabase
    .from('matchups')
    .upsert({
      league_id: state.leagueId,
      league_season_id: leagueSeasonId,
      week_number: 1,
      matchup_type: 'regular_season',
      home_member_id: members[0].id,
      away_member_id: members[1].id,
      home_points: 0,
      away_points: 0,
    }, { onConflict: 'league_id,league_season_id,week_number,home_member_id,away_member_id' })
    .select('id, home_points, away_points')
    .single()
  if (createError) throw new Error(`D.X.4 matchup fixture upsert failed: ${createError.message}`)
  return created
}

const signIn = async (session, env, state, user, { captureInitialDelivery = false } = {}) => {
  await installRuntimeOverrides(browser, session, env, { reloadAfterSet: false })
  const initialJavaScriptDelivery = captureInitialDelivery
    ? await measureJavaScriptDelivery(browser, session)
    : null
  await browser(session, ['wait', '1500'])
  await fillSignInCredentials(browser, session, user.email, state.password)
  await clickButtonByName(browser, session, 'Sign In')
  await browser(session, ['wait', '4000'])
  return initialJavaScriptDelivery
}

const selectPerfLeague = async (session, leagueName) => {
  await clickButtonByName(browser, session, `Switch to ${leagueName}`)
  await browser(session, ['wait', '1000'])
}

const navigateForMeasurement = async (session, url) => {
  const startedAt = Date.now()
  await browser(session, ['eval', `(() => {
    setTimeout(() => location.assign(${JSON.stringify(url)}), 0);
    return JSON.stringify({ scheduled: true });
  })()`])
  await browser(session, ['wait', '100'])
  const firstPageState = parseEvalJson(await browser(session, ['eval', `(() => {
    const body = document.body?.innerText || '';
    return JSON.stringify({
      url: location.href,
      performanceNow: Math.round(performance.now()),
      auctionReady: body.includes('Auction Draft') && Boolean(document.querySelector('[aria-label="Increase bid"]') || document.querySelector('[aria-label="Search and nominate a player"]')),
      homeReady: body.includes('Lineup') && Boolean(document.querySelector('[aria-current="date"]')),
    });
  })()`]))
  return { wallMs: Date.now() - startedAt, firstPageState }
}

const installHeartbeat = async (session) => {
  await browser(session, [
    'eval',
    `(() => {
      window.__pancakePerf = {
        ticks: 0,
        maxLagMs: 0,
        startedAt: performance.now(),
        last: performance.now(),
        longTasks: [],
        longTaskSupported: false
      };
      if (window.__pancakePerfTimer) clearInterval(window.__pancakePerfTimer);
      window.__pancakePerfTimer = setInterval(() => {
        const now = performance.now();
        const lag = Math.max(0, now - window.__pancakePerf.last - 100);
        window.__pancakePerf.maxLagMs = Math.max(window.__pancakePerf.maxLagMs, lag);
        window.__pancakePerf.last = now;
        window.__pancakePerf.ticks += 1;
      }, 100);
      if ('PerformanceObserver' in window && !window.__pancakePerfObserver) {
        try {
          window.__pancakePerfObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              window.__pancakePerf.longTasks.push({ name: entry.name, duration: entry.duration });
            }
          });
          window.__pancakePerfObserver.observe({ entryTypes: ['longtask'] });
          window.__pancakePerf.longTaskSupported = true;
        } catch {}
      }
      return JSON.stringify({ ok: true });
    })()`,
  ])
}

const collectHeartbeat = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const perf = window.__pancakePerf || {};
      return JSON.stringify({
        ticks: perf.ticks || 0,
        maxLagMs: Math.round(perf.maxLagMs || 0),
        elapsedMs: Math.round(performance.now() - (perf.startedAt || performance.now())),
        longTaskCount: (perf.longTasks || []).length,
        maxLongTaskMs: Math.round(Math.max(0, ...(perf.longTasks || []).map((entry) => entry.duration || 0))),
        longTaskSupported: perf.longTaskSupported === true,
        bodyTextSample: (document.body?.innerText || '').slice(0, 500)
      });
    })()`,
  ])
  return parseEvalJson(output)
}

const runLoadMutations = async ({ supabase, auction, matchup }) => {
  const startedAt = Date.now()
  if (!auction?.nominationId && !matchup?.id) {
    throw new Error('D.X.4 perf smoke has no mutation target')
  }
  let startAmount = 0
  if (auction?.nominationId) {
    const { data: nomination, error: nominationError } = await supabase
      .from('nominations')
      .select('current_bid_amount')
      .eq('id', auction.nominationId)
      .single()
    if (nominationError) throw new Error(`D.X.4 auction nomination lookup failed: ${nominationError.message}`)
    startAmount = Number(nomination.current_bid_amount ?? 0) + 1
  }
  const mutations = []
  for (let index = 0; index < MUTATION_COUNT; index += 1) {
    let amount = null
    let bidderId = null
    if (auction?.nominationId) {
      const bidder = auction.members[(index + 1) % auction.members.length]
      amount = startAmount + index
      bidderId = bidder.id
      const { error: bidError } = await supabase.rpc('place_auction_bid_atomic', {
        p_draft_id: auction.draftId,
        p_member_id: bidder.id,
        p_nomination_id: auction.nominationId,
        p_amount: amount,
        p_user_id: bidder.user_id,
      })
      if (bidError) throw new Error(`D.X.4 auction bid mutation ${index + 1} failed: ${bidError.message}`)
    }

    if (matchup?.id) {
      const { error: matchupError } = await supabase
        .from('matchups')
        .update({
          home_points: Number(matchup.home_points ?? 0) + index + 1,
          away_points: Number(matchup.away_points ?? 0) + index + 2,
        })
        .eq('id', matchup.id)
      if (matchupError) throw new Error(`D.X.4 matchup mutation ${index + 1} failed: ${matchupError.message}`)
    }
    mutations.push({ bidAmount: amount, bidderId, matchupUpdated: Boolean(matchup?.id) })
  }
  return {
    count: mutations.length,
    durationMs: Date.now() - startedAt,
    mutations,
  }
}

export async function runBrowserPerfSmoke({
  season = 0,
  sessionName = undefined,
  resourceOwner = undefined,
} = {}) {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey', 'anonKey', 'apiBaseUrl'])
  const state = await readState()
  const user = state.users?.[0]
  const peerUser = state.users?.[1]
  if (!user) throw new Error('D.X.4: no seeded user found for browser perf smoke')
  if (!peerUser) throw new Error('D.X.4: no second seeded user found for browser perf presence')
  if (!state.password) throw new Error('D.X.4: tests/e2e-state.json is missing the seeded user password')
  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const fixture = await createDisposableLeagueFromSeedUsers({
    supabase,
    state,
    season,
    label: 'browser performance',
    userCount: 2,
    resourceOwner,
    seasonYear: 5000 + (process.pid % 4000),
  })
  await ensurePerfSeasonWeek(supabase, fixture.leagueSeason.season_year, resourceOwner)
  const perfState = { ...state, leagueId: fixture.league.id }
  const auction = await ensurePerfAuction(supabase, perfState)
  const matchup = await ensurePerfMatchup(supabase, perfState, auction.leagueSeasonId, auction.members)
  const managerResume = await postDraftLifecycle(env, peerUser, state.password, auction.draftId, 'resume')
  if (managerResume.status !== 404) {
    throw new Error(`D.X.4 noncommissioner resume returned ${managerResume.status}; expected hidden draft 404`)
  }
  const commissionerResume = await postDraftLifecycle(env, user, state.password, auction.draftId, 'resume')
  if (commissionerResume.status !== 200 || commissionerResume.body?.ok !== true) {
    throw new Error(`D.X.4 commissioner resume returned ${commissionerResume.status}`)
  }
  await waitForDraftInProgress(supabase, auction.draftId)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-perf-${state.runId ?? 'run'}-s${season}-${process.pid}`)
  const peerSession = `${session}-peer`
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-perf')
  await mkdir(artifactDir, { recursive: true })
  const provenance = await resolveReleaseProvenance()

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `User: ${user.email}`,
    `Presence peer: ${peerUser.email}`,
    `Mutation count: ${MUTATION_COUNT}`,
    sessionList,
  ]

  try {
    const initialJavaScriptDelivery = await signIn(session, env, state, user, { captureInitialDelivery: true })
    await selectPerfLeague(session, fixture.league.name)
    await browser(session, ['set', 'viewport', '390', '844'])

    const coldHomeUrl = new URL(joinUrl(env.frontendUrl, '/'))
    coldHomeUrl.searchParams.set('e2e_perf_cold', `${Date.now()}`)
    const coldHomeNavigationDiagnostic = await navigateForMeasurement(session, coldHomeUrl.toString())
    const homeColdTiming = await measureNavigationTiming(browser, session, {
      workflowId: 'home-live-lineup',
      label: 'home-cold',
      sharedScriptUrls: initialJavaScriptDelivery?.scriptUrls ?? [],
    })

    const activeOpenStartedAt = Date.now()
    await browser(session, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    const activeOpenWallMs = Date.now() - activeOpenStartedAt
    const activeOpenPageState = parseEvalJson(await browser(session, ['eval', `(() => {
      const body = document.body?.innerText || '';
      const activeReady = body.includes('Auction Draft') && Boolean(document.querySelector('[aria-label="Increase bid"]') || document.querySelector('[aria-label="Search and nominate a player"]') || document.querySelector('[aria-label="Pause draft"]'));
      return JSON.stringify({
        performanceNow: Math.round(performance.now()),
        pageReady: activeReady || (body.includes('Auction Draft') && Boolean(document.querySelector('[aria-label="Resume draft"]'))),
        activeReady,
      });
    })()`]))
    const sharedScriptUrls = initialJavaScriptDelivery?.scriptUrls ?? []
    const draftRouteTiming = await measureNavigationTiming(browser, session, {
      workflowId: 'auction-draft-room', label: 'draft-room-initial', sharedScriptUrls,
    })
    await signIn(peerSession, env, state, peerUser)
    await selectPerfLeague(peerSession, fixture.league.name)
    await browser(peerSession, ['set', 'viewport', '390', '844'])
    await browser(peerSession, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    await browser(peerSession, ['wait', '3000'])
    await waitForDraftInProgress(supabase, auction.draftId)
    await browser(session, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    await browser(session, ['wait', String(BROWSER_SETTLE_MS)])
    await waitForDraftInProgress(supabase, auction.draftId)
    const measuredDraftUrl = new URL(joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`))
    measuredDraftUrl.searchParams.set('e2e_perf_nav', `${Date.now()}`)
    const draftNavigationDiagnostic = await navigateForMeasurement(session, measuredDraftUrl.toString())
    await waitForDraftInProgress(supabase, auction.draftId)
    const draftLoadTiming = await measureNavigationTiming(browser, session, {
      workflowId: 'auction-draft-room', label: 'draft-room', sharedScriptUrls,
    })
    const draftFeedback = await measureWorkflowFeedback(browser, session, { workflowId: 'auction-draft-room', label: 'draft-room' })
      .catch((error) => ({ error: error.message }))
    await installHeartbeat(session)
    await browser(session, ['screenshot', path.join(artifactDir, 'draft-before-load.png')], { timeout: 60_000 })

    const draftLoad = await runLoadMutations({ supabase, auction, matchup })
    await browser(session, ['wait', '2500'])
    const draftPerf = await collectHeartbeat(session)
    await browser(session, ['screenshot', path.join(artifactDir, 'draft-after-load.png')], { timeout: 60_000 })

    const measuredHomeUrl = new URL(joinUrl(env.frontendUrl, '/'))
    measuredHomeUrl.searchParams.set('e2e_perf_nav', `${Date.now()}`)
    const homeNavigationDiagnostic = await navigateForMeasurement(session, measuredHomeUrl.toString())
    const homeLoadTiming = await measureNavigationTiming(browser, session, {
      workflowId: 'home-live-lineup', label: 'home', sharedScriptUrls,
    })
    const homeFeedback = await measureWorkflowFeedback(browser, session, { workflowId: 'home-live-lineup', label: 'home' })
    await installHeartbeat(session)
    const homeLoad = await runLoadMutations({ supabase, auction: null, matchup })
    await browser(session, ['wait', '2500'])
    const homePerf = await collectHeartbeat(session)
    await browser(session, ['screenshot', path.join(artifactDir, 'home-after-live-load.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = []
    failures.push(...browserDiagnosticFailures({ consoleOutput, errorOutput }))
    if (draftPerf.maxLagMs > MAX_HEARTBEAT_LAG_MS) failures.push(`draft heartbeat lag ${draftPerf.maxLagMs}ms exceeded ${MAX_HEARTBEAT_LAG_MS}ms`)
    if (homePerf.maxLagMs > MAX_HEARTBEAT_LAG_MS) failures.push(`home heartbeat lag ${homePerf.maxLagMs}ms exceeded ${MAX_HEARTBEAT_LAG_MS}ms`)
    if (draftLoad.durationMs > MAX_SCRIPT_MS) failures.push(`draft mutation loop took ${draftLoad.durationMs}ms exceeded ${MAX_SCRIPT_MS}ms`)
    if (homeLoad.durationMs > MAX_SCRIPT_MS) failures.push(`home mutation loop took ${homeLoad.durationMs}ms exceeded ${MAX_SCRIPT_MS}ms`)
    if (draftFeedback?.feedbackMs == null || !draftFeedback.observed) failures.push(`observed draft bid feedback measurement missing${draftFeedback?.error ? `: ${draftFeedback.error}` : ''}`)
    if (!Number.isFinite(draftLoadTiming?.cachedRequestMs) || !Number.isFinite(draftLoadTiming?.fullLoadMs)) failures.push('draft navigation timing measurement missing')
    if (!homeFeedback?.observed || !Number.isFinite(homeFeedback?.feedbackMs) || !Number.isFinite(homeLoadTiming?.cachedRequestMs) || !Number.isFinite(homeLoadTiming?.fullLoadMs)) failures.push('observed home workflow timing measurement missing')
    if (draftFeedback?.feedbackMs > MAX_FEEDBACK_MS) failures.push(`draft bid feedback ${draftFeedback.feedbackMs}ms exceeded ${MAX_FEEDBACK_MS}ms`)
    if (homeFeedback?.feedbackMs > MAX_FEEDBACK_MS) failures.push(`home feedback ${homeFeedback.feedbackMs}ms exceeded ${MAX_FEEDBACK_MS}ms`)
    if (draftPerf.maxLongTaskMs > MAX_LONG_TASK_MS) failures.push(`draft long task ${draftPerf.maxLongTaskMs}ms exceeded ${MAX_LONG_TASK_MS}ms`)
    if (homePerf.maxLongTaskMs > MAX_LONG_TASK_MS) failures.push(`home long task ${homePerf.maxLongTaskMs}ms exceeded ${MAX_LONG_TASK_MS}ms`)
    if (draftPerf.ticks < 10 || homePerf.ticks < 10) failures.push('browser heartbeat did not collect enough samples')
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      auction: {
        leagueId: fixture.league.id,
        draftId: auction.draftId,
        nominationId: auction.nominationId,
        playerId: auction.player.id,
      },
      matchupId: matchup?.id ?? null,
      load: { draft: draftLoad, home: homeLoad, durationMs: Math.max(draftLoad.durationMs, homeLoad.durationMs) },
      draftFeedback,
      draftPerf,
      homePerf,
      initialJavaScriptDelivery,
      provenance,
      navigationDiagnostics: {
        activeAuctionOpen: { wallMs: activeOpenWallMs, pageState: activeOpenPageState },
        coldHome: coldHomeNavigationDiagnostic,
        measuredAuction: draftNavigationDiagnostic,
        measuredHome: homeNavigationDiagnostic,
      },
      workflowMeasurements: [
        {
          id: 'auction-draft-room',
          route: `/draft-room?draftId=${auction.draftId}`,
          ...(draftFeedback?.feedbackMs != null ? { feedbackMs: draftFeedback.feedbackMs } : {}),
          ...combineNavigationPhases(draftRouteTiming, draftLoadTiming),
          feedbackObserved: draftFeedback?.observed === true,
          feedbackInteraction: draftFeedback?.interaction,
          routeWebJsKb: draftRouteTiming?.webJsTransferKb,
          routeJsEncodedKb: draftRouteTiming?.routeJsEncodedKb,
          routeJsCacheHit: draftRouteTiming?.routeJsCacheHit,
          routeJsDecodedKb: draftRouteTiming?.routeJsDecodedKb,
          routeJsLedger: draftRouteTiming?.routeJsLedger,
          routeJsEntryCount: draftRouteTiming?.routeJsEntryCount,
          routeJsNetworkEntryCount: draftRouteTiming?.routeJsNetworkEntryCount,
        },
        {
          id: 'home-live-lineup',
          route: '/',
          feedbackMs: homeFeedback?.feedbackMs,
          ...combineNavigationPhases(homeColdTiming, homeLoadTiming),
          feedbackObserved: homeFeedback?.observed === true,
          feedbackInteraction: homeFeedback?.interaction,
          initialWebJsKb: initialJavaScriptDelivery?.webJsEncodedKb,
        },
      ],
      thresholds: {
        maxHeartbeatLagMs: MAX_HEARTBEAT_LAG_MS,
        maxScriptMs: MAX_SCRIPT_MS,
        maxFeedbackMs: MAX_FEEDBACK_MS,
        maxLongTaskMs: MAX_LONG_TASK_MS,
      },
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`D.X.4 browser perf smoke failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      error: error instanceof Error ? error.message : String(error),
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  import('./browser-scenario-registry.mjs').then(({ browserScenarioById }) => (
    browserScenarioById('performance').run({ args: { browserFullSweep: false }, season })
  )).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
