import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'

const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-league-lifecycle-report.md')

const EXPECTED_LINEUP_SLOTS = {
  PG: 1,
  SG: 1,
  SF: 1,
  PF: 1,
  C: 1,
  G: 1,
  F: 1,
  UTIL: 3,
  BE: 10,
  IR: 2,
}

const browser = createBrowser({ cwd: ROOT })

const listSessions = () => listBrowserSessions({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const waitForBodyText = async (session, predicateSource, label, attempts = 20) => {
  let latest = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await browser(session, [
      'eval',
      `(() => {
        const text = document.body?.innerText || '';
        const ok = (${predicateSource})(text);
        return JSON.stringify({ ok, text: text.slice(0, 1200) });
      })()`,
    ])
    latest = parseEvalJson(result)
    if (latest.ok) return latest.text
    await browser(session, ['wait', '1000']).catch(() => {})
  }
  throw new Error(`${label}: expected text did not appear. Last body: ${latest?.text ?? '<empty>'}`)
}

const clickExactText = async (session, text, label) => {
  const result = await browser(session, [
    'eval',
    `(() => {
      const target = [...document.querySelectorAll('*')]
        .reverse()
        .find((element) => (element.textContent || '').trim() === ${JSON.stringify(text)});
      if (!target) return JSON.stringify({ ok: false });
      target.click();
      return JSON.stringify({ ok: true, tagName: target.tagName, text: target.textContent });
    })()`,
  ])
  const parsed = parseEvalJson(result)
  if (!parsed.ok) throw new Error(`${label}: text not found: ${text}`)
}

const signIn = async (session, env, user) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/sign-in')])
  await browser(session, ['wait', '1500'])
  await fillSignInCredentials(browser, session, user.email, user.password)
  await clickButtonByName(browser, session, 'Sign In')
  await waitForBodyText(
    session,
    `(text) => text.includes('Players') || text.includes('Join or create') || text.includes(${JSON.stringify(user.email)})`,
    `sign-in ${user.email}`,
  )
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

  const { error: profileError } = await admin.from('profiles').upsert({
    id: data.user.id,
    username: user.username,
    display_name: user.displayName,
  }, { onConflict: 'id' })
  if (profileError) throw new Error(`profile upsert ${user.email}: ${profileError.message}`)

  return { ...user, id: data.user.id }
}

const verifyLeagueState = async ({ admin, leagueId, commissionerUserId, managerUserId, inviteCode }) => {
  const failures = []
  const { data: league, error: leagueError } = await admin
    .from('leagues')
    .select('id, name, invite_code, commissioner_id, auction_budget')
    .eq('id', leagueId)
    .single()
  if (leagueError || !league) throw new Error(`D.SET.2 browser league read: ${leagueError?.message ?? 'missing league'}`)
  if (league.invite_code !== inviteCode) failures.push(`invite_code=${league.invite_code}; expected ${inviteCode}`)
  if (league.commissioner_id !== commissionerUserId) failures.push('commissioner_id did not match browser creator')
  if (league.auction_budget !== 200) failures.push(`auction_budget=${league.auction_budget}; expected 200`)

  const { data: members, error: membersError } = await admin
    .from('league_members')
    .select('id, user_id, role, team_name')
    .eq('league_id', leagueId)
  if (membersError) throw new Error(`D.SET.2 browser members read: ${membersError.message}`)
  if ((members ?? []).length !== 2) failures.push(`league_members=${members?.length ?? 0}; expected 2`)
  if (!members?.some((member) => member.user_id === commissionerUserId && member.role === 'commissioner')) {
    failures.push('commissioner member row missing')
  }
  if (!members?.some((member) => member.user_id === managerUserId && member.role === 'manager')) {
    failures.push('joined manager member row missing')
  }

  const { data: season, error: seasonError } = await admin
    .from('league_seasons')
    .select('id, season_year, is_current')
    .eq('league_id', leagueId)
    .eq('is_current', true)
  if (seasonError) throw new Error(`D.SET.2 browser season read: ${seasonError.message}`)
  if ((season ?? []).length !== 1) failures.push(`current league_seasons=${season?.length ?? 0}; expected 1`)

  const { data: slots, error: slotsError } = await admin
    .from('lineup_slot_templates')
    .select('slot_type, slot_count')
    .eq('league_id', leagueId)
  if (slotsError) throw new Error(`D.SET.2 browser slots read: ${slotsError.message}`)
  const slotMap = new Map((slots ?? []).map((slot) => [slot.slot_type, slot.slot_count]))
  for (const [slotType, expected] of Object.entries(EXPECTED_LINEUP_SLOTS)) {
    if (slotMap.get(slotType) !== expected) failures.push(`${slotType} slots=${slotMap.get(slotType)}; expected ${expected}`)
  }

  const memberCount = members?.length ?? 0
  const currentSeasonYear = season?.[0]?.season_year ?? new Date().getUTCFullYear()
  const { count: pickCount, error: pickError } = await admin
    .from('draft_picks')
    .select('id', { count: 'exact', head: true })
    .eq('league_id', leagueId)
    .gte('season_year', currentSeasonYear + 1)
    .lte('season_year', currentSeasonYear + 5)
  if (pickError) throw new Error(`D.SET.2 browser pick bank read: ${pickError.message}`)
  const expectedPickCount = memberCount * 5 * 3
  if (pickCount !== expectedPickCount) failures.push(`draft_picks=${pickCount}; expected ${expectedPickCount}`)

  return { failures, league, members, currentSeason: season?.[0] ?? null, pickCount }
}

export async function runBrowserLeagueLifecycleScenario({ season = 0 } = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])

  const runId = process.env.E2E_BROWSER_LEAGUE_RUN_ID ?? new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const password = `Pancake-browser-league-${runId}!`
  const users = [
    {
      email: `pancake-browser-league-${runId}-1@example.com`,
      password,
      username: `pancake_browser_league_${runId}_1`,
      displayName: `Browser League ${runId} #1`,
      teamName: 'Browser Team 1',
    },
    {
      email: `pancake-browser-league-${runId}-2@example.com`,
      password,
      username: `pancake_browser_league_${runId}_2`,
      displayName: `Browser League ${runId} #2`,
      teamName: 'Browser Team 2',
    },
  ]

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const [commissioner, manager] = await Promise.all(users.map((user) => createConfirmedUser(admin, user)))
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = safeName(`pancake-league-lifecycle-${runId}-s${season}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-league-lifecycle')
  await mkdir(artifactDir, { recursive: true })

  try {
    await installRuntimeOverrides(browser, session, env)

    await signIn(session, env, commissioner)
    await browser(session, ['open', joinUrl(env.frontendUrl, '/create-league')])
    await browser(session, ['wait', '1500'])
    await browser(session, ['find', 'placeholder', 'e.g. Hoops Dynasty', 'fill', `Pancake Browser League Lifecycle ${runId}`])
    await browser(session, ['find', 'placeholder', 'e.g. Buckets BC', 'fill', commissioner.teamName])
    await browser(session, ['find', 'placeholder', '200', 'fill', '200'])
    await clickExactText(session, 'Create League', 'create league button')
    const createBody = await waitForBodyText(
      session,
      `(text) => text.includes('League Created!') && /\\b[A-Z0-9]{16}\\b/.test(text)`,
      'create league success',
    )
    const inviteCode = createBody.match(/\b[A-Z0-9]{16}\b/)?.[0]
    if (!inviteCode) throw new Error('D.SET.2 browser create league: invite code not visible')
    await browser(session, ['screenshot', path.join(artifactDir, 'created-league.png')], { timeout: 60_000 })

    const { data: createdLeague, error: createdLeagueError } = await admin
      .from('leagues')
      .select('id')
      .eq('invite_code', inviteCode)
      .single()
    if (createdLeagueError || !createdLeague) {
      throw new Error(`D.SET.2 browser created league lookup: ${createdLeagueError?.message ?? 'missing league'}`)
    }

    await browser(session, ['close']).catch(() => {})
    await installRuntimeOverrides(browser, session, env)
    await signIn(session, env, manager)
    await browser(session, ['open', joinUrl(env.frontendUrl, '/join-league')])
    await browser(session, ['wait', '1500'])
    await browser(session, ['find', 'placeholder', 'XXXXXX', 'fill', inviteCode])
    await browser(session, ['find', 'placeholder', 'e.g. Buckets FC', 'fill', manager.teamName])
    await clickExactText(session, 'Join League', 'join league button')
    await browser(session, ['wait', '3000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'joined-league.png')], { timeout: 60_000 })

    const verification = await verifyLeagueState({
      admin,
      leagueId: createdLeague.id,
      commissionerUserId: commissioner.id,
      managerUserId: manager.id,
      inviteCode,
    })
    if (verification.failures.length > 0) {
      throw new Error(`D.SET.2 browser lifecycle failed: ${verification.failures.join('; ')}`)
    }

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)
    if (normalizeBrowserErrors(errorOutput)) {
      throw new Error(`Browser reported uncaught errors. See ${path.join(artifactDir, 'errors.txt')}`)
    }

    const report = {
      status: 'PASS',
      season,
      runId,
      frontend: describeEndpoint(env.frontendUrl),
      session,
      sessionList,
      leagueId: createdLeague.id,
      inviteCode,
      commissioner: commissioner.email,
      manager: manager.email,
      memberCount: verification.members.length,
      pickCount: verification.pickCount,
      artifactDir,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const report = {
      status: 'FAIL',
      season,
      runId,
      session,
      sessionList,
      error: error instanceof Error ? error.message : String(error),
      artifactDir,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  runBrowserLeagueLifecycleScenario({
    season: seasonArg ? Number(seasonArg.split('=')[1]) : 0,
  }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
