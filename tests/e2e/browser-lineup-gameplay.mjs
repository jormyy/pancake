import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-lineup-report.md')

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
const todayDateString = () => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const listSessions = async () => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['session', 'list'], {
    cwd: ROOT,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
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

const findPgPlayer = async (admin, leagueId, leagueSeasonId) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin
      .from('roster_players')
      .select('player_id')
      .eq('league_id', leagueId)
      .eq('league_season_id', leagueSeasonId),
    admin
      .from('players')
      .select('id, display_name, position, eligible_positions, nba_team')
      .order('display_name', { ascending: true })
      .limit(400),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const player = (players ?? []).find((row) => {
    const eligible = Array.isArray(row.eligible_positions) ? row.eligible_positions : []
    return row.display_name && !rosteredIds.has(row.id) && (row.position === 'PG' || eligible.includes('PG'))
  })
  if (!player) throw new Error('D.SEA.2 browser lineup: no available PG-eligible player found')
  return player
}

const ensureCurrentWeek = async (admin, seasonYear) => {
  const today = todayDateString()
  const { data: existing, error: existingError } = await admin
    .from('season_weeks')
    .select('week_number, week_start, week_end')
    .eq('season_year', seasonYear)
    .lte('week_start', today)
    .gte('week_end', today)
    .maybeSingle()
  if (existingError) throw new Error(`season week lookup: ${existingError.message}`)
  if (existing) return existing

  const { data, error } = await admin
    .from('season_weeks')
    .insert({
      season_year: seasonYear,
      week_number: 99,
      week_start: today,
      week_end: today,
    })
    .select('week_number, week_start, week_end')
    .single()
  if (error) throw new Error(`season week insert: ${error.message}`)
  return data
}

const setupLineupFixture = async (env, season) => {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}`
  const password = `Pancake-lineup-${runId}!`
  const user = {
    email: `pancake-lineup-${runId}@example.com`,
    password,
    username: `pancake_lineup_${runId}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Lineup ${runId}`,
    teamName: 'Lineup Gameplay Team',
  }

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const createdUser = await createConfirmedUser(admin, user)
  const { error: profileError } = await admin.from('profiles').upsert({
    id: createdUser.id,
    username: createdUser.username,
    display_name: createdUser.displayName,
  }, { onConflict: 'id' })
  if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

  const commissioner = await signInClient(env, createdUser.email, password)
  const { data: league, error: createError } = await commissioner.rpc('create_league', {
    p_name: `Pancake Browser Lineup ${runId}`,
    p_team_name: createdUser.teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)

  const { data: currentSeason, error: seasonError } = await admin
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', league.id)
    .eq('is_current', true)
    .single()
  if (seasonError) throw new Error(`current season lookup: ${seasonError.message}`)

  const { data: member, error: memberError } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', league.id)
    .eq('user_id', createdUser.id)
    .single()
  if (memberError || !member) throw new Error(`league member lookup: ${memberError?.message ?? 'missing row'}`)

  const week = await ensureCurrentWeek(admin, currentSeason.season_year)
  const player = await findPgPlayer(admin, league.id, currentSeason.id)
  const { data: rosterRow, error: rosterError } = await admin
    .from('roster_players')
    .insert({
      league_id: league.id,
      league_season_id: currentSeason.id,
      member_id: member.id,
      player_id: player.id,
      acquired_via: 'e2e_lineup_fixture',
    })
    .select('id, player_id')
    .single()
  if (rosterError) throw new Error(`roster seed: ${rosterError.message}`)

  return {
    admin,
    runId,
    password,
    user: createdUser,
    league,
    currentSeason,
    member,
    week,
    player,
    rosterRow,
  }
}

const signInBrowser = async (session, env, user, password) => {
  await browser(session, ['open', env.frontendUrl])
  await browser(session, [
    'eval',
    `(() => {
      window.localStorage.setItem('PANCAKE_API_URL', ${JSON.stringify(env.apiBaseUrl)});
      window.__pancakeAlerts = [];
      window.alert = (message) => window.__pancakeAlerts.push(String(message));
      return JSON.stringify({ ok: true });
    })()`,
  ])
  await browser(session, ['wait', '1500'])
  await browser(session, ['find', 'placeholder', 'Email', 'fill', user.email])
  await browser(session, ['find', 'placeholder', 'Password', 'fill', password])
  await browser(session, ['find', 'text', 'Sign In', 'click'])
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

const clickButton = async (session, name, label) => {
  try {
    await browser(session, ['find', 'role', 'button', 'click', '--name', name])
    return { ok: true, method: 'agent-browser-find-role-button' }
  } catch {
    const output = await browser(session, [
      'eval',
      `(() => {
        const target = [...document.querySelectorAll('[role="button"], button, [tabindex]')]
          .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)}
            || (element.textContent || '').trim() === ${JSON.stringify(name)});
        if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1000) });
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        target.click();
        return JSON.stringify({
          ok: true,
          tagName: target.tagName,
          role: target.getAttribute('role'),
          label: target.getAttribute('aria-label'),
          text: target.textContent,
        });
      })()`,
    ])
    const parsed = parseEvalJson(output)
    if (!parsed.ok) throw new Error(`${label}: button not found: ${name}. Body: ${parsed.body}`)
    return parsed
  }
}

const verifyLineup = async (fixture, { expectedAutoSet = false } = {}) => {
  const { data: rows, error } = await fixture.admin
    .from('weekly_lineups')
    .select('id, member_id, player_id, slot_type, week_number, game_date, is_auto_set')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.member.id)
    .eq('player_id', fixture.player.id)
    .eq('game_date', todayDateString())
  if (error) throw new Error(`lineup verify: ${error.message}`)

  const failures = []
  if ((rows ?? []).length !== 1) failures.push(`weekly_lineups rows=${(rows ?? []).length}; expected 1`)
  const lineup = rows?.[0] ?? null
  if (lineup?.slot_type !== 'PG') failures.push(`slot_type=${lineup?.slot_type ?? '<missing>'}; expected PG`)
  if (lineup?.is_auto_set !== expectedAutoSet) failures.push(`is_auto_set=${lineup?.is_auto_set}; expected ${expectedAutoSet}`)
  return { lineup, failures }
}

const waitForLineup = async (fixture, options = {}, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyLineup(fixture, options)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyLineup(fixture, options)
  }
  return last
}

export async function runBrowserLineupScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupLineupFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-lineup-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-lineup')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Manager: ${fixture.user.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, '/lineup')])
    await browser(session, ['wait', '3000'])
    await assertPageText(session, ['Lineup', 'STARTERS', 'BENCH', fixture.player.display_name], 'lineup before move')
    await browser(session, ['screenshot', path.join(artifactDir, 'lineup-before-move.png')], { timeout: 60_000 })
    const benchClick = await clickButton(session, `Bench ${fixture.player.display_name}`, 'bench player row')
    const slotClick = await clickButton(session, 'Empty PG slot', 'empty PG slot row')
    const lineupCheck = await waitForLineup(fixture, { expectedAutoSet: false })
    debug = { ...debug, benchClick, slotClick, lineupCheck }
    if (lineupCheck.failures.length > 0) {
      throw new Error(`lineup did not persist: ${lineupCheck.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'lineup-after-move.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...lineupCheck.failures]
    if (errorOutput.trim()) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        memberId: fixture.member.id,
        playerId: fixture.player.id,
        rosterPlayerId: fixture.rosterRow.id,
        weekNumber: fixture.week.week_number,
      },
      lineupCheck,
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser lineup scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const lineupCheck = await verifyLineup(fixture, { expectedAutoSet: false }).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, lineupCheck, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        memberId: fixture.member.id,
        playerId: fixture.player.id,
        rosterPlayerId: fixture.rosterRow.id,
        weekNumber: fixture.week.week_number,
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

export async function runBrowserLineupAutoSetScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupLineupFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-lineup-auto-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-lineup-auto-set')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Manager: ${fixture.user.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, '/lineup')])
    await browser(session, ['wait', '3000'])
    await assertPageText(session, ['Lineup', 'STARTERS', 'BENCH', fixture.player.display_name, 'Auto-Set'], 'lineup before auto-set')
    await browser(session, ['screenshot', path.join(artifactDir, 'lineup-auto-before.png')], { timeout: 60_000 })
    const openClick = await clickButton(session, 'Open auto-set lineup options', 'auto-set button')
    await assertPageText(session, ['Auto-Set Lineup', 'Today', 'Whole Week', 'Rest of Season'], 'auto-set modal')
    const todayClick = await clickButton(session, 'Auto-set today', 'auto-set today button')
    const lineupCheck = await waitForLineup(fixture, { expectedAutoSet: true })
    debug = { ...debug, openClick, todayClick, lineupCheck }
    if (lineupCheck.failures.length > 0) {
      throw new Error(`auto-set lineup did not persist: ${lineupCheck.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'lineup-auto-after.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...lineupCheck.failures]
    if (errorOutput.trim()) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      mode: 'auto-set',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        memberId: fixture.member.id,
        playerId: fixture.player.id,
        rosterPlayerId: fixture.rosterRow.id,
        weekNumber: fixture.week.week_number,
      },
      lineupCheck,
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser lineup auto-set scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const lineupCheck = await verifyLineup(fixture, { expectedAutoSet: true }).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, lineupCheck, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      mode: 'auto-set',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        memberId: fixture.member.id,
        playerId: fixture.player.id,
        rosterPlayerId: fixture.rosterRow.id,
        weekNumber: fixture.week.week_number,
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
  const runner = process.argv.includes('--auto-set')
    ? runBrowserLineupAutoSetScenario
    : runBrowserLineupScenario
  runner({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
