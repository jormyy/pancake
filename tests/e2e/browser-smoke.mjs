import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, describeEndpoint } from './env.mjs'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const STATE_PATH = path.join(ROOT, 'tests/e2e-state.json')
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-report.md')

const readState = async () => JSON.parse(await readFile(STATE_PATH, 'utf8'))

const listSessions = async () => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['session', 'list'], {
    cwd: ROOT,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const browser = async (session, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd: ROOT,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 4,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')

const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

const encodeQuery = (pathname, params) => {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') search.set(key, value)
  }
  const query = search.toString()
  return query ? `${pathname}?${query}` : pathname
}

const fetchSweepContext = async (env, state, user) => {
  if (!env.serviceRoleKey || !state.leagueId) {
    return { routes: [], notes: ['Full sweep skipped DB-param routes: missing service role key or seeded league id.'] }
  }

  const supabase = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const notes = []
  const { data: members, error: membersError } = await supabase
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', state.leagueId)
    .order('joined_at', { ascending: true })
  if (membersError) throw new Error(`UI sweep league_members lookup: ${membersError.message}`)

  const myMember = members?.find((member) => member.user_id === user.id) ?? members?.[0]
  const otherMember = members?.find((member) => member.id !== myMember?.id) ?? members?.[0]

  const { data: rosterRow } = myMember
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
  const playerId = rosterRow?.player_id ?? firstPlayer?.id ?? null

  const { data: auctionDraft } = await supabase
    .from('drafts')
    .select('id')
    .eq('league_id', state.leagueId)
    .eq('draft_type', 'auction')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: rookieDraft } = await supabase
    .from('drafts')
    .select('id')
    .eq('league_id', state.leagueId)
    .eq('draft_type', 'rookie')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const routes = [
    ['create-league', '/create-league'],
    ['join-league', '/join-league'],
    ['commissioner-settings', '/commissioner-settings'],
    ['lineup', '/lineup'],
    ['bracket', '/bracket'],
  ]
  if (playerId) {
    routes.push(['claim-player', encodeQuery('/claim-player', { playerId })])
    routes.push(['player-detail', `/player/${playerId}`])
  } else {
    notes.push('Full sweep skipped player detail and claim-player: no player id found.')
  }
  if (otherMember) {
    routes.push(['propose-trade', encodeQuery('/propose-trade', { recipientMemberId: otherMember.id })])
    routes.push(['team-roster', encodeQuery('/team-roster', {
      memberId: otherMember.id,
      teamName: otherMember.team_name ?? 'Team',
    })])
  } else {
    notes.push('Full sweep skipped propose-trade/team-roster: no league member found.')
  }
  if (auctionDraft?.id) {
    routes.push(['draft-room', encodeQuery('/draft-room', { draftId: auctionDraft.id })])
  } else {
    notes.push('Full sweep skipped draft-room: no auction draft found.')
  }
  if (rookieDraft?.id) {
    routes.push(['rookie-draft-room', encodeQuery('/rookie-draft-room', { draftId: rookieDraft.id })])
  } else {
    notes.push('Full sweep skipped rookie-draft-room: no rookie draft found.')
  }

  return { routes, notes }
}

export async function runBrowserSmoke({
  season = 0,
  scenario = 'smoke',
  userIndex = 0,
  sessionName,
  fullSweep = process.env.E2E_BROWSER_FULL_SWEEP === '1',
} = {}) {
  const env = resolvedEnv()
  const state = await readState()
  const user = state.users[userIndex]
  if (!user) throw new Error(`No seeded user at index ${userIndex}`)
  if (!state.password) throw new Error('tests/e2e-state.json is missing the seeded user password')

  const session = sessionName ?? safeName(`pancake-soak-${state.runId}-s${season}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, scenario)
  await mkdir(artifactDir, { recursive: true })
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)

  const visited = []
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `User: ${user.email}`,
    fullSweep ? 'Full route sweep enabled.' : 'Tab smoke only.',
    sessionList,
  ]

  try {
    if (fullSweep) {
      const authRoutes = [
        ['auth-sign-in', '/sign-in'],
        ['auth-sign-up', '/sign-up'],
      ]
      for (const [label, route] of authRoutes) {
        await browser(session, ['open', joinUrl(env.frontendUrl, route)])
        await browser(session, ['wait', '1500'])
        await browser(session, ['screenshot', path.join(artifactDir, `${label}.png`)], { timeout: 60_000 })
        visited.push(label)
      }
    }

    await browser(session, ['open', env.frontendUrl])
    await browser(session, ['wait', '1500'])
    await browser(session, ['find', 'placeholder', 'Email', 'fill', user.email])
    await browser(session, ['find', 'placeholder', 'Password', 'fill', state.password])
    await browser(session, ['find', 'text', 'Sign In', 'click'])
    await browser(session, ['wait', '4000'])

    const routes = [
      ['home', '/'],
      ['players', '/players'],
      ['roster', '/roster'],
      ['trades', '/trades'],
      ['league', '/league'],
    ]

    if (fullSweep) {
      const sweep = await fetchSweepContext(env, state, user)
      routes.push(...sweep.routes)
      notes.push(...sweep.notes)
    }

    for (const [label, route] of routes) {
      await browser(session, ['open', joinUrl(env.frontendUrl, route)])
      await browser(session, ['wait', '1500'])
      await browser(session, ['screenshot', path.join(artifactDir, `${label}.png`)], { timeout: 60_000 })
      visited.push(label)
    }

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)

    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)
    if (errorOutput.trim()) {
      throw new Error(`Browser reported uncaught errors. See ${path.join(artifactDir, 'errors.txt')}`)
    }

    const report = {
      status: 'PASS',
      season,
      scenario,
      session,
      user: user.email,
      visited,
      artifactDir,
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    return report
  } catch (error) {
    const report = {
      status: 'FAIL',
      season,
      scenario,
      session,
      user: user.email,
      visited,
      artifactDir,
      error: error instanceof Error ? error.message : String(error),
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  runBrowserSmoke({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
