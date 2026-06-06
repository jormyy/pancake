import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { createBrowser, listBrowserSessions } from './browser-agent.mjs'

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

const findAvailablePlayers = async (admin, leagueId, leagueSeasonId, count = 1) => {
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
  if (available.length < count) throw new Error(`D.SEA.2 browser waiver: only ${available.length} available players found; need ${count}`)
  return available.slice(0, count)
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
  const createdUser = await createConfirmedUser(admin, user)

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
  const availablePlayers = await findAvailablePlayers(admin, league.id, currentSeason.id, requiredPlayerCount)
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
  }
}

const signInBrowser = async (session, env, user, password) => {
  await installRuntimeOverrides(browser, session, env, { alerts: true })
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
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupWaiverGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-waiver-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-waiver')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Claimant: ${fixture.user.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, `/claim-player?playerId=${fixture.player.id}`)])
    await browser(session, ['wait', '2500'])
    await assertPageText(session, ['Waiver Claim', 'CLAIMING', fixture.player.display_name, 'No drop required.', 'Submit Claim'], 'waiver claim before submit')
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-before-submit.png')], { timeout: 60_000 })
    const clickResult = await clickButton(session, 'Submit waiver claim', 'waiver submit button')
    const waiverClaim = await waitForWaiverClaim(fixture)
    debug = { ...debug, clickResult, waiverClaim }
    if (waiverClaim.failures.length > 0) {
      throw new Error(`waiver claim did not persist: ${waiverClaim.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-after-submit.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...waiverClaim.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
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
        waiverLogId: fixture.waiverLog.id,
      },
      waiverClaim,
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser waiver scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const waiverClaim = await verifyWaiverClaim(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, waiverClaim, consoleOutput, errorOutput, networkOutput }
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
        waiverLogId: fixture.waiverLog.id,
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

export async function runBrowserWaiverDropScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupWaiverGameplayFixture(env, season, { requiresDrop: true })
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-waiver-drop-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-waiver-drop')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Claimant: ${fixture.user.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
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
    debug = { ...debug, dropClick, submitClick, waiverClaim }
    if (waiverClaim.failures.length > 0) {
      throw new Error(`waiver drop claim did not persist: ${waiverClaim.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-drop-after-submit.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...waiverClaim.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
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
        dropPlayerId: fixture.dropPlayer.id,
        dropRosterPlayerId: fixture.dropRosterPlayer.id,
        waiverLogId: fixture.waiverLog.id,
      },
      waiverClaim,
      notes,
      failures,
    }
    await writeFile(DROP_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser waiver drop scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const waiverClaim = await verifyWaiverClaim(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, waiverClaim, consoleOutput, errorOutput, networkOutput }
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
        dropPlayerId: fixture.dropPlayer.id,
        dropRosterPlayerId: fixture.dropRosterPlayer.id,
        waiverLogId: fixture.waiverLog.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(DROP_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
  }
}

export async function runBrowserWaiverIrBlockScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupWaiverGameplayFixture(env, season, { hasIneligibleIR: true })
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-waiver-ir-block-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-waiver-ir-block')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Claimant: ${fixture.user.email}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, `/claim-player?playerId=${fixture.player.id}`)])
    await browser(session, ['wait', '2500'])
    await assertPageText(
      session,
      ['Waiver Claim', 'Resolve IR Status First', fixture.irPlayer.display_name, 'DTD', 'Go to Roster'],
      'waiver IR block before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'waiver-ir-block.png')], { timeout: 60_000 })
    const noClaim = await verifyNoWaiverClaim(fixture)
    debug = { ...debug, noClaim }
    if (noClaim.failures.length > 0) {
      throw new Error(`waiver IR block allowed a claim: ${noClaim.failures.join('; ')}`)
    }

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...noClaim.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
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
        irPlayerId: fixture.irPlayer.id,
        irRosterPlayerId: fixture.irRosterPlayer.id,
        waiverLogId: fixture.waiverLog.id,
      },
      noClaim,
      notes,
      failures,
    }
    await writeFile(IR_BLOCK_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser waiver IR block scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const noClaim = await verifyNoWaiverClaim(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, noClaim, consoleOutput, errorOutput, networkOutput }
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
        irPlayerId: fixture.irPlayer.id,
        irRosterPlayerId: fixture.irRosterPlayer.id,
        waiverLogId: fixture.waiverLog.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(IR_BLOCK_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  const runner = process.argv.includes('--ir-block')
    ? runBrowserWaiverIrBlockScenario
    : process.argv.includes('--drop')
    ? runBrowserWaiverDropScenario
    : runBrowserWaiverScenario
  runner({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
