import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { createFixtureResourceOwner } from './trade-fixture.mjs'

const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-rookie-draft-report.md')

const browser = createBrowser({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const listSessions = () => listBrowserSessions({ cwd: ROOT })

const backendUrl = (env, pathname) => {
  const base = env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`
  return new URL(pathname.replace(/^\/+/, ''), base).toString()
}

const backendJson = async (env, pathname, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-e2e-secret': env.e2eAdminSecret,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`${pathname} returned ${response.status}${text ? `: ${text}` : ''}`)
  }
  return response.json()
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
        sample: text.slice(0, 1000)
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label} missing page text: ${parsed.missing.join(', ')}. Sample: ${parsed.sample}`)
  return parsed
}

const setupBrowserRookieDraftFixture = async (env, season) => {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}`
  const password = `Pancake-rookie-${runId}!`
  const users = [1, 2, 3, 4].map((n) => ({
    email: `pancake-rookie-${runId}-${n}@example.com`,
    password,
    username: `pancake_rookie_${runId}_${n}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Rookie ${runId} #${n}`,
    teamName: `Rookie Team ${n}`,
  }))

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const resources = createFixtureResourceOwner(admin)
  const createdUsers = []
  for (const user of users) {
    const createdUser = await createConfirmedUser(admin, user)
    resources.registerUser(createdUser.id)
    createdUsers.push(createdUser)
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
    p_name: `Pancake Browser Rookie ${runId}`,
    p_team_name: createdUsers[0].teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)
  resources.registerLeague(league.id)

  for (const user of createdUsers.slice(1)) {
    const memberClient = await signInClient(env, user.email, password)
    const { error: joinError } = await memberClient.rpc('join_league_by_invite_code', {
      p_invite_code: league.invite_code,
      p_team_name: user.teamName,
    })
    if (joinError) throw new Error(`join league ${user.email}: ${joinError.message}`)
  }

  const { data: currentSeason, error: seasonError } = await admin
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', league.id)
    .eq('is_current', true)
    .single()
  if (seasonError) throw new Error(`current season lookup: ${seasonError.message}`)

  const { data: members, error: membersError } = await admin
    .from('league_members')
    .select('id, user_id, team_name, joined_at')
    .eq('league_id', league.id)
    .order('joined_at', { ascending: true })
  if (membersError) throw new Error(`league members lookup: ${membersError.message}`)
  if ((members ?? []).length !== 4) throw new Error(`expected 4 members, got ${(members ?? []).length}`)

  const [member1, member2, member3, member4] = members
  const previousSeasonYear = currentSeason.season_year - 1
  const { data: previousSeason, error: previousSeasonError } = await admin
    .from('league_seasons')
    .insert({
      league_id: league.id,
      season_year: previousSeasonYear,
      is_current: false,
    })
    .select('id')
    .single()
  if (previousSeasonError) throw new Error(`previous season insert: ${previousSeasonError.message}`)

  const standingsRows = [
    { member: member4, wins: 1, pointsFor: 800, priority: 1 },
    { member: member3, wins: 3, pointsFor: 900, priority: 2 },
    { member: member2, wins: 5, pointsFor: 1000, priority: 3 },
    { member: member1, wins: 7, pointsFor: 1100, priority: 4 },
  ].map((row) => ({
    league_id: league.id,
    league_season_id: previousSeason.id,
    member_id: row.member.id,
    week_number: 19,
    wins: row.wins,
    losses: 10 - row.wins,
    ties: 0,
    points_for: row.pointsFor,
    points_against: 1000,
    max_possible_points: row.pointsFor + 100,
    waiver_priority: row.priority,
  }))
  const { error: standingsError } = await admin.from('standings').insert(standingsRows)
  if (standingsError) throw new Error(`previous standings insert: ${standingsError.message}`)

  const pickRows = []
  for (const member of members) {
    for (let round = 1; round <= 3; round += 1) {
      pickRows.push({
        league_id: league.id,
        season_year: currentSeason.season_year,
        round,
        original_owner_id: member.id,
        current_owner_id: member.id,
      })
    }
  }
  const { error: pickError } = await admin.from('draft_picks').insert(pickRows)
  if (pickError) throw new Error(`draft pick asset insert: ${pickError.message}`)

  const { data: rookies, error: rookiesError } = await admin
    .from('players')
    .select('id, display_name, nba_draft_number')
    .not('nba_draft_number', 'is', null)
    .order('nba_draft_number', { ascending: true })
    .order('id', { ascending: true })
    .limit(4)
  if (rookiesError) throw new Error(`rookie player lookup: ${rookiesError.message}`)
  if ((rookies ?? []).length < 2) throw new Error('browser rookie draft requires at least two players with nba_draft_number')

  const { error: leagueStatusError } = await admin
    .from('leagues')
    .update({ status: 'offseason' })
    .eq('id', league.id)
  if (leagueStatusError) throw new Error(`league offseason update: ${leagueStatusError.message}`)

  const { draft } = await backendJson(env, '/e2e/start-rookie-draft', { leagueId: league.id })
  const { data: slots, error: slotsError } = await admin
    .from('snake_draft_picks')
    .select('id, overall_pick, round, pick_in_round, member_id, player_id, picked_at, draft_pick_id')
    .eq('draft_id', draft.id)
    .order('overall_pick', { ascending: true })
  if (slotsError) throw new Error(`draft slot read: ${slotsError.message}`)
  const firstSlot = slots?.[0]
  if (!firstSlot) throw new Error('browser rookie draft created no pick slots')
  if (firstSlot.member_id !== member4.id) {
    throw new Error(`browser rookie draft first slot ${firstSlot.member_id}; expected inverse-standings member ${member4.id}`)
  }

  return {
    admin,
    runId,
    password,
    users: createdUsers,
    activeUser: createdUsers[3],
    league,
    currentSeason,
    previousSeason,
    members,
    firstSlot,
    draft,
    rookies,
    expectedAutoPickPlayer: rookies[0],
    dispose: resources.dispose,
  }
}

const verifyAutoPick = async (fixture) => {
  const [{ data: pickedSlot, error: slotError }, { data: rosterRows, error: rosterError }, { data: usedPick, error: pickError }] = await Promise.all([
    fixture.admin
      .from('snake_draft_picks')
      .select('id, player_id, picked_at, draft_pick_id')
      .eq('id', fixture.firstSlot.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('player_id', fixture.expectedAutoPickPlayer.id),
    fixture.admin
      .from('draft_picks')
      .select('id, is_used, rookie_draft_id, used_at')
      .eq('id', fixture.firstSlot.draft_pick_id)
      .single(),
  ])
  if (slotError) throw new Error(`auto-pick slot verify: ${slotError.message}`)
  if (rosterError) throw new Error(`auto-pick roster verify: ${rosterError.message}`)
  if (pickError) throw new Error(`auto-pick asset verify: ${pickError.message}`)

  const failures = []
  if (pickedSlot.player_id !== fixture.expectedAutoPickPlayer.id) {
    failures.push(`picked player=${pickedSlot.player_id ?? '<null>'}; expected ${fixture.expectedAutoPickPlayer.id}`)
  }
  if (!pickedSlot.picked_at) failures.push('picked_at was not stamped')
  if ((rosterRows ?? []).length !== 1 || rosterRows?.[0]?.member_id !== fixture.firstSlot.member_id) {
    failures.push(`roster rows=${JSON.stringify(rosterRows)}; expected one row for first pick owner ${fixture.firstSlot.member_id}`)
  }
  if (!usedPick.is_used || usedPick.rookie_draft_id !== fixture.draft.id || !usedPick.used_at) {
    failures.push(`linked draft_pick usage=${JSON.stringify(usedPick)}; expected used by ${fixture.draft.id}`)
  }
  return { pickedSlot, rosterRows: rosterRows ?? [], usedPick, failures }
}

const waitForAutoPick = async (fixture, timeoutMs = 12_000) => {
  const startedAt = Date.now()
  let last = await verifyAutoPick(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyAutoPick(fixture)
  }
  return last
}

export async function runBrowserRookieDraftAutoPickScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey', 'apiBaseUrl', 'e2eAdminSecret'])
  const fixture = await setupBrowserRookieDraftFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-rookie-draft-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-rookie-draft')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Manager: ${fixture.activeUser.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.activeUser, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    const fastTimerExpiresAt = new Date(Date.now() + 3_000).toISOString()
    const { error: draftClockError } = await fixture.admin
      .from('snake_draft_picks')
      .update({ timer_expires_at: fastTimerExpiresAt })
      .eq('id', fixture.firstSlot.id)
    if (draftClockError) throw new Error(`draft clock update: ${draftClockError.message}`)
    await browser(session, ['open', joinUrl(env.frontendUrl, `/rookie-draft-room?draftId=${fixture.draft.id}`)])
    await browser(session, ['wait', '1000'])
    await assertPageText(
      session,
      ['Round 1', 'Pick 1', fixture.members[3].team_name, '(you)', 'Prospects'],
      'rookie draft before auto-pick',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'rookie-draft-before-auto-pick.png')], { timeout: 60_000 })
    const autoPickCheck = await waitForAutoPick(fixture)
    debug = { ...debug, autoPickCheck }
    if (autoPickCheck.failures.length > 0) {
      throw new Error(`browser rookie draft auto-pick did not persist: ${autoPickCheck.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1500'])
    await assertPageText(session, ['Pick 2', fixture.members[2].team_name], 'rookie draft after auto-pick')
    await browser(session, ['screenshot', path.join(artifactDir, 'rookie-draft-after-auto-pick.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...autoPickCheck.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        draftId: fixture.draft.id,
        firstSlotId: fixture.firstSlot.id,
        firstSlotMemberId: fixture.firstSlot.member_id,
        expectedAutoPickPlayerId: fixture.expectedAutoPickPlayer.id,
      },
      autoPickCheck,
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser rookie draft auto-pick scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const autoPickCheck = await verifyAutoPick(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, autoPickCheck, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        draftId: fixture.draft.id,
        firstSlotId: fixture.firstSlot.id,
        firstSlotMemberId: fixture.firstSlot.member_id,
        expectedAutoPickPlayerId: fixture.expectedAutoPickPlayer.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
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
    browserScenarioById('rookie-draft').run({ args: { browserFullSweep: false }, season })
  )).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
