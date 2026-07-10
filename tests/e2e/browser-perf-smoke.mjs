import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { ownScenarioResource, releaseScenarioResource } from './scenario-resource-owner.mjs'

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-perf-report.md')

const BROWSER_SETTLE_MS = Number(process.env.E2E_BROWSER_PERF_SETTLE_MS ?? 2000)
const MUTATION_COUNT = Number(process.env.E2E_BROWSER_PERF_MUTATIONS ?? 24)
const MAX_HEARTBEAT_LAG_MS = Number(process.env.E2E_BROWSER_PERF_MAX_LAG_MS ?? 600)
const MAX_SCRIPT_MS = Number(process.env.E2E_BROWSER_PERF_MAX_SCRIPT_MS ?? 30000)
const MAX_FEEDBACK_MS = Number(process.env.E2E_BROWSER_PERF_MAX_FEEDBACK_MS ?? 100)
const BROWSER_COMMAND_TIMEOUT_MS = Number(process.env.E2E_BROWSER_PERF_COMMAND_TIMEOUT_MS ?? 90_000)

const readState = async () => JSON.parse(await readFile(STATE_PATH, 'utf8'))

const browser = createBrowser({ cwd: ROOT, defaultTimeout: BROWSER_COMMAND_TIMEOUT_MS })

const listSessions = () => listBrowserSessions({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseOptionalEvalJson = (output) => {
  try {
    return parseEvalJson(output)
  } catch {
    return null
  }
}

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const browserNavigationTiming = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return JSON.stringify(null);
      const requests = performance.getEntriesByType('resource')
        .filter((entry) => entry.initiatorType === 'fetch' || entry.initiatorType === 'xmlhttprequest')
        .map((entry) => entry.duration)
        .filter((duration) => Number.isFinite(duration) && duration >= 0);
      const fullLoadMs = Math.round(nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.responseEnd || 0);
      return JSON.stringify({
        fullLoadMs,
        cachedRequestMs: requests.length > 0 ? Math.round(Math.max(...requests)) : null,
        domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
        responseEndMs: Math.round(nav.responseEnd || 0),
        transferSize: Math.round(nav.transferSize || 0),
        encodedBodySize: Math.round(nav.encodedBodySize || 0)
      });
    })()`,
  ])
  return parseOptionalEvalJson(output)
}

const browserFrameFeedbackTiming = async (session) => {
  const output = await browser(session, [
    'eval',
    `(async () => {
      const started = performance.now();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return JSON.stringify({ feedbackMs: Math.round((performance.now() - started) * 10) / 10 });
    })()`,
  ])
  return parseEvalJson(output)
}

const bidPressFeedbackTiming = async (session) => {
  const output = await browser(session, [
    'eval',
    `(async () => {
      const candidates = Array.from(document.querySelectorAll('*'))
        .map((node) => ({ node, text: (node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim() }))
        .filter((entry) => /^Bid \\$\\d+/.test(entry.text))
        .sort((a, b) => a.text.length - b.text.length);
      const labelNode = candidates[0]?.node ?? null;
      const button = labelNode?.closest?.('[role="button"], button, [tabindex]') ?? labelNode?.parentElement ?? null;
      if (!button) return JSON.stringify(null);
      const started = performance.now();
      const eventInit = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' };
      const down = typeof PointerEvent === 'function'
        ? new PointerEvent('pointerdown', eventInit)
        : new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(down);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const feedbackMs = Math.round((performance.now() - started) * 10) / 10;
      const up = typeof PointerEvent === 'function'
        ? new PointerEvent('pointerup', eventInit)
        : new MouseEvent('mouseup', { bubbles: true, cancelable: true });
      button.dispatchEvent(up);
      return JSON.stringify({ feedbackMs, target: (button.innerText || button.textContent || '').trim() });
    })()`,
  ])
  return parseOptionalEvalJson(output)
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

  const sportsdataId = `e2e-perf-free-agent-${leagueSeasonId}`
  const { data: fallbackPlayer, error: fallbackError } = await supabase
    .from('players')
    .upsert({
      sportsdata_id: sportsdataId,
      nba_id: sportsdataId,
      sleeper_id: sportsdataId,
      first_name: 'E2E',
      last_name: `PerfFreeAgent${leagueSeasonId.slice(0, 8)}`,
      nba_team: 'FA',
      position: 'PG',
      eligible_positions: ['PG'],
      status: 'Active',
      injury_status: null,
      years_exp: 1,
      nba_draft_number: null,
    }, { onConflict: 'sportsdata_id' })
    .select('id, display_name')
    .single()
  if (fallbackError) throw new Error(`D.X.4 perf free-agent fixture upsert failed: ${fallbackError.message}`)
  return fallbackPlayer
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

  const { error: cleanupError } = await supabase
    .from('drafts')
    .update({ status: 'completed', completed_at: now })
    .eq('league_id', state.leagueId)
    .eq('league_season_id', currentSeason.id)
    .eq('draft_type', 'auction')
    .in('status', ['pending', 'in_progress', 'paused'])
  if (cleanupError) throw new Error(`D.X.4 stale auction draft cleanup failed: ${cleanupError.message}`)

  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .insert({
      league_id: state.leagueId,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'in_progress',
      budget_per_team: 1000,
      started_at: now,
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
      nominating_member_id: members[0].id,
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
  throw new Error('D.X.4 two-manager presence did not resume the auction draft')
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
      week_number: 99,
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

const signIn = async (session, env, state, user) => {
  await installRuntimeOverrides(browser, session, env)
  await browser(session, ['wait', '1500'])
  await fillSignInCredentials(browser, session, user.email, state.password)
  await clickButtonByName(browser, session, 'Sign In')
  await browser(session, ['wait', '4000'])
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
        longTasks: []
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

const closePerfNomination = async (supabase, auction) => {
  const past = new Date(Date.now() - 1000).toISOString()
  const { error: expireError } = await supabase
    .from('nominations')
    .update({ countdown_expires_at: past })
    .eq('id', auction.nominationId)
    .eq('status', 'open')
  if (expireError) throw new Error(`D.X.4 auction nomination cleanup expire failed: ${expireError.message}`)

  const { error: closeError } = await supabase.rpc('close_auction_nomination_atomic', {
    p_nomination_id: auction.nominationId,
  })
  if (closeError) throw new Error(`D.X.4 auction nomination cleanup close failed: ${closeError.message}`)
}

export async function runBrowserPerfSmoke({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'serviceRoleKey'])
  const state = await readState()
  const user = state.users?.[0]
  const peerUser = state.users?.[1]
  if (!user) throw new Error('D.X.4: no seeded user found for browser perf smoke')
  if (!peerUser) throw new Error('D.X.4: no second seeded user found for browser perf presence')
  if (!state.password) throw new Error('D.X.4: tests/e2e-state.json is missing the seeded user password')
  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const auction = await ensurePerfAuction(supabase, state)
  const nominationResourceKey = `perf-nomination:${auction.nominationId}`
  let nominationNeedsCleanup = true
  const disposeNomination = async () => {
    if (!nominationNeedsCleanup) return
    await closePerfNomination(supabase, auction)
    nominationNeedsCleanup = false
  }
  ownScenarioResource(nominationResourceKey, `performance nomination ${auction.nominationId}`, disposeNomination)
  const matchup = await ensurePerfMatchup(supabase, state, auction.leagueSeasonId, auction.members)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-perf-${state.runId ?? 'run'}-s${season}-${process.pid}`)
  const peerSession = `${session}-peer`
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-perf')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `User: ${user.email}`,
    `Presence peer: ${peerUser.email}`,
    `Mutation count: ${MUTATION_COUNT}`,
    sessionList,
  ]

  try {
    await signIn(session, env, state, user)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})

    await browser(session, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    await browser(session, ['wait', String(BROWSER_SETTLE_MS)])
    await signIn(peerSession, env, state, peerUser)
    await browser(peerSession, ['set', 'viewport', '390', '844'])
    await browser(peerSession, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    await browser(peerSession, ['wait', '3000'])
    await waitForDraftInProgress(supabase, auction.draftId)
    await browser(session, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    await browser(session, ['wait', String(BROWSER_SETTLE_MS)])
    await waitForDraftInProgress(supabase, auction.draftId)
    await browser(session, ['open', joinUrl(env.frontendUrl, `/draft-room?draftId=${auction.draftId}`)])
    await browser(session, ['wait', String(BROWSER_SETTLE_MS)])
    await waitForDraftInProgress(supabase, auction.draftId)
    const draftLoadTiming = await browserNavigationTiming(session).catch(() => null)
    const draftFeedback = await bidPressFeedbackTiming(session).catch((error) => ({ error: error.message }))
    await installHeartbeat(session)
    await browser(session, ['screenshot', path.join(artifactDir, 'draft-before-load.png')], { timeout: 60_000 })

    const load = await runLoadMutations({ supabase, auction, matchup })
    await browser(session, ['wait', '2500'])
    const draftPerf = await collectHeartbeat(session)
    await browser(session, ['screenshot', path.join(artifactDir, 'draft-after-load.png')], { timeout: 60_000 })

    await browser(session, ['open', joinUrl(env.frontendUrl, '/')])
    await browser(session, ['wait', String(BROWSER_SETTLE_MS)])
    await browser(session, ['open', joinUrl(env.frontendUrl, '/')])
    await browser(session, ['wait', String(BROWSER_SETTLE_MS)])
    const homeLoadTiming = await browserNavigationTiming(session).catch(() => null)
    const homeFeedback = await browserFrameFeedbackTiming(session).catch(() => null)
    await installHeartbeat(session)
    await runLoadMutations({ supabase, auction: null, matchup })
    await browser(session, ['wait', '2500'])
    const homePerf = await collectHeartbeat(session)
    await browser(session, ['screenshot', path.join(artifactDir, 'home-after-live-load.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = []
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    if (draftPerf.maxLagMs > MAX_HEARTBEAT_LAG_MS) failures.push(`draft heartbeat lag ${draftPerf.maxLagMs}ms exceeded ${MAX_HEARTBEAT_LAG_MS}ms`)
    if (homePerf.maxLagMs > MAX_HEARTBEAT_LAG_MS) failures.push(`home heartbeat lag ${homePerf.maxLagMs}ms exceeded ${MAX_HEARTBEAT_LAG_MS}ms`)
    if (load.durationMs > MAX_SCRIPT_MS) failures.push(`mutation loop took ${load.durationMs}ms exceeded ${MAX_SCRIPT_MS}ms`)
    if (draftFeedback?.feedbackMs == null) failures.push(`draft bid feedback measurement missing${draftFeedback?.error ? `: ${draftFeedback.error}` : ''}`)
    if (!Number.isFinite(draftLoadTiming?.cachedRequestMs) || !Number.isFinite(draftLoadTiming?.fullLoadMs)) failures.push('draft navigation timing measurement missing')
    if (!Number.isFinite(homeFeedback?.feedbackMs) || !Number.isFinite(homeLoadTiming?.cachedRequestMs) || !Number.isFinite(homeLoadTiming?.fullLoadMs)) failures.push('home workflow timing measurement missing')
    if (draftFeedback?.feedbackMs > MAX_FEEDBACK_MS) failures.push(`draft bid feedback ${draftFeedback.feedbackMs}ms exceeded ${MAX_FEEDBACK_MS}ms`)
    if (draftPerf.ticks < 10 || homePerf.ticks < 10) failures.push('browser heartbeat did not collect enough samples')
    await disposeNomination()
    releaseScenarioResource(nominationResourceKey)

    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      auction: {
        draftId: auction.draftId,
        nominationId: auction.nominationId,
        playerId: auction.player.id,
      },
      matchupId: matchup?.id ?? null,
      load,
      draftFeedback,
      draftPerf,
      homePerf,
      workflowMeasurements: [
        {
          id: 'auction-draft-room',
          route: `/draft-room?draftId=${auction.draftId}`,
          ...(draftFeedback?.feedbackMs != null ? { feedbackMs: draftFeedback.feedbackMs } : {}),
          ...draftLoadTiming,
        },
        {
          id: 'home-live-lineup',
          route: '/',
          feedbackMs: homeFeedback?.feedbackMs,
          ...homeLoadTiming,
        },
      ],
      thresholds: {
        maxHeartbeatLagMs: MAX_HEARTBEAT_LAG_MS,
        maxScriptMs: MAX_SCRIPT_MS,
        maxFeedbackMs: MAX_FEEDBACK_MS,
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
