import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { browserDiagnosticFailures, installRuntimeOverrides } from './browser-runtime-overrides.mjs'
import { captureBrowserScreenshot, createBrowser, listBrowserSessions } from './browser-agent.mjs'
import { combineNavigationPhases, measureJavaScriptDelivery, measureNavigationTiming, measureWorkflowFeedback, recordWorkflowMeasurement } from './browser-performance-evidence.mjs'
import { ensureSyntheticSeasonWeeks } from './soak-fixtures.mjs'
import { resolveReleaseProvenance } from './release-provenance.mjs'

const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-report.md')
const RELEASE_WORKER_PATH = path.join(ROOT, 'dist/sw.js')

const readState = async () => JSON.parse(await readFile(STATE_PATH, 'utf8'))

const listSessions = () => listBrowserSessions({ cwd: ROOT })

const browser = createBrowser({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')

const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const routeWorkflowIds = new Map([
  ['players', 'player-search-filter'],
  ['roster', 'roster-review-manage'],
  ['trades', 'trade-review-act'],
  ['dynasty', 'dynasty-hub'],
  ['lineup', 'lineup-day-change'],
  ['claim-player', 'waiver-add-claim'],
  ['player-detail', 'player-detail-open'],
  ['propose-trade', 'trade-review-act'],
  ['rookie-draft-room', 'rookie-draft-room'],
])

export const REQUIRED_FULL_SWEEP_LABELS = [
  'auth-sign-in', 'auth-sign-up',
  'home', 'players', 'roster', 'trades', 'league', 'dynasty', 'profile',
  'create-league', 'join-league', 'commissioner-settings', 'lineup', 'bracket',
  'claim-player', 'player-detail', 'propose-trade', 'team-roster',
  'draft-room', 'rookie-draft-room', 'draft-launcher', 'change-password', 'not-found',
]

export const assertFullSweepRoutes = (visited) => {
  const visitedSet = new Set(visited)
  const missing = REQUIRED_FULL_SWEEP_LABELS.filter((label) => !visitedSet.has(label))
  if (missing.length > 0) throw new Error(`Full sweep omitted required routes: ${missing.join(', ')}`)
}

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  if (!line) throw new Error('Browser surface evaluation returned no output')
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const browserJson = async (session, source) =>
  parseEvalJson(await browser(session, ['eval', source]))

const observeRoute = async (session, { label, route, phase }) => browserJson(session, `(async () => {
  const ready = navigator.serviceWorker
    ? await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
      ])
    : false;
  const cacheNames = 'caches' in window ? await caches.keys() : [];
  const cacheEntries = (await Promise.all(cacheNames.map(async (name) => {
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => request.url);
  }))).flat();
  const body = (document.body?.innerText || '').trim();
  const nav = performance.getEntriesByType('navigation')[0];
  const apiCacheEntries = cacheEntries.filter((entry) => {
    const url = new URL(entry);
    return url.origin !== location.origin || /\\/(?:auth|functions|realtime|rest|storage)\\/v1(?:\\/|$)/.test(url.pathname);
  });
  return JSON.stringify({
    label: ${JSON.stringify(label)},
    requestedRoute: ${JSON.stringify(route)},
    phase: ${JSON.stringify(phase)},
    observedAt: new Date().toISOString(),
    finalUrl: location.href,
    finalPath: location.pathname + location.search,
    readyState: document.readyState,
    onLine: navigator.onLine,
    serviceWorkerReady: ready,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    bodyTextLength: body.length,
    bodySample: body.slice(0, 240),
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    cacheNames,
    cacheEntries,
    apiCacheEntries,
    localAppCacheKeys: Object.keys(localStorage).filter((key) => /pancake|cache|matchup|roster|league|player|trade|draft/i.test(key)).sort(),
    navigation: nav ? {
      type: nav.type,
      responseEndMs: Math.round(nav.responseEnd || 0),
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
      loadMs: Math.round(nav.loadEventEnd || 0),
      transferSize: Math.round(nav.transferSize || 0),
    } : null,
  });
})()`)

export const routeEvidenceFailures = ({ online, offline, reconnect }, requiredLabels = REQUIRED_FULL_SWEEP_LABELS) => {
  const failures = []
  for (const [phase, observations] of Object.entries({ online, offline, reconnect })) {
    const labels = observations.map(({ label }) => label)
    for (const label of requiredLabels) {
      if (!labels.includes(label)) failures.push(`${phase} is missing ${label}`)
    }
    for (const label of new Set(labels)) {
      if (labels.filter((candidate) => candidate === label).length > 1) failures.push(`${phase} repeats ${label}`)
    }
    for (const observation of observations) {
      if (observation.phase !== phase) failures.push(`${phase}.${observation.label} has phase ${observation.phase}`)
      if (observation.serviceWorkerReady !== true || observation.serviceWorkerControlled !== true) {
        failures.push(`${phase}.${observation.label} is not controlled by a ready service worker`)
      }
      if (observation.bodyTextLength < 20) failures.push(`${phase}.${observation.label} has no useful visible content`)
      if (observation.horizontalOverflowPx > 1) failures.push(`${phase}.${observation.label} overflows by ${observation.horizontalOverflowPx}px`)
      if (observation.apiCacheEntries.length > 0) failures.push(`${phase}.${observation.label} cached API or realtime URLs`)
      if (phase === 'offline' ? observation.onLine !== false : observation.onLine !== true) {
        failures.push(`${phase}.${observation.label} has the wrong network state`)
      }
      if (!Array.isArray(observation.cacheNames) || !observation.cacheNames.some((name) => name.endsWith('-shell'))) {
        failures.push(`${phase}.${observation.label} has no versioned shell cache`)
      }
      if (phase !== 'offline' && (!observation.navigation || !Number.isFinite(observation.navigation.responseEndMs))) {
        failures.push(`${phase}.${observation.label} has no navigation timing`)
      }
    }
  }
  return failures
}

export const workerUpdateFailures = (proof) => [
  proof?.oldCachesDeleted === true ? null : 'old worker caches remain',
  proof?.newShellCache === `${proof?.testVersion}-shell` ? null : 'new shell cache is missing',
  proof?.workerWaitingAfterUpdate === false ? null : 'updated worker remains waiting',
  proof?.controllerChanged === true ? null : 'controller did not change',
  proof?.pageNavigationType === 'reload' ? null : 'controller change did not reload the page',
  proof?.restoredOriginalWorker === true ? null : 'original release worker was not restored',
].filter(Boolean)

const verifyWorkerUpdate = async (session) => {
  const originalSource = await readFile(RELEASE_WORKER_PATH, 'utf8')
  const versionMatch = originalSource.match(/const VERSION = '([^']+)'/)
  if (!versionMatch || versionMatch[1] === 'pancake-dev') {
    throw new Error('PWA update proof requires a release-stamped service worker')
  }
  const originalVersion = versionMatch[1]
  const testVersion = `pancake-e2e-update-${Date.now()}`
  const originalCaches = await browserJson(session, 'caches.keys().then((value) => JSON.stringify(value))')
  let restoredOriginalWorker = false
  let proof
  try {
    await writeFile(
      RELEASE_WORKER_PATH,
      originalSource.replace(versionMatch[0], `const VERSION = '${testVersion}'`),
    )
    await browserJson(session, `(async () => {
      sessionStorage.setItem('pancake-e2e-controller-change', 'pending');
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        sessionStorage.setItem('pancake-e2e-controller-change', 'observed');
      }, { once: true });
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      return JSON.stringify({ updateRequested: true });
    })()`).catch(() => ({ updateRequested: true }))

    let observed = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await browser(session, ['wait', '500'])
      observed = await browserJson(session, `(async () => {
        const registration = await navigator.serviceWorker.ready;
        const cacheNames = await caches.keys();
        return JSON.stringify({
          cacheNames,
          controlled: Boolean(navigator.serviceWorker.controller),
          controllerChanged: sessionStorage.getItem('pancake-e2e-controller-change') === 'observed',
          navigationType: performance.getEntriesByType('navigation')[0]?.type ?? null,
          waiting: Boolean(registration.waiting),
        });
      })()`).catch(() => null)
      if (observed?.cacheNames.includes(`${testVersion}-shell`) && observed.controllerChanged) break
    }
    if (!observed) throw new Error('PWA update proof returned no browser observation')
    proof = {
      originalVersion,
      testVersion,
      originalCaches,
      cacheNamesAfterUpdate: observed.cacheNames,
      oldCachesDeleted: originalCaches.every((name) => !observed.cacheNames.includes(name)),
      newShellCache: observed.cacheNames.find((name) => name === `${testVersion}-shell`) ?? null,
      workerWaitingAfterUpdate: observed.waiting,
      controllerChanged: observed.controllerChanged,
      pageNavigationType: observed.navigationType,
      restoredOriginalWorker: false,
    }
  } finally {
    await writeFile(RELEASE_WORKER_PATH, originalSource)
    await browserJson(session, `(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
      return JSON.stringify({ updateRequested: true });
    })()`).catch(() => ({ updateRequested: true }))
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await browser(session, ['wait', '500'])
      const restoredCaches = await browserJson(session, 'caches.keys().then((value) => JSON.stringify(value))').catch(() => [])
      if (restoredCaches.includes(`${originalVersion}-shell`) && !restoredCaches.some((name) => name.startsWith(testVersion))) {
        restoredOriginalWorker = true
        break
      }
    }
  }
  proof.restoredOriginalWorker = restoredOriginalWorker
  const failures = workerUpdateFailures(proof)
  if (failures.length > 0) throw new Error(`PWA update proof failed: ${failures.join('; ')}`)
  return proof
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const refForAccessibleNode = (snapshot, role, name) => {
  const pattern = new RegExp(`${escapeRegExp(role)} "${escapeRegExp(name)}" \\[ref=([^\\]]+)\\]`)
  const match = snapshot.match(pattern)
  if (!match) throw new Error(`Could not find ${role} "${name}" in browser snapshot.`)
  return match[1]
}

const fillTextbox = async (session, name, value) => {
  const snapshot = await browser(session, ['snapshot'])
  await browser(session, ['fill', refForAccessibleNode(snapshot, 'textbox', name), value])
}

const clickButton = async (session, name) => {
  const snapshot = await browser(session, ['snapshot'])
  await browser(session, ['click', refForAccessibleNode(snapshot, 'button', name)])
}

const encodeQuery = (pathname, params) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') search.set(key, value)
  }
  const query = search.toString()
  return query ? `${pathname}?${query}` : pathname
}

const pickRowsForSnakeDraft = (members, rounds = 3) => {
  const rows = []
  let overallPick = 1
  for (let round = 1; round <= rounds; round += 1) {
    const order = round % 2 === 0 ? [...members].reverse() : members
    order.forEach((member, index) => {
      rows.push({
        overall_pick: overallPick,
        round,
        pick_in_round: index + 1,
        member_id: member.id,
      })
      overallPick += 1
    })
  }
  return rows
}

const ensureSnakeDraftPickAssets = async (supabase, { leagueId, seasonYear, draftId, members }) => {
  const { data: slots, error: slotsError } = await supabase
    .from('snake_draft_picks')
    .select('id, round, member_id, draft_pick_id')
    .eq('draft_id', draftId)
    .order('overall_pick', { ascending: true })
  if (slotsError) throw new Error(`UI sweep snake pick asset lookup: ${slotsError.message}`)

  const missingSlots = (slots ?? []).filter((slot) => !slot.draft_pick_id)
  if (missingSlots.length === 0) return

  const pickRows = missingSlots.map((slot) => {
    const member = members.find((candidate) => candidate.id === slot.member_id)
    return {
      league_id: leagueId,
      season_year: seasonYear,
      round: slot.round,
      original_owner_id: member?.id ?? slot.member_id,
      current_owner_id: slot.member_id,
    }
  })
  const { data: picks, error: pickError } = await supabase
    .from('draft_picks')
    .insert(pickRows)
    .select('id')
  if (pickError) throw new Error(`UI sweep draft pick asset insert: ${pickError.message}`)

  for (const [index, slot] of missingSlots.entries()) {
    const pickId = picks?.[index]?.id
    if (!pickId) throw new Error('UI sweep draft pick asset insert returned fewer rows than expected')
    const { error: updateError } = await supabase
      .from('snake_draft_picks')
      .update({ draft_pick_id: pickId })
      .eq('id', slot.id)
    if (updateError) throw new Error(`UI sweep snake pick asset link: ${updateError.message}`)
  }
}

const ensureSweepDrafts = async (supabase, state, members) => {
  const { data: season, error: seasonError } = await supabase
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', state.leagueId)
    .eq('is_current', true)
    .single()
  if (seasonError) throw new Error(`UI sweep current season lookup: ${seasonError.message}`)

  const startedAt = new Date().toISOString()

  const { data: existingAuction, error: auctionLookupError } = await supabase
    .from('drafts')
    .select('id')
    .eq('league_id', state.leagueId)
    .eq('draft_type', 'auction')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (auctionLookupError) throw new Error(`UI sweep auction draft lookup: ${auctionLookupError.message}`)

  let auctionDraft = existingAuction
  if (!auctionDraft) {
    const { data: insertedAuction, error: auctionInsertError } = await supabase
      .from('drafts')
      .insert({
        league_id: state.leagueId,
        league_season_id: season.id,
        draft_type: 'auction',
        status: 'in_progress',
        budget_per_team: 200,
        started_at: startedAt,
        current_nomination_order: 1,
      })
      .select('id')
      .single()
    if (auctionInsertError) throw new Error(`UI sweep auction draft insert: ${auctionInsertError.message}`)
    auctionDraft = insertedAuction

    const orderRows = members.map((member, index) => ({
      draft_id: auctionDraft.id,
      member_id: member.id,
      position: index + 1,
    }))
    const budgetRows = members.map((member) => ({
      draft_id: auctionDraft.id,
      member_id: member.id,
      initial_budget: 200,
      remaining: 200,
    }))
    const [{ error: orderError }, { error: budgetError }] = await Promise.all([
      supabase.from('draft_orders').insert(orderRows),
      supabase.from('draft_budgets').insert(budgetRows),
    ])
    if (orderError) throw new Error(`UI sweep auction order insert: ${orderError.message}`)
    if (budgetError) throw new Error(`UI sweep auction budget insert: ${budgetError.message}`)
  }

  const { data: existingSnake, error: snakeLookupError } = await supabase
    .from('drafts')
    .select('id')
    .eq('league_id', state.leagueId)
    .eq('draft_type', 'snake')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (snakeLookupError) throw new Error(`UI sweep snake draft lookup: ${snakeLookupError.message}`)

  let rookieDraft = existingSnake
  if (!rookieDraft) {
    const { data: insertedSnake, error: snakeInsertError } = await supabase
      .from('drafts')
      .insert({
        league_id: state.leagueId,
        league_season_id: season.id,
        draft_type: 'snake',
        status: 'in_progress',
        started_at: startedAt,
      })
      .select('id')
      .single()
    if (snakeInsertError) throw new Error(`UI sweep snake draft insert: ${snakeInsertError.message}`)
    rookieDraft = insertedSnake

    const orderRows = members.map((member, index) => ({
      draft_id: rookieDraft.id,
      member_id: member.id,
      position: index + 1,
    }))
    const pickRows = pickRowsForSnakeDraft(members).map((row) => ({
      ...row,
      draft_id: rookieDraft.id,
    }))
    const [{ error: orderError }, { error: pickError }] = await Promise.all([
      supabase.from('draft_orders').insert(orderRows),
      supabase.from('snake_draft_picks').insert(pickRows),
    ])
    if (orderError) throw new Error(`UI sweep snake order insert: ${orderError.message}`)
    if (pickError) throw new Error(`UI sweep snake pick insert: ${pickError.message}`)
  }
  await ensureSnakeDraftPickAssets(supabase, {
    leagueId: state.leagueId,
    seasonYear: season.season_year,
    draftId: rookieDraft.id,
    members,
  })

  return { auctionDraft, rookieDraft }
}

const fetchSweepContext = async (env, state, user) => {
  if (!env.serviceRoleKey || !state.leagueId) {
    throw new Error('Full sweep requires a service role key and seeded league id')
  }

  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const notes = []
  const { data: members, error: membersError } = await supabase
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', state.leagueId)
    .order('joined_at', { ascending: true })
  if (membersError) throw new Error(`UI sweep league_members lookup: ${membersError.message}`)
  if (!members?.length) throw new Error('UI sweep requires at least one seeded league member')

  const myMember = members?.find((member) => member.user_id === user.id) ?? members?.[0]
  const otherMember = members?.find((member) => member.id !== myMember?.id) ?? members?.[0]
  const { auctionDraft, rookieDraft } = await ensureSweepDrafts(supabase, state, members)
  const { data: currentSeason, error: seasonError } = await supabase
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', state.leagueId)
    .eq('is_current', true)
    .single()
  if (seasonError) throw new Error(`UI sweep current season lookup: ${seasonError.message}`)
  const { count: seasonWeekCount, error: seasonWeekError } = await supabase
    .from('season_weeks')
    .select('week_number', { count: 'exact', head: true })
    .eq('season_year', currentSeason.season_year)
  if (seasonWeekError) throw new Error(`UI sweep season week lookup: ${seasonWeekError.message}`)
  if (seasonWeekCount === 0) {
    await ensureSyntheticSeasonWeeks(supabase, currentSeason.season_year, 1, 'UI sweep')
  }

  let { data: rosterRow } = myMember
    ? await supabase
      .from('roster_players')
      .select('player_id')
      .eq('league_id', state.leagueId)
      .eq('member_id', myMember.id)
      .limit(1)
      .maybeSingle()
    : { data: null }

  const { data: firstPlayer } = await supabase
    .from('players')
    .select('id')
    .order('display_name', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!rosterRow && myMember && firstPlayer) {
    const { error: rosterInsertError } = await supabase.from('roster_players').insert({
      league_id: state.leagueId,
      league_season_id: currentSeason.id,
      member_id: myMember.id,
      player_id: firstPlayer.id,
      acquired_via: 'e2e_ui_sweep',
      acquisition_cost: 1,
    })
    if (rosterInsertError) throw new Error(`UI sweep roster fixture insert: ${rosterInsertError.message}`)
    rosterRow = { player_id: firstPlayer.id }
  }
  const playerId = rosterRow?.player_id ?? firstPlayer?.id ?? null

  const routes = [
    ['create-league', '/create-league'],
    ['join-league', '/join-league'],
    ['commissioner-settings', '/commissioner-settings'],
    ['change-password', '/change-password'],
    ['lineup', '/lineup'],
    ['bracket', '/bracket'],
    ['draft-launcher', '/(tabs)/draft-room'],
    ['not-found', '/surface-contract-not-found'],
  ]
  if (playerId) {
    routes.push(['claim-player', encodeQuery('/claim-player', { playerId })])
    routes.push(['player-detail', `/player/${playerId}`])
  } else {
    throw new Error('Full sweep requires a player for player-detail and claim-player routes')
  }
  if (otherMember) {
    routes.push(['propose-trade', encodeQuery('/propose-trade', { recipientMemberId: otherMember.id })])
    routes.push(['team-roster', encodeQuery('/team-roster', {
      memberId: otherMember.id,
      teamName: otherMember.team_name ?? 'Team',
    })])
  } else {
    throw new Error('Full sweep requires another league member for propose-trade and team-roster routes')
  }
  if (auctionDraft?.id) {
    routes.push(['draft-room', encodeQuery('/draft-room', { draftId: auctionDraft.id })])
  } else {
    throw new Error('Full sweep requires an auction draft')
  }
  if (rookieDraft?.id) {
    routes.push(['rookie-draft-room', encodeQuery('/rookie-draft-room', { draftId: rookieDraft.id })])
  } else {
    throw new Error('Full sweep requires a rookie draft')
  }

  return { routes, notes }
}

export async function runBrowserSmoke({
  season = 0,
  scenario = 'smoke',
  userIndex = 0,
  sessionName = undefined,
  fullSweep = process.env.E2E_BROWSER_FULL_SWEEP === '1',
} = {}) {
  const env = requireEnv(resolvedEnv(), ['supabaseUrl', 'anonKey', 'apiBaseUrl'])
  const state = await readState()
  const user = state.users[userIndex]
  if (!user) throw new Error(`No seeded user at index ${userIndex}`)
  if (!state.password) throw new Error('tests/e2e-state.json is missing the seeded user password')

  const session = sessionName ?? safeName(`pancake-soak-${state.runId}-s${season}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, scenario)
  await mkdir(artifactDir, { recursive: true })
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const provenance = await resolveReleaseProvenance()

  const visited = []
  const workflowMeasurements = []
  const routeEvidence = { online: [], offline: [], reconnect: [] }
  const routeCatalog = []
  const pwaProofRequired = fullSweep && process.env.E2E_RELEASE_GATE === '1'
  let workerUpdate = null
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `User: ${user.email}`,
    fullSweep ? 'Full route sweep enabled.' : 'Tab smoke only.',
    sessionList,
  ]

  try {
    await installRuntimeOverrides(browser, session, env)
    const initialJavaScriptDelivery = await measureJavaScriptDelivery(browser, session)
    const sharedScriptUrls = initialJavaScriptDelivery.scriptUrls ?? []
    if (fullSweep) {
      const authRoutes = [
        ['auth-sign-in', '/sign-in'],
        ['auth-sign-up', '/sign-up'],
      ]
      for (const [label, route] of authRoutes) {
        await browser(session, ['open', joinUrl(env.frontendUrl, route)])
        await browser(session, ['wait', '1500'])
        routeCatalog.push([label, route])
        if (pwaProofRequired) {
          routeEvidence.online.push(await observeRoute(session, { label, route, phase: 'online' }))
        }
        await captureBrowserScreenshot(browser, session, artifactDir, `${label}.png`)
        visited.push(label)
      }
    }

    await browser(session, ['open', joinUrl(env.frontendUrl, '/sign-in')])
    await browser(session, ['wait', '1500'])
    await fillTextbox(session, 'Email', user.email)
    await fillTextbox(session, 'Password', state.password)
    await clickButton(session, 'Sign In')
    await browser(session, ['wait', '4000'])

    const routes = [
      ['home', '/'],
      ['players', '/players'],
      ['roster', '/roster'],
      ['trades', '/trades'],
      ['league', '/league'],
      ['dynasty', '/dynasty'],
    ]

    if (fullSweep) {
      const sweep = await fetchSweepContext(env, state, user)
      routes.push(['profile', '/profile'])
      routes.push(...sweep.routes)
      notes.push(...sweep.notes)
    }

    for (const [label, route] of routes) {
      await browser(session, ['open', joinUrl(env.frontendUrl, route)])
      const workflowId = routeWorkflowIds.get(label)
      if (workflowId) {
        const routeTiming = await measureNavigationTiming(browser, session, { workflowId, label, sharedScriptUrls })
        await browser(session, ['open', joinUrl(env.frontendUrl, route)])
        const cachedTiming = await measureNavigationTiming(browser, session, { workflowId, label, sharedScriptUrls })
        const feedback = await measureWorkflowFeedback(browser, session, { workflowId, label })
        if (cachedTiming && feedback?.observed && feedback.feedbackMs != null) {
          recordWorkflowMeasurement(workflowMeasurements, {
            id: workflowId,
            label,
            route,
            ...combineNavigationPhases(routeTiming, cachedTiming),
            feedbackMs: feedback.feedbackMs,
            feedbackObserved: true,
            feedbackInteraction: feedback.interaction,
            routeWebJsKb: routeTiming?.webJsTransferKb,
            routeJsEncodedKb: routeTiming?.routeJsEncodedKb,
            routeJsCacheHit: routeTiming?.routeJsCacheHit,
            routeJsDecodedKb: routeTiming?.routeJsDecodedKb,
            routeJsLedger: routeTiming?.routeJsLedger,
            routeJsEntryCount: routeTiming?.routeJsEntryCount,
            routeJsNetworkEntryCount: routeTiming?.routeJsNetworkEntryCount,
          })
        } else {
          throw new Error(`Observed performance feedback missing for ${workflowId}`)
        }
      } else {
        await browser(session, ['wait', '1500'])
      }
      await captureBrowserScreenshot(browser, session, artifactDir, `${label}.png`)
      routeCatalog.push([label, route])
      if (pwaProofRequired) {
        routeEvidence.online.push(await observeRoute(session, { label, route, phase: 'online' }))
      }
      visited.push(label)
    }
    if (fullSweep) assertFullSweepRoutes(visited)

    if (pwaProofRequired) {
      assertFullSweepRoutes(routeCatalog.map(([label]) => label))
      try {
        await browser(session, ['set', 'offline', 'on'])
        for (const [label, route] of routeCatalog) {
          await browser(session, ['open', joinUrl(env.frontendUrl, route)])
          await browser(session, ['wait', '500'])
          routeEvidence.offline.push(await observeRoute(session, { label, route, phase: 'offline' }))
        }
      } finally {
        await browser(session, ['set', 'offline', 'off']).catch(() => {})
      }
      for (const [label, route] of routeCatalog) {
        await browser(session, ['open', joinUrl(env.frontendUrl, route)])
        await browser(session, ['wait', '750'])
        routeEvidence.reconnect.push(await observeRoute(session, { label, route, phase: 'reconnect' }))
      }
      const routeFailures = routeEvidenceFailures(routeEvidence)
      if (routeFailures.length > 0) {
        throw new Error(`Route cache/PWA proof failed: ${routeFailures.join('; ')}`)
      }
      if (season === 0 || season === 1) workerUpdate = await verifyWorkerUpdate(session)
      await writeFile(
        path.join(artifactDir, 'surface-route-evidence.json'),
        `${JSON.stringify({ schemaVersion: 1, routeEvidence, workerUpdate }, null, 2)}\n`,
      )
    }

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)
    const diagnosticFailures = browserDiagnosticFailures({ consoleOutput, errorOutput })
    if (diagnosticFailures.length > 0) {
      throw new Error(`Browser diagnostics failed: ${diagnosticFailures.join('; ')}`)
    }

    const report = {
      status: 'PASS',
      season,
      scenario,
      session,
      user: user.email,
      visited,
      workflowMeasurements,
      evidenceIds: pwaProofRequired ? [
        'browser.surface_online',
        'browser.surface_offline',
        'browser.surface_reconnect',
        ...(workerUpdate ? ['pwa.cache_update'] : []),
      ] : [],
      routeEvidence,
      workerUpdate,
      initialJavaScriptDelivery,
      provenance,
      artifactDir,
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } catch (error) {
    const report = {
      status: 'FAIL',
      season,
      scenario,
      session,
      user: user.email,
      visited,
      routeEvidence,
      workerUpdate,
      artifactDir,
      provenance,
      error: error instanceof Error ? error.message : String(error),
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  import('./browser-scenario-registry.mjs').then(({ browserScenarioById }) => (
    browserScenarioById('smoke').run({ args: { browserFullSweep: process.env.E2E_BROWSER_FULL_SWEEP === '1' }, season })
  )).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
