import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides } from './browser-runtime-overrides.mjs'
import { captureBrowserScreenshot, clickButtonByName, createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'
import { createFixtureResourceOwner } from './trade-fixture.mjs'
import { runBrowserScenarioLifecycle } from './browser-scenario-lifecycle.mjs'

const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-lineup-report.md')

const browser = createBrowser({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
const todayDateString = () => {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}
const offsetDateString = (offsetDays) => {
  const today = todayDateString()
  const [year, month, day] = today.split('-').map(Number)
  const d = new Date(Date.UTC(year, month - 1, day + offsetDays, 12, 0, 0))
  return d.toISOString().slice(0, 10)
}
const weekWindowForDate = (date) => {
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  const dow = start.getUTCDay()
  start.setUTCDate(start.getUTCDate() + (dow === 0 ? -6 : 1 - dow))
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 6)
  return {
    week_start: start.toISOString().slice(0, 10),
    week_end: end.toISOString().slice(0, 10),
  }
}

const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

const listSessions = () => listBrowserSessions({ cwd: ROOT })

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
  const today = todayDateString()
  const [
    { data: rosterRows, error: rosterError },
    { data: players, error: playersError },
    { data: startedGames, error: gamesError },
  ] = await Promise.all([
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
    admin
      .from('nba_games')
      .select('home_team, away_team, status, game_time')
      .eq('game_date', today)
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  if (gamesError) throw new Error(`started game lookup: ${gamesError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const now = new Date().toISOString()
  const startedTeams = new Set(
    (startedGames ?? [])
      .filter((game) =>
        ['InProgress', 'Final'].includes(game.status ?? '') ||
        (game.game_time != null && game.game_time <= now))
      .flatMap((game) => [game.home_team, game.away_team])
      .filter(Boolean),
  )
  const eligiblePlayers = (players ?? []).filter((row) => {
    const eligible = Array.isArray(row.eligible_positions) ? row.eligible_positions : []
    return row.display_name && !rosteredIds.has(row.id) && (row.position === 'PG' || eligible.includes('PG'))
  })
  const player = eligiblePlayers.find((row) => !row.nba_team || !startedTeams.has(row.nba_team)) ?? eligiblePlayers[0]
  if (!player) throw new Error('D.SEA.2 browser lineup: no available PG-eligible player found')
  return player
}

const findPgPlayersWithNbaTeams = async (admin, leagueId, leagueSeasonId, count) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin
      .from('roster_players')
      .select('player_id')
      .eq('league_id', leagueId)
      .eq('league_season_id', leagueSeasonId),
    admin
      .from('players')
      .select('id, display_name, position, eligible_positions, nba_team')
      .not('nba_team', 'is', null)
      .order('display_name', { ascending: true })
      .limit(600),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const selected = (players ?? []).filter((row) => {
    const eligible = Array.isArray(row.eligible_positions) ? row.eligible_positions : []
    return row.display_name && row.nba_team && !rosteredIds.has(row.id) && (row.position === 'PG' || eligible.includes('PG'))
  }).slice(0, count)
  if (selected.length < count) {
    throw new Error(`D.SEA.2 browser lineup locked: found ${selected.length} PG-eligible NBA-team players; expected ${count}`)
  }
  return selected
}

const ensureWeekForDate = async (admin, seasonYear, date) => {
  const { data: existing, error: existingError } = await admin
    .from('season_weeks')
    .select('week_number, week_start, week_end')
    .eq('season_year', seasonYear)
    .lte('week_start', date)
    .gte('week_end', date)
    .maybeSingle()
  if (existingError) throw new Error(`season week lookup: ${existingError.message}`)
  if (existing) return existing

  const { data: latest, error: latestError } = await admin
    .from('season_weeks')
    .select('week_number')
    .eq('season_year', seasonYear)
    .order('week_number', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestError) throw new Error(`latest season week lookup: ${latestError.message}`)

  const { data, error } = await admin
    .from('season_weeks')
    .upsert({
      season_year: seasonYear,
      week_number: (latest?.week_number ?? 0) + 1,
      ...weekWindowForDate(date),
    }, { onConflict: 'season_year,week_number' })
    .select('week_number, week_start, week_end')
    .single()
  if (error) throw new Error(`season week upsert: ${error.message}`)
  return data
}

const ensureCurrentWeek = (admin, seasonYear) => ensureWeekForDate(admin, seasonYear, todayDateString())

const setupLineupFixture = async (env, season, { remainingSeasonDateCount = 0 } = {}) => {
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
    p_name: `Pancake Browser Lineup ${runId}`,
    p_team_name: createdUser.teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)
  resources.registerLeague(league.id)

  const { data: currentSeason, error: seasonError } = await admin
    .from('league_seasons')
    .select('id, season_year')
    .eq('league_id', league.id)
    .eq('is_current', true)
    .single()
  if (seasonError) throw new Error(`current season lookup: ${seasonError.message}`)
  const fixtureSeasonYear = 8000 + Number(runId.replace(/\D/g, '').slice(-6))
  const { data: syntheticSeason, error: seasonUpdateError } = await admin
    .from('league_seasons')
    .update({ season_year: fixtureSeasonYear })
    .eq('id', currentSeason.id)
    .select('id, season_year')
    .single()
  if (seasonUpdateError) throw new Error(`lineup fixture season-year update: ${seasonUpdateError.message}`)

  const { data: member, error: memberError } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', league.id)
    .eq('user_id', createdUser.id)
    .single()
  if (memberError || !member) throw new Error(`league member lookup: ${memberError?.message ?? 'missing row'}`)

  const week = await ensureCurrentWeek(admin, syntheticSeason.season_year)
  const player = await findPgPlayer(admin, league.id, syntheticSeason.id)
  const { data: rosterRow, error: rosterError } = await admin
    .from('roster_players')
    .insert({
      league_id: league.id,
      league_season_id: syntheticSeason.id,
      member_id: member.id,
      player_id: player.id,
      acquired_via: 'e2e_lineup_fixture',
    })
    .select('id, player_id')
    .single()
  if (rosterError) throw new Error(`roster seed: ${rosterError.message}`)

  const { error: statusError } = await admin
    .from('leagues')
    .update({ status: 'active' })
    .eq('id', league.id)
  if (statusError) throw new Error(`lineup fixture status flip: ${statusError.message}`)

  resources.registerCleanup(`lineup season week ${syntheticSeason.season_year}`, async () => {
    const { error } = await admin.from('season_weeks').delete().eq('season_year', syntheticSeason.season_year)
    if (error) throw new Error(error.message)
  })

  const remainingSeasonDates = []
  const remainingSeasonGameIds = []
  for (let offset = 1; offset <= remainingSeasonDateCount; offset += 1) {
    const gameDate = offsetDateString(offset)
    const dateWeek = await ensureWeekForDate(admin, syntheticSeason.season_year, gameDate)
    const gameId = `e2e-lineup-season-${runId}-${offset}`
    const homeTeam = player.nba_team ?? 'BOS'
    const awayTeam = homeTeam === 'LAL' ? 'BOS' : 'LAL'
    const { error: gameError } = await admin.from('nba_games').insert({
      sportsdata_game_id: gameId,
      nba_game_id: gameId,
      season_year: syntheticSeason.season_year,
      game_date: gameDate,
      week_number: dateWeek.week_number,
      home_team: homeTeam,
      away_team: awayTeam,
      status: 'Scheduled',
      game_status_text: 'E2E Future Game',
      game_time: `${gameDate}T23:30:00.000Z`,
    })
    if (gameError) throw new Error(`remaining-season game seed: ${gameError.message}`)
    remainingSeasonDates.push(gameDate)
    remainingSeasonGameIds.push(gameId)
  }
  if (remainingSeasonGameIds.length > 0) {
    resources.registerCleanup(`lineup season games ${syntheticSeason.season_year}`, async () => {
      const { error } = await admin.from('nba_games').delete().in('sportsdata_game_id', remainingSeasonGameIds)
      if (error) throw new Error(error.message)
    })
  }
  return {
    admin,
    runId,
    password,
    user: createdUser,
    league,
    currentSeason: syntheticSeason,
    member,
    week,
    player,
    rosterRow,
    remainingSeasonDates,
    dispose: resources.dispose,
  }
}

const setupLockedLineupFixture = async (env, season) => {
  const fixture = await setupLineupFixture(env, season)
  const [lockedPlayer, benchPlayer] = await findPgPlayersWithNbaTeams(
    fixture.admin,
    fixture.league.id,
    fixture.currentSeason.id,
    2,
  )

  const { data: rosterRows, error: rosterError } = await fixture.admin
    .from('roster_players')
    .insert([
      {
        league_id: fixture.league.id,
        league_season_id: fixture.currentSeason.id,
        member_id: fixture.member.id,
        player_id: lockedPlayer.id,
        acquired_via: 'e2e_lineup_locked_fixture',
      },
      {
        league_id: fixture.league.id,
        league_season_id: fixture.currentSeason.id,
        member_id: fixture.member.id,
        player_id: benchPlayer.id,
        acquired_via: 'e2e_lineup_locked_fixture',
      },
    ])
    .select('id, player_id')
  if (rosterError) throw new Error(`locked roster seed: ${rosterError.message}`)

  const today = todayDateString()
  const opponent = benchPlayer.nba_team && benchPlayer.nba_team !== lockedPlayer.nba_team
    ? benchPlayer.nba_team
    : lockedPlayer.nba_team === 'BOS' ? 'LAL' : 'BOS'
  const gameId = `e2e-lineup-lock-${fixture.runId}`
  const scheduledTipoff = new Date(Date.now() - 60_000).toISOString()
  const { error: gameError } = await fixture.admin.from('nba_games').insert({
    sportsdata_game_id: gameId,
    nba_game_id: gameId,
    season_year: fixture.currentSeason.season_year,
    game_date: today,
    week_number: fixture.week.week_number,
    home_team: lockedPlayer.nba_team,
    away_team: opponent,
    status: 'Scheduled',
    game_status_text: 'E2E Scheduled Past Tipoff',
    game_time: scheduledTipoff,
  })
  if (gameError) throw new Error(`locked game seed: ${gameError.message}`)

  const { data: lineup, error: lineupError } = await fixture.admin
    .from('weekly_lineups')
    .insert({
      member_id: fixture.member.id,
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      player_id: lockedPlayer.id,
      week_number: fixture.week.week_number,
      game_date: today,
      slot_type: 'PG',
      is_auto_set: false,
      set_at: new Date().toISOString(),
    })
    .select('id, player_id, slot_type')
    .single()
  if (lineupError) throw new Error(`locked lineup seed: ${lineupError.message}`)

  return {
    ...fixture,
    lockedPlayer,
    benchPlayer,
    scheduledTipoff,
    lockedRosterRow: (rosterRows ?? []).find((row) => row.player_id === lockedPlayer.id),
    benchRosterRow: (rosterRows ?? []).find((row) => row.player_id === benchPlayer.id),
    lockedLineup: lineup,
  }
}

const resetBrowserAlertCapture = (session) => browser(session, [
  'eval',
  `(() => {
    window.__pancakeAlerts = [];
    window.alert = (message) => window.__pancakeAlerts.push(String(message));
    return JSON.stringify({ ok: true });
  })()`,
])

const signInBrowser = async (session, env, user, password) => {
  await installRuntimeOverrides(browser, session, env, { alerts: true })
  await browser(session, ['wait', '1500'])
  await fillSignInCredentials(browser, session, user.email, password)
  await clickButtonByName(browser, session, 'Sign In')
  await browser(session, ['wait', '4000'])
  await resetBrowserAlertCapture(session)
}

const assertPageText = async (session, required, label) => {
  let parsed = null
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
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
    parsed = parseEvalJson(output)
    if (parsed.ok) return parsed
    await browser(session, ['wait', '500'])
  }
  throw new Error(`${label} missing page text: ${parsed?.missing?.join(', ') ?? required.join(', ')}. Sample: ${parsed?.sample ?? ''}`)
}

const waitForAccessibleButton = async (session, name, label, timeoutMs = 15_000) => {
  let parsed = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const output = await browser(session, [
      'eval',
      `(() => {
        const target = [...document.querySelectorAll('[role="button"], button')]
          .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)});
        return JSON.stringify({
          ok: Boolean(target),
          label: target?.getAttribute('aria-label') ?? null,
          body: (document.body?.innerText || '').slice(0, 1000)
        });
      })()`,
    ])
    parsed = parseEvalJson(output)
    if (parsed.ok) return { ...parsed, elapsedMs: Date.now() - startedAt }
    await browser(session, ['wait', '250'])
  }
  throw new Error(`${label}: button not found: ${name}. Body: ${parsed?.body ?? ''}`)
}

const waitForAlertText = async (session, expected, label, timeoutMs = 90_000) => {
  let parsed = null
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const output = await browser(session, [
      'eval',
      `(() => {
        const alerts = Array.isArray(window.__pancakeAlerts) ? window.__pancakeAlerts : [];
        return JSON.stringify({
          ok: alerts.some((message) => message.includes(${JSON.stringify(expected)})),
          alerts
        });
      })()`,
    ])
    parsed = parseEvalJson(output)
    if (parsed.ok) return { ...parsed, elapsedMs: Date.now() - startedAt }
    const failureAlert = parsed.alerts.find((message) => message.includes('Auto-set failed'))
    if (failureAlert) throw new Error(`${label}: ${failureAlert}`)
    await browser(session, ['wait', '500'])
  }
  throw new Error(`${label}: alert not found: ${expected}. Alerts: ${JSON.stringify(parsed?.alerts ?? [])}`)
}

const dispatchDomClick = async (session, name, label) => {
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
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.click();
      return JSON.stringify({
        ok: true,
        method: 'dom-dispatch',
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

const clickButton = async (session, name, label, { preferDom = false } = {}) => {
  if (preferDom) return dispatchDomClick(session, name, label)
  try {
    await browser(session, ['find', 'role', 'button', 'click', '--name', name])
    return { ok: true, method: 'agent-browser-find-role-button' }
  } catch {
    return dispatchDomClick(session, name, label)
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

const waitForLineup = async (fixture, options = {}, timeoutMs = 90_000) => {
  const startedAt = Date.now()
  let last = await verifyLineup(fixture, options)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyLineup(fixture, options)
  }
  return last
}

const verifyRemainingSeasonLineups = async (fixture) => {
  const { data: rows, error } = await fixture.admin
    .from('weekly_lineups')
    .select('id, player_id, slot_type, week_number, game_date, is_auto_set')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.member.id)
    .eq('player_id', fixture.player.id)
    .in('game_date', fixture.remainingSeasonDates)
    .order('game_date', { ascending: true })
  if (error) throw new Error(`remaining-season lineup verify: ${error.message}`)

  const failures = []
  const rowsByDate = new Map((rows ?? []).map((row) => [row.game_date, row]))
  for (const date of fixture.remainingSeasonDates) {
    const row = rowsByDate.get(date)
    if (!row) {
      failures.push(`missing remaining-season lineup for ${date}`)
      continue
    }
    if (!['PG', 'G', 'UTIL'].includes(row.slot_type)) {
      failures.push(`${date} slot_type=${row.slot_type}; expected a PG-eligible starter slot`)
    }
    if (row.is_auto_set !== true) failures.push(`${date} is_auto_set=${row.is_auto_set}; expected true`)
  }
  if ((rows ?? []).length !== fixture.remainingSeasonDates.length) {
    failures.push(`remaining-season rows=${(rows ?? []).length}; expected ${fixture.remainingSeasonDates.length}`)
  }
  return { rows: rows ?? [], failures }
}

const waitForRemainingSeasonLineups = async (fixture, timeoutMs = 90_000) => {
  const startedAt = Date.now()
  let last = await verifyRemainingSeasonLineups(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyRemainingSeasonLineups(fixture)
  }
  return last
}

const verifyLockedLineup = async (fixture) => {
  const [{ data: lockedRows, error: lockedError }, { data: benchRows, error: benchError }] = await Promise.all([
    fixture.admin
      .from('weekly_lineups')
      .select('id, player_id, slot_type, game_date')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', fixture.member.id)
      .eq('player_id', fixture.lockedPlayer.id)
      .eq('game_date', todayDateString()),
    fixture.admin
      .from('weekly_lineups')
      .select('id, player_id, slot_type, game_date')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', fixture.member.id)
      .eq('player_id', fixture.benchPlayer.id)
      .eq('game_date', todayDateString()),
  ])
  if (lockedError) throw new Error(`locked lineup verify: ${lockedError.message}`)
  if (benchError) throw new Error(`bench lineup verify: ${benchError.message}`)

  const failures = []
  if ((lockedRows ?? []).length !== 1) failures.push(`locked player weekly_lineups rows=${(lockedRows ?? []).length}; expected 1`)
  if (lockedRows?.[0]?.slot_type !== 'PG') failures.push(`locked slot_type=${lockedRows?.[0]?.slot_type ?? '<missing>'}; expected PG`)
  if ((benchRows ?? []).length !== 0) failures.push(`bench player weekly_lineups rows=${(benchRows ?? []).length}; expected 0`)
  return { lockedLineup: lockedRows?.[0] ?? null, benchRows: benchRows ?? [], failures }
}

const verifyForgedLockedLineupRpc = async (env, fixture) => {
  const client = await signInClient(env, fixture.user.email, fixture.password)
  try {
    const { error } = await client.rpc('set_player_slot_atomic', {
      p_member_id: fixture.member.id,
      p_league_id: fixture.league.id,
      p_league_season_id: fixture.currentSeason.id,
      p_player_id: fixture.lockedPlayer.id,
      p_game_date: todayDateString(),
      p_slot_type: 'BE',
      p_week_number: fixture.week.week_number,
    })
    const check = await verifyLockedLineup(fixture)
    const failures = [...check.failures]
    if (!error) {
      failures.push('forged set_player_slot_atomic call succeeded; expected locked-lineup rejection')
    } else if (!/locked|started/i.test(error.message)) {
      failures.push(`forged set_player_slot_atomic rejected with "${error.message}"; expected lock/start message`)
    }
    return {
      rejected: Boolean(error),
      errorMessage: error?.message ?? null,
      check,
      failures,
    }
  } finally {
    await client.auth.signOut().catch(() => {})
  }
}

const verifyForgedLineupLegalityRpc = async (env, fixture) => {
  const client = await signInClient(env, fixture.user.email, fixture.password)
  const gameDate = offsetDateString(1)
  try {
    const week = await ensureWeekForDate(fixture.admin, fixture.currentSeason.season_year, gameDate)
    const legal = await client.rpc('set_player_slot_atomic', {
      p_member_id: fixture.member.id,
      p_league_id: fixture.league.id,
      p_league_season_id: fixture.currentSeason.id,
      p_player_id: fixture.lockedPlayer.id,
      p_game_date: gameDate,
      p_slot_type: 'PG',
      p_week_number: week.week_number,
    })
    const overfill = await client.rpc('set_player_slot_atomic', {
      p_member_id: fixture.member.id,
      p_league_id: fixture.league.id,
      p_league_season_id: fixture.currentSeason.id,
      p_player_id: fixture.benchPlayer.id,
      p_game_date: gameDate,
      p_slot_type: 'PG',
      p_week_number: week.week_number,
    })
    const ineligible = await client.rpc('set_player_slot_atomic', {
      p_member_id: fixture.member.id,
      p_league_id: fixture.league.id,
      p_league_season_id: fixture.currentSeason.id,
      p_player_id: fixture.lockedPlayer.id,
      p_game_date: gameDate,
      p_slot_type: 'C',
      p_week_number: week.week_number,
    })
    const { data: rows, error: rowsError } = await fixture.admin
      .from('weekly_lineups')
      .select('id, player_id, slot_type, game_date')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', fixture.member.id)
      .eq('game_date', gameDate)

    const failures = []
    if (legal.error) failures.push(`legal PG starter RPC rejected unexpectedly: ${legal.error.message}`)
    if (!overfill.error) {
      failures.push('forged overfilled PG slot RPC succeeded; expected slot-capacity rejection')
    } else if (!/full|slot/i.test(overfill.error.message)) {
      failures.push(`forged overfilled PG slot rejected with "${overfill.error.message}"; expected slot-capacity message`)
    }
    if (!ineligible.error) {
      failures.push('forged ineligible C slot RPC succeeded; expected eligibility rejection')
    } else if (!/eligible/i.test(ineligible.error.message)) {
      failures.push(`forged ineligible C slot rejected with "${ineligible.error.message}"; expected eligibility message`)
    }
    if (rowsError) failures.push(`lineup legality row check failed: ${rowsError.message}`)
    const pgRows = (rows ?? []).filter((row) => row.slot_type === 'PG')
    const cRows = (rows ?? []).filter((row) => row.slot_type === 'C')
    if (pgRows.length !== 1) failures.push(`future PG lineup rows=${pgRows.length}; expected 1`)
    if (cRows.length !== 0) failures.push(`future C lineup rows=${cRows.length}; expected 0`)

    return {
      gameDate,
      legalStarterAccepted: !legal.error,
      overfillRejected: Boolean(overfill.error),
      overfillErrorMessage: overfill.error?.message ?? null,
      ineligibleRejected: Boolean(ineligible.error),
      ineligibleErrorMessage: ineligible.error?.message ?? null,
      rows: rows ?? [],
      failures,
    }
  } finally {
    await client.auth.signOut().catch(() => {})
  }
}

const verifyForgedLockedAutoSetRpc = async (env, fixture) => {
  const client = await signInClient(env, fixture.user.email, fixture.password)
  try {
    const { error } = await client.rpc('auto_set_lineup_atomic', {
      p_member_id: fixture.member.id,
      p_league_id: fixture.league.id,
      p_league_season_id: fixture.currentSeason.id,
      p_game_date: todayDateString(),
      p_assignments: [],
    })
    const check = await verifyLockedLineup(fixture)
    const failures = [...check.failures]
    if (!error) {
      failures.push('forged auto_set_lineup_atomic call succeeded; expected locked-lineup rejection')
    } else if (!/locked|started/i.test(error.message)) {
      failures.push(`forged auto_set_lineup_atomic rejected with "${error.message}"; expected lock/start message`)
    }
    return {
      rejected: Boolean(error),
      errorMessage: error?.message ?? null,
      check,
      failures,
    }
  } finally {
    await client.auth.signOut().catch(() => {})
  }
}

const verifyForgedLockedMovesRpc = async (env, fixture) => {
  const client = await signInClient(env, fixture.user.email, fixture.password)
  try {
    const { error } = await client.rpc('set_player_slot_moves_atomic', {
      p_member_id: fixture.member.id,
      p_league_id: fixture.league.id,
      p_league_season_id: fixture.currentSeason.id,
      p_game_date: todayDateString(),
      p_week_number: fixture.week.week_number,
      p_moves: [
        { player_id: fixture.lockedPlayer.id, slot_type: 'BE' },
        { player_id: fixture.benchPlayer.id, slot_type: 'PG' },
      ],
    })
    const check = await verifyLockedLineup(fixture)
    const failures = [...check.failures]
    if (!error) {
      failures.push('forged set_player_slot_moves_atomic call succeeded; expected locked-lineup rejection')
    } else if (!/locked|started/i.test(error.message)) {
      failures.push(`forged set_player_slot_moves_atomic rejected with "${error.message}"; expected lock/start message`)
    }
    return {
      rejected: Boolean(error),
      errorMessage: error?.message ?? null,
      check,
      failures,
    }
  } finally {
    await client.auth.signOut().catch(() => {})
  }
}

export async function runBrowserLineupScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupLineupFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-lineup-${fixture.runId}-${process.pid}`)
  const peerSession = safeName(`${session}-peer`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-lineup')
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Manager: ${fixture.user.email}`,
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
        rosterPlayerId: fixture.rosterRow.id,
        weekNumber: fixture.week.week_number,
    }),
    notes,
    failureLabel: 'Browser lineup scenario failed',
    run: async ({ record }) => {
      await signInBrowser(session, env, fixture.user, fixture.password)
      await browser(session, ['set', 'viewport', '390', '844'])
      await browser(session, ['open', joinUrl(env.frontendUrl, '/lineup')])
      await browser(session, ['wait', '3000'])
      await assertPageText(session, ['Lineup', 'STARTERS', 'BENCH', fixture.player.display_name], 'lineup before move')
      await signInBrowser(peerSession, env, fixture.user, fixture.password)
      await browser(peerSession, ['set', 'viewport', '390', '844'])
      await browser(peerSession, ['open', joinUrl(env.frontendUrl, '/lineup')])
      await browser(peerSession, ['wait', '3000'])
      const peerBefore = await waitForAccessibleButton(
        peerSession,
        `Bench ${fixture.player.display_name}`,
        'peer lineup before move',
      )
      record({ beforeScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'lineup-before-move.png') })
      const benchClick = await clickButton(session, `Bench ${fixture.player.display_name}`, 'bench player row', { preferDom: true })
      await browser(session, ['wait', '500'])
      const slotClick = await clickButton(session, 'Empty PG slot', 'empty PG slot row', { preferDom: true })
      const lineupCheck = await waitForLineup(fixture, { expectedAutoSet: false })
      const peerAfter = await waitForAccessibleButton(
        peerSession,
        `PG ${fixture.player.display_name}`,
        'peer lineup after realtime move',
      )
      await browser(session, ['reload'])
      await assertPageText(session, ['Lineup', 'STARTERS', 'BENCH', fixture.player.display_name], 'lineup after refresh')
      const refreshCheck = await waitForAccessibleButton(
        session,
        `PG ${fixture.player.display_name}`,
        'lineup persistence after refresh',
      )
      record({ benchClick, slotClick, lineupCheck, peerBefore, peerAfter, refreshCheck })
      await browser(session, ['wait', '1000'])
      record({ afterScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'lineup-after-move.png') })
      return { fields: { lineupCheck, peerBefore, peerAfter, refreshCheck }, failures: lineupCheck.failures }
    },
    verifyFailure: async () => ({ lineupCheck: await verifyLineup(fixture, { expectedAutoSet: false }) }),
  })
}

export async function runBrowserLineupLockedScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupLockedLineupFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-lineup-locked-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-lineup-locked')
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Manager: ${fixture.user.email}`,
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
      lockedPlayerId: fixture.lockedPlayer.id,
      benchPlayerId: fixture.benchPlayer.id,
      lockedRosterPlayerId: fixture.lockedRosterRow?.id ?? null,
      benchRosterPlayerId: fixture.benchRosterRow?.id ?? null,
      weekNumber: fixture.week.week_number,
      scheduledTipoff: fixture.scheduledTipoff,
    }),
    notes,
    failureLabel: 'Browser lineup locked scenario failed',
    run: async ({ record }) => {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['open', joinUrl(env.frontendUrl, '/lineup')])
    await browser(session, ['wait', '3000'])
    await assertPageText(
      session,
      ['Lineup', 'STARTERS', 'BENCH', fixture.lockedPlayer.display_name, fixture.benchPlayer.display_name],
      'locked lineup before move',
    )
    record({ beforeScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'lineup-locked-before.png') })
    const starterClick = await clickButton(session, `PG ${fixture.lockedPlayer.display_name}`, 'locked starter row')
    const benchClick = await clickButton(session, `Bench ${fixture.benchPlayer.display_name}`, 'bench player row')
    await browser(session, ['wait', '1000'])
    const lockedCheck = await verifyLockedLineup(fixture)
    const forgedRpcCheck = await verifyForgedLockedLineupRpc(env, fixture)
    const forgedMovesCheck = await verifyForgedLockedMovesRpc(env, fixture)
    const forgedAutoSetCheck = await verifyForgedLockedAutoSetRpc(env, fixture)
    const forgedLegalityCheck = await verifyForgedLineupLegalityRpc(env, fixture)
    record({ starterClick, benchClick, lockedCheck, forgedRpcCheck, forgedMovesCheck, forgedAutoSetCheck, forgedLegalityCheck })
    record({ afterScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'lineup-locked-after.png') })
    const failures = [...lockedCheck.failures, ...forgedRpcCheck.failures, ...forgedMovesCheck.failures, ...forgedAutoSetCheck.failures, ...forgedLegalityCheck.failures]
    return {
      fields: { mode: 'locked', lockedCheck, forgedRpcCheck, forgedMovesCheck, forgedAutoSetCheck, forgedLegalityCheck },
      failures,
    }
    },
    verifyFailure: async () => ({ lockedCheck: await verifyLockedLineup(fixture) }),
  })
}

export async function runBrowserLineupAutoSetScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupLineupFixture(env, season, { remainingSeasonDateCount: 2 })
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-lineup-auto-${fixture.runId}-${process.pid}`)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-lineup-auto-set')
  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Manager: ${fixture.user.email}`,
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
      rosterPlayerId: fixture.rosterRow.id,
      weekNumber: fixture.week.week_number,
    }),
    notes,
    failureLabel: 'Browser lineup auto-set scenario failed',
    run: async ({ record }) => {
    await signInBrowser(session, env, fixture.user, fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['open', joinUrl(env.frontendUrl, '/lineup')])
    await browser(session, ['wait', '3000'])
    await resetBrowserAlertCapture(session)
    await assertPageText(session, ['Lineup', 'STARTERS', 'BENCH', fixture.player.display_name, 'Auto-Set'], 'lineup before auto-set')
    record({ beforeScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'lineup-auto-before.png') })
    const openClick = await clickButton(session, 'Open auto-set lineup options', 'auto-set button')
    await assertPageText(session, ['Auto-Set Lineup', 'Today', 'Whole Week', 'Rest of Season'], 'auto-set modal')
    const todayClick = await clickButton(session, 'Auto-set today', 'auto-set today button')
    const lineupCheck = await waitForLineup(fixture, { expectedAutoSet: true })
    const openSeasonClick = await clickButton(session, 'Open auto-set lineup options', 'auto-set button for remaining season')
    await assertPageText(session, ['Auto-Set Lineup', 'Rest of Season'], 'remaining-season auto-set modal')
    const seasonClick = await clickButton(session, 'Auto-set rest of season', 'auto-set remaining season button')
    const seasonAlert = await waitForAlertText(
      session,
      'Lineup set for the rest of the season.',
      'remaining-season success notice',
    )
    const seasonCheck = await waitForRemainingSeasonLineups(fixture)
    record({ openClick, todayClick, lineupCheck, openSeasonClick, seasonClick, seasonCheck, seasonAlert })
    await browser(session, ['wait', '1000'])
    record({ afterScreenshot: await captureBrowserScreenshot(browser, session, artifactDir, 'lineup-auto-after.png') })
    return {
      fields: { mode: 'auto-set', lineupCheck, seasonCheck, seasonAlert },
      failures: [...lineupCheck.failures, ...seasonCheck.failures],
    }
    },
    verifyFailure: async () => ({
      lineupCheck: await verifyLineup(fixture, { expectedAutoSet: true }),
      seasonCheck: await verifyRemainingSeasonLineups(fixture),
    }),
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  const scenarioId = process.argv.includes('--locked')
    ? 'lineup-locked'
    : process.argv.includes('--auto-set')
    ? 'lineup-auto-set'
    : 'lineup'
  import('./browser-scenario-registry.mjs').then(({ browserScenarioById }) => (
    browserScenarioById(scenarioId).run({ args: { browserFullSweep: false }, season })
  )).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
