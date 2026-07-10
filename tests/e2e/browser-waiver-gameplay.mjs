import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides } from './browser-runtime-overrides.mjs'
import { clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { createFixtureResourceOwner } from './trade-fixture.mjs'
import { runBrowserScenarioLifecycle } from './browser-scenario-lifecycle.mjs'

const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-waiver-report.md')
const DROP_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-waiver-drop-report.md')
const IR_BLOCK_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-waiver-ir-block-report.md')
const E2E_PLAYER_PREFIX = 'e2e-player-'

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

const findAvailablePlayers = async (
  admin,
  leagueId,
  leagueSeasonId,
  count = 1,
  runId = 'manual',
  registerCreatedPlayer = /** @type {(id: string) => void} */ (() => {}),
) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin
      .from('roster_players')
      .select('player_id')
      .eq('league_id', leagueId)
      .eq('league_season_id', leagueSeasonId),
    admin
      .from('players')
      .select('id, display_name, sportsdata_id')
      .like('sportsdata_id', `${E2E_PLAYER_PREFIX}%`)
      .order('display_name', { ascending: true })
      .limit(200),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const available = (players ?? []).filter((row) => row.display_name && !rosteredIds.has(row.id))
  if (available.length >= count) return available.slice(0, count)
  const fallbackRows = Array.from({ length: count - available.length }, (_, index) => ({
    sportsdata_id: `e2e-waiver-${runId}-${index + 1}`,
    first_name: 'E2E',
    last_name: `Waiver ${runId} ${index + 1}`,
    nba_team: 'FA',
    position: 'PG',
    eligible_positions: ['PG'],
    status: 'Active',
    years_exp: 1,
  }))
  const { data: fallbackPlayers, error: fallbackError } = await admin
    .from('players')
    .insert(fallbackRows)
    .select('id, display_name, sportsdata_id')
  if (fallbackError) throw new Error(`waiver fallback player insert: ${fallbackError.message}`)
  for (const player of fallbackPlayers ?? []) registerCreatedPlayer(player.id)
  return [...available, ...(fallbackPlayers ?? [])].slice(0, count)
}

const setupWaiverGameplayFixture = async (env, season, { requiresDrop = false, hasIneligibleIR = false } = {}) => {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}`
  const password = `Pancake-waiver-${runId}!`
  const user = {
    email: `pancake-waiver-${runId}@example.com`,
    password,
    username: `pancake_waiver_${runId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Waiver ${runId}`,
    teamName: 'Waiver Gameplay Team',
  }

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const resources = createFixtureResourceOwner(admin)
  const createdUser = await createConfirmedUser(admin, user)
  resources.registerUser(createdUser.id)

  const { error: profileError } = await admin.from('profiles').upsert({
    id: createdUser.id,
    username: createdUser.username,
    display_name: createdUser.displayName,
  }, { onConflict: 'id' })
  if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

  const commissioner = await signInClient(env, createdUser.email, password)
  const { data: league, error: createError } = await commissioner.rpc('create_league', {
    p_name: `Pancake Browser Waiver ${runId}`,
    p_team_name: createdUser.teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)
  resources.registerLeague(league.id)

  const { error: activeLeagueError } = await admin
    .from('leagues')
    .update({ status: 'active' })
    .eq('id', league.id)
  if (activeLeagueError) throw new Error(`waiver league activation: ${activeLeagueError.message}`)

  const currentSeason = await fetchCurrentSeason(admin, league.id)
  const { data: member, error: memberError } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', league.id)
    .eq('user_id', createdUser.id)
    .single()
  if (memberError || !member) throw new Error(`league member lookup: ${memberError?.message ?? 'missing row'}`)

  const { data: priority, error: priorityError } = await admin
    .from('waiver_priorities')
    .select('id, priority')
    .eq('league_id', league.id)
    .eq('league_season_id', currentSeason.id)
    .eq('member_id', member.id)
    .maybeSingle()
  if (priorityError) throw new Error(`waiver priority lookup: ${priorityError.message}`)
  if (!priority) {
    const { error } = await admin.from('waiver_priorities').insert({
      league_id: league.id,
      league_season_id: currentSeason.id,
      member_id: member.id,
      priority: 1,
    })
    if (error) throw new Error(`waiver priority insert: ${error.message}`)
  }

  const requiredPlayerCount = 1 + (requiresDrop ? 1 : 0) + (hasIneligibleIR ? 1 : 0)
  const availablePlayers = await findAvailablePlayers(
    admin,
    league.id,
    currentSeason.id,
    requiredPlayerCount,
    runId,
    resources.registerPlayer,
  )
  const player = availablePlayers[0]
  const dropPlayer = requiresDrop ? availablePlayers[1] : null
  const irPlayer = hasIneligibleIR ? availablePlayers[requiresDrop ? 2 : 1] : null
  let dropRosterPlayer = null
  if (requiresDrop) {
    const { error: leagueError } = await admin
      .from('leagues')
      .update({ roster_size: 1 })
      .eq('id', league.id)
    if (leagueError) throw new Error(`waiver drop league update: ${leagueError.message}`)

    const { data: rosterRow, error: rosterInsertError } = await admin
      .from('roster_players')
      .insert({
        league_id: league.id,
        league_season_id: currentSeason.id,
        member_id: member.id,
        player_id: dropPlayer.id,
        acquired_via: 'e2e_waiver_drop_fixture',
      })
      .select('id, player_id')
      .single()
    if (rosterInsertError) throw new Error(`waiver drop roster seed: ${rosterInsertError.message}`)
    dropRosterPlayer = rosterRow
  }
  let irRosterPlayer = null
  if (hasIneligibleIR && irPlayer) {
    const [{ error: playerUpdateError }, { data: rosterRow, error: rosterInsertError }] = await Promise.all([
      admin
        .from('players')
        .update({ injury_status: 'DTD' })
        .eq('id', irPlayer.id),
      admin
        .from('roster_players')
        .insert({
          league_id: league.id,
          league_season_id: currentSeason.id,
          member_id: member.id,
          player_id: irPlayer.id,
          is_on_ir: true,
          acquired_via: 'e2e_waiver_ir_fixture',
        })
        .select('id, player_id')
        .single(),
    ])
    if (playerUpdateError) throw new Error(`waiver IR player update: ${playerUpdateError.message}`)
    if (rosterInsertError) throw new Error(`waiver IR roster seed: ${rosterInsertError.message}`)
    irRosterPlayer = rosterRow
    irPlayer.injury_status = 'DTD'
  }

  const { data: waiverLog, error: waiverLogError } = await admin
    .from('waiver_wire_log')
    .insert({
      league_id: league.id,
      league_season_id: currentSeason.id,
      player_id: player.id,
      dropped_by_member_id: null,
      clears_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (waiverLogError) throw new Error(`waiver log insert: ${waiverLogError.message}`)

  if (irPlayer) {
    resources.registerCleanup(`waiver IR player ${irPlayer.id}`, async () => {
      const { error } = await admin.from('players').update({ injury_status: null }).eq('id', irPlayer.id)
      if (error) throw new Error(error.message)
    })
  }
  return {
    admin,
    runId,
    password,
    user: createdUser,
    league,
    currentSeason,
    member,
    player,
    dropPlayer: dropPlayer ?? null,
    dropRosterPlayer,
    irPlayer: irPlayer ?? null,
    irRosterPlayer,
    waiverLog,
    dispose: resources.dispose,
  }
}

const signInBrowser = async (session, env, user, password) => {
  await installRuntimeOverrides(browser, session, env, { alerts: true })
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

const clickButton = async (session, name, label) => {
  try {
    await browser(session, ['find', 'role', 'button', 'click', '--name', name])
    return { ok: true, method: 'agent-browser-find-role-button' }
  } catch {
    const output = await browser(session, [
      'eval',
      `(() => {
        const textNode = [...document.querySelectorAll('*')]
          .reverse()
          .find((element) => (element.textContent || '').trim() === ${JSON.stringify(name)});
        const target = textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
        if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1000) });
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        target.click();
        return JSON.stringify({
          ok: true,
          tagName: target.tagName,
          role: target.getAttribute('role'),
          text: target.textContent,
        });
      })()`,
    ])
    const parsed = parseEvalJson(output)
    if (!parsed.ok) throw new Error(`${label}: button not found: ${name}. Body: ${parsed.body}`)
    return parsed
  }
}

const verifyWaiverClaim = async (fixture) => {
  const { data: claims, error } = await fixture.admin
    .from('waiver_claims')
    .select('id, league_id, league_season_id, member_id, player_id, drop_player_id, status, priority_at_submission, process_date')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.member.id)
    .eq('player_id', fixture.player.id)
    .eq('status', 'pending')
  if (error) throw new Error(`waiver claim verify: ${error.message}`)

  const failures = []
  if ((claims ?? []).length !== 1) {
    failures.push(`pending claim rows=${(claims ?? []).length}; expected 1`)
  }
  const claim = claims?.[0] ?? null
  const expectedDropPlayerId = fixture.dropPlayer?.id ?? null
  if ((claim?.drop_player_id ?? null) !== expectedDropPlayerId) {
    failures.push(`drop_player_id=${claim?.drop_player_id ?? '<null>'}; expected ${expectedDropPlayerId ?? '<null>'}`)
  }
  if (claim?.priority_at_submission !== 1) failures.push(`priority_at_submission=${claim?.priority_at_submission}; expected 1`)
  return { claim, failures }
}

const waitForWaiverClaim = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyWaiverClaim(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyWaiverClaim(fixture)
  }
  return last
}

const verifyNoWaiverClaim = async (fixture) => {
  const { data: claims, error } = await fixture.admin
    .from('waiver_claims')
    .select('id, status')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.member.id)
    .eq('player_id', fixture.player.id)
  if (error) throw new Error(`waiver no-claim verify: ${error.message}`)
  return {
    claims: claims ?? [],
    failures: (claims ?? []).length === 0 ? [] : [`waiver_claim rows=${claims.length}; expected 0`],
  }
}

export async function runBrowserWaiverScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupWaiverGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-waiver-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-waiver')
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Claimant: ${fixture.user.email}`,
    sessionList,
  ]
  return runBrowserScenarioLifecycle({
    browser,
    session,
    artifactDir,
    reportPath: REPORT_PATH,
    season,
    fixtureSummary: () => ({
      runId: fixture.runId,
      leagueId: fixture.league.id,
      leagueSeasonId: fixture.currentSeason.id,
      memberId: fixture.member.id,
      playerId: fixture.player.id,
      waiverLogId: fixture.waiverLog.id,
    }),
    notes,
    failureLabel: 'Browser waiver scenario failed',
    run: async ({ record }) => {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['open', joinUrl(env.frontendUrl, `/claim-player?playerId=${fixture.player.id}`)])
    await browser(session, ['wait', '2500'])
    await assertPageText(session, ['Waiver Claim', 'CLAIMING', fixture.player.display_name, 'No drop required.', 'Submit Claim'], 'waiver claim before submit')
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-before-submit.png')], { timeout: 60_000 })
    const clickResult = await clickButton(session, 'Submit waiver claim', 'waiver submit button')
    const waiverClaim = await waitForWaiverClaim(fixture)
    record({ clickResult, waiverClaim })
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-after-submit.png')], { timeout: 60_000 })

    return { fields: { waiverClaim }, failures: waiverClaim.failures }
    },
    verifyFailure: async () => ({ waiverClaim: await verifyWaiverClaim(fixture) }),
  })
}

export async function runBrowserWaiverDropScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupWaiverGameplayFixture(env, season, { requiresDrop: true })
  if (!fixture.dropRosterPlayer) throw new Error('Waiver drop fixture is missing its rostered drop player')
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-waiver-drop-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-waiver-drop')
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Claimant: ${fixture.user.email}`,
    sessionList,
  ]
  return runBrowserScenarioLifecycle({
    browser,
    session,
    artifactDir,
    reportPath: DROP_REPORT_PATH,
    season,
    fixtureSummary: () => ({
      runId: fixture.runId,
      leagueId: fixture.league.id,
      leagueSeasonId: fixture.currentSeason.id,
      memberId: fixture.member.id,
      playerId: fixture.player.id,
      dropPlayerId: fixture.dropPlayer.id,
      dropRosterPlayerId: fixture.dropRosterPlayer.id,
      waiverLogId: fixture.waiverLog.id,
    }),
    notes,
    failureLabel: 'Browser waiver drop scenario failed',
    run: async ({ record }) => {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['open', joinUrl(env.frontendUrl, `/claim-player?playerId=${fixture.player.id}`)])
    await browser(session, ['wait', '2500'])
    await assertPageText(
      session,
      ['Waiver Claim', 'DROP A PLAYER (required)', fixture.player.display_name, fixture.dropPlayer.display_name, 'Submit Claim'],
      'waiver drop claim before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-drop-before-submit.png')], { timeout: 60_000 })
    const dropClick = await clickButton(session, `Select ${fixture.dropPlayer.display_name} to drop`, 'waiver drop row')
    const submitClick = await clickButton(session, 'Submit waiver claim', 'waiver drop submit button')
    const waiverClaim = await waitForWaiverClaim(fixture)
    record({ dropClick, submitClick, waiverClaim })
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-drop-after-submit.png')], { timeout: 60_000 })

    return { fields: { waiverClaim }, failures: waiverClaim.failures }
    },
    verifyFailure: async () => ({ waiverClaim: await verifyWaiverClaim(fixture) }),
  })
}

export async function runBrowserWaiverIrBlockScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupWaiverGameplayFixture(env, season, { hasIneligibleIR: true })
  if (!fixture.irRosterPlayer) throw new Error('Waiver IR fixture is missing its rostered IR player')
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-waiver-ir-block-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-waiver-ir-block')
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Claimant: ${fixture.user.email}`,
    sessionList,
  ]
  return runBrowserScenarioLifecycle({
    browser,
    session,
    artifactDir,
    reportPath: IR_BLOCK_REPORT_PATH,
    season,
    fixtureSummary: () => ({
      runId: fixture.runId,
      leagueId: fixture.league.id,
      leagueSeasonId: fixture.currentSeason.id,
      memberId: fixture.member.id,
      playerId: fixture.player.id,
      irPlayerId: fixture.irPlayer.id,
      irRosterPlayerId: fixture.irRosterPlayer.id,
      waiverLogId: fixture.waiverLog.id,
    }),
    notes,
    failureLabel: 'Browser waiver IR block scenario failed',
    run: async ({ record }) => {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['open', joinUrl(env.frontendUrl, `/claim-player?playerId=${fixture.player.id}`)])
    await browser(session, ['wait', '2500'])
    await assertPageText(
      session,
      ['Waiver Claim', 'Resolve IR Status First', fixture.irPlayer.display_name, 'DTD', 'Go to Roster'],
      'waiver IR block before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-ir-block.png')], { timeout: 60_000 })
    const noClaim = await verifyNoWaiverClaim(fixture)
    record({ noClaim })
    return { fields: { noClaim }, failures: noClaim.failures }
    },
    verifyFailure: async () => ({ noClaim: await verifyNoWaiverClaim(fixture) }),
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  const scenarioId = process.argv.includes('--ir-block')
    ? 'waiver-ir-block'
    : process.argv.includes('--drop')
    ? 'waiver-drop'
    : 'waiver'
  import('./browser-scenario-registry.mjs').then(({ browserScenarioById }) => (
    browserScenarioById(scenarioId).run({ args: { browserFullSweep: false }, season })
  )).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
