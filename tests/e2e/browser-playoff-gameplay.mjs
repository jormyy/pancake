import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-playoff-report.md')

const browser = async (session, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd: ROOT,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 4,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const listSessions = async () => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['session', 'list'], {
    cwd: ROOT,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
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
  if (!parsed.ok) {
    throw new Error(`${label} missing page text: ${parsed.missing.join(', ')}. Sample: ${parsed.sample}`)
  }
  return parsed
}

const backendUrl = (env, pathname) => new URL(pathname, env.apiBaseUrl.endsWith('/') ? env.apiBaseUrl : `${env.apiBaseUrl}/`).toString()

const backendAuthedJson = async (env, pathname, token, body = {}) => {
  const response = await fetch(backendUrl(env, pathname), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
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
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn ${email}: ${error.message}`)
  return { client, accessToken: data.session?.access_token }
}

const signInBrowser = async (session, env, user, password) => {
  await installRuntimeOverrides(browser, session, env, { alerts: true })
  await browser(session, ['wait', '1500'])
  await browser(session, ['find', 'placeholder', 'Email', 'fill', user.email])
  await browser(session, ['find', 'placeholder', 'Password', 'fill', password])
  await browser(session, ['find', 'text', 'Sign In', 'click'])
  await browser(session, ['wait', '4000'])
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

const fetchPlayoffRows = async (admin, leagueId, leagueSeasonId, type) => {
  let query = admin
    .from('matchups')
    .select('id, week_number, matchup_type, home_member_id, away_member_id, home_points, away_points, winner_member_id, is_finalized')
    .eq('league_id', leagueId)
    .eq('league_season_id', leagueSeasonId)
    .order('week_number', { ascending: true })
    .order('created_at', { ascending: true })
  query = Array.isArray(type) ? query.in('matchup_type', type) : query.eq('matchup_type', type)
  const { data, error } = await query
  if (error) throw new Error(`playoff ${type} lookup: ${error.message}`)
  return data ?? []
}

const finalizeMatchupsWithHomeWins = async (admin, rows, label) => {
  for (const [index, row] of rows.entries()) {
    const { error } = await admin
      .from('matchups')
      .update({
        home_points: 140 - index * 3,
        away_points: 101 + index * 2,
        home_max_possible_points: 160 - index * 3,
        away_max_possible_points: 121 + index * 2,
        winner_member_id: row.home_member_id,
        is_finalized: true,
        finalized_at: new Date().toISOString(),
      })
      .eq('id', row.id)
    if (error) throw new Error(`${label} finalize ${row.id}: ${error.message}`)
  }
}

const setupBrowserPlayoffFixture = async (env, season) => {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}`
  const password = `Pancake-playoff-${runId}!`
  const users = Array.from({ length: 10 }, (_, index) => {
    const n = index + 1
    return {
      email: `pancake-playoff-${runId}-${n}@example.com`,
      password,
      username: `pancake_playoff_${runId}_${n}`.replace(/[^a-zA-Z0-9_]/g, '_'),
      displayName: `Pancake Playoff ${runId} #${n}`,
      teamName: `Playoff Team ${n}`,
    }
  })

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const createdUsers = []
  for (const user of users) createdUsers.push(await createConfirmedUser(admin, user))

  const { error: profileError } = await admin.from('profiles').upsert(
    createdUsers.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    })),
    { onConflict: 'id' },
  )
  if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

  const commissionerAuth = await signInClient(env, createdUsers[0].email, password)
  const { data: league, error: createError } = await commissionerAuth.client.rpc('create_league', {
    p_name: `Pancake Browser Playoff ${runId}`,
    p_team_name: createdUsers[0].teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)
  if (!commissionerAuth.accessToken) throw new Error('commissioner sign-in returned no access token')

  for (const user of createdUsers.slice(1)) {
    const { client } = await signInClient(env, user.email, password)
    const { error: joinError } = await client.rpc('join_league_by_invite_code', {
      p_invite_code: league.invite_code,
      p_team_name: user.teamName,
    })
    if (joinError) throw new Error(`join league ${user.email}: ${joinError.message}`)
  }

  const currentSeason = await fetchCurrentSeason(admin, league.id)
  const { data: members, error: membersError } = await admin
    .from('league_members')
    .select('id, user_id, team_name, joined_at')
    .eq('league_id', league.id)
    .order('joined_at', { ascending: true })
  if (membersError) throw new Error(`league members lookup: ${membersError.message}`)
  if ((members ?? []).length !== 10) throw new Error(`expected 10 members, got ${(members ?? []).length}`)

  const regularSeasonRows = []
  for (const [index, member] of members.entries()) {
    const wins = members.length - index
    for (let win = 0; win < wins; win += 1) {
      const opponentOffset = (win % (members.length - 1)) + 1
      const opponent = members[(index + opponentOffset) % members.length]
      regularSeasonRows.push({
        league_id: league.id,
        league_season_id: currentSeason.id,
        week_number: 100 + index * 20 + win,
        matchup_type: 'regular_season',
        home_member_id: member.id,
        away_member_id: opponent.id,
        home_points: 200 - index,
        away_points: 50 + index,
        home_max_possible_points: 220 - index,
        away_max_possible_points: 70 + index,
        winner_member_id: member.id,
        is_finalized: true,
        finalized_at: new Date().toISOString(),
      })
    }
  }
  const { error: matchupError } = await admin.from('matchups').insert(regularSeasonRows)
  if (matchupError) throw new Error(`regular-season fixture insert: ${matchupError.message}`)

  const { error: statusError } = await admin
    .from('leagues')
    .update({ status: 'playoffs' })
    .eq('id', league.id)
  if (statusError) throw new Error(`league playoff status update: ${statusError.message}`)

  await backendAuthedJson(env, '/playoffs/generate', commissionerAuth.accessToken, { leagueId: league.id })
  const quarterfinals = await fetchPlayoffRows(admin, league.id, currentSeason.id, 'playoff_quarterfinal')
  if (quarterfinals.length !== 2) throw new Error(`expected 2 quarterfinals, got ${quarterfinals.length}`)

  let advanceBeforeFinalized = null
  let advanceBlocked = false
  try {
    await backendAuthedJson(env, '/playoffs/advance', commissionerAuth.accessToken, { leagueId: league.id })
  } catch (error) {
    advanceBlocked = true
    advanceBeforeFinalized = error instanceof Error ? error.message : String(error)
  }
  if (!advanceBlocked) throw new Error('advance unexpectedly succeeded before quarterfinals finalized')
  if (!advanceBeforeFinalized?.includes('Quarterfinals are not yet finalized')) {
    throw new Error(`advance before quarterfinals failed for the wrong reason: ${advanceBeforeFinalized}`)
  }

  await finalizeMatchupsWithHomeWins(admin, quarterfinals, 'quarterfinal')
  await backendAuthedJson(env, '/playoffs/advance', commissionerAuth.accessToken, { leagueId: league.id })
  const semifinals = await fetchPlayoffRows(admin, league.id, currentSeason.id, 'playoff_semifinal')
  if (semifinals.length !== 2) throw new Error(`expected 2 semifinals, got ${semifinals.length}`)

  let semifinalAdvanceBeforeFinalized = null
  let semifinalAdvanceBlocked = false
  try {
    await backendAuthedJson(env, '/playoffs/advance', commissionerAuth.accessToken, { leagueId: league.id })
  } catch (error) {
    semifinalAdvanceBlocked = true
    semifinalAdvanceBeforeFinalized = error instanceof Error ? error.message : String(error)
    // Expected while semifinal rows are still open.
  }
  if (!semifinalAdvanceBlocked) throw new Error('advance unexpectedly succeeded before semifinals finalized')
  if (!semifinalAdvanceBeforeFinalized?.includes('Semifinals are not yet finalized')) {
    throw new Error(`advance before semifinals failed for the wrong reason: ${semifinalAdvanceBeforeFinalized}`)
  }

  await finalizeMatchupsWithHomeWins(admin, semifinals, 'semifinal')
  await backendAuthedJson(env, '/playoffs/advance', commissionerAuth.accessToken, { leagueId: league.id })
  const finals = await fetchPlayoffRows(admin, league.id, currentSeason.id, 'playoff_final')
  if (finals.length !== 1) throw new Error(`expected 1 championship matchup, got ${finals.length}`)

  await finalizeMatchupsWithHomeWins(admin, finals, 'championship')
  const final = (await fetchPlayoffRows(admin, league.id, currentSeason.id, 'playoff_final'))[0]
  if (!final?.winner_member_id) throw new Error('championship final did not persist a winner')

  const championMember = members.find((member) => member.id === final.winner_member_id)
  if (!championMember) throw new Error(`champion member ${final.winner_member_id} not found`)
  const championUser = createdUsers.find((user) => user.id === championMember.user_id)
  if (!championUser) throw new Error(`champion user ${championMember.user_id} not found`)

  return {
    admin,
    runId,
    password,
    league,
    currentSeason,
    users: createdUsers,
    members,
    regularSeasonRows: regularSeasonRows.length,
    quarterfinals,
    semifinals,
    final,
    championMember,
    championUser,
    advanceBeforeFinalized,
    semifinalAdvanceBeforeFinalized,
  }
}

export async function runBrowserPlayoffChampionScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey', 'apiBaseUrl'])
  const fixture = await setupBrowserPlayoffFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-playoff-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-playoff')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Champion user: ${fixture.championUser.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.championUser, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, '/bracket')])
    await browser(session, ['wait', '2500'])
    await assertPageText(
      session,
      ['CHAMPION', fixture.championMember.team_name, 'SEMIFINALS', 'CHAMPIONSHIP', 'Final'],
      'playoff champion bracket',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'champion-bracket.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = []
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        championMemberId: fixture.championMember.id,
        championTeamName: fixture.championMember.team_name,
        finalMatchupId: fixture.final.id,
      },
      checks: {
        regularSeasonRows: fixture.regularSeasonRows,
        quarterfinals: fixture.quarterfinals.length,
        semifinals: fixture.semifinals.length,
        advanceBeforeFinalized: fixture.advanceBeforeFinalized,
        semifinalAdvanceBeforeFinalized: fixture.semifinalAdvanceBeforeFinalized,
      },
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser playoff champion scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    debug = { ...debug, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        championMemberId: fixture.championMember.id,
        championTeamName: fixture.championMember.team_name,
        finalMatchupId: fixture.final.id,
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
  runBrowserPlayoffChampionScenario({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
