import {
  ACCEPT_REPORT_PATH,
  ARTIFACT_ROOT,
  FUTURE_PICK_ACCEPT_REPORT_PATH,
  FUTURE_PICK_REPORT_PATH,
  OVERFLOW_ACCEPT_REPORT_PATH,
  ROOT,
  assertPageText,
  browser,
  clickTestId,
  describeEndpoint,
  expireAndCompleteAcceptedTrade,
  installBrowserHooks,
  joinUrl,
  listSessions,
  mkdir,
  normalizeBrowserErrors,
  openOffersTab,
  path,
  resolvedTradeEnv,
  setupTradeAcceptGameplayFixture,
  setupTradeFuturePickAcceptGameplayFixture,
  setupTradeGameplayFixture,
  setupTradeOverflowAcceptGameplayFixture,
  signInBrowser,
  tradeSessionName,
  verifyFuturePickTradeAccepted,
  verifyFuturePickTradeProposal,
  verifyOverflowTradeAccepted,
  verifyTradeAccepted,
  waitForFuturePickTradeAccepted,
  waitForFuturePickTradeProposal,
  waitForOverflowTradeAccepted,
  waitForTradeAccepted,
  writeFile,
} from './browser-trade-support.mjs'
import { createClient } from '@supabase/supabase-js'

const exerciseLazyOverflowActions = async (fixture, env) => {
  const client = createClient(env.supabaseUrl, env.anonKey, { auth: { persistSession: false } })
  const { error: signInError } = await client.auth.signInWithPassword({
    email: fixture.users[1].email,
    password: fixture.password,
  })
  if (signInError) throw new Error(`overflow recipient sign in: ${signInError.message}`)

  const { error: lineupError } = await client.rpc('set_player_slot_moves_atomic', {
    p_member_id: fixture.recipient.id,
    p_league_id: fixture.league.id,
    p_league_season_id: fixture.currentSeason.id,
    p_game_date: new Date().toISOString().slice(0, 10),
    p_week_number: 1,
    p_moves: [],
  })
  if (!lineupError || !/over the active player limit/i.test(lineupError.message)) {
    throw new Error(`overflow lineup mutation was not cap-blocked: ${lineupError?.message ?? 'succeeded'}`)
  }

  const { error: addError } = await client.rpc('add_free_agent_atomic', {
    p_member_id: fixture.recipient.id,
    p_league_id: fixture.league.id,
    p_player_id: fixture.freeAgentPlayer.id,
  })
  if (!addError || !/active roster is full/i.test(addError.message)) {
    throw new Error(`overflow free-agent add was not cap-blocked: ${addError?.message ?? 'succeeded'}`)
  }

  const { error: dropError } = await client.rpc('drop_player_atomic', {
    p_roster_player_id: fixture.dropCandidateRosterId,
  })
  if (dropError) throw new Error(`overflow corrective drop failed: ${dropError.message}`)

  const [{ count: activeCount, error: rosterError }, { count: waiverCount, error: waiverError }] = await Promise.all([
    fixture.admin.from('roster_players').select('id', { count: 'exact', head: true })
      .eq('league_id', fixture.league.id).eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', fixture.recipient.id).eq('is_on_ir', false).eq('is_on_taxi', false),
    fixture.admin.from('waiver_wire_log').select('id', { count: 'exact', head: true })
      .eq('league_id', fixture.league.id).eq('league_season_id', fixture.currentSeason.id)
      .eq('player_id', fixture.recipientPlayer.id).eq('dropped_by_member_id', fixture.recipient.id),
  ])
  if (rosterError) throw new Error(`overflow corrected roster verify: ${rosterError.message}`)
  if (waiverError) throw new Error(`overflow corrective waiver verify: ${waiverError.message}`)
  if (activeCount !== fixture.rosterSize) throw new Error(`overflow corrected active count=${activeCount}; expected ${fixture.rosterSize}`)
  if (waiverCount !== 1) throw new Error(`overflow corrective waiver rows=${waiverCount}; expected 1`)

  return {
    lineupBlocked: true,
    freeAgentBlocked: true,
    correctiveDropAllowed: true,
    activeCount,
    waiverCount,
  }
}

export async function runBrowserTradeAcceptScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedTradeEnv()
  const fixture = await setupTradeAcceptGameplayFixture(env, season)
  if (!fixture.proposer.team_name) throw new Error('Trade fixture proposer must have a team name')
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('ac', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-accept')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Recipient: ${fixture.users[1].email}`,
    `Trade: ${fixture.trade.id}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[1], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await openOffersTab(session, env)
    await assertPageText(
      session,
      [
        'Trades',
        'INCOMING',
        fixture.proposer.team_name,
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        'Accept',
      ],
      'trade accept before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-accept-before.png')], { timeout: 60_000 })

    const acceptClick = await clickTestId(session, `trade-accept-${fixture.trade.id}`, 'trade accept button')
    await expireAndCompleteAcceptedTrade(fixture)
    const accepted = await waitForTradeAccepted(fixture)
    debug = { ...debug, acceptClick, accepted }
    if (accepted.failures.length > 0) {
      throw new Error(`trade accept did not complete: ${accepted.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-accept-after.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...accepted.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        tradeId: fixture.trade.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
      },
      accepted,
      notes,
      failures,
    }
    await writeFile(ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser trade accept scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const accepted = await verifyTradeAccepted(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, accepted, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        tradeId: fixture.trade.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  }
}

export async function runBrowserTradeFuturePickScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedTradeEnv()
  const fixture = await setupTradeGameplayFixture(env, season)
  if (!fixture.proposerFuturePick || !fixture.recipientFuturePick) {
    throw new Error('Future-pick fixture must provide both traded picks')
  }
  const futureFixture = {
    ...fixture,
    proposerFuturePick: fixture.proposerFuturePick,
    recipientFuturePick: fixture.recipientFuturePick,
  }
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('fp', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-future-pick')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Proposer: ${fixture.users[0].email}`,
    `Recipient member: ${fixture.recipient.id}`,
    `Future pick year: ${fixture.targetFuturePickYear}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[0], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['open', joinUrl(env.frontendUrl, `/propose-trade?recipientMemberId=${fixture.recipient.id}`)])
    await installBrowserHooks(session, env)
    await browser(session, ['wait', '3500'])
    await assertPageText(
      session,
      [
        'Propose Trade',
        'DEAL SUMMARY',
        'EDIT ASSETS SENT BY',
        'DRAFT PICKS',
        String(fixture.targetFuturePickYear),
        fixture.proposerFuturePick.originalTeamName,
      ],
      'future-pick trade before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-before-submit.png')], { timeout: 60_000 })

    const recipientTabClick = await clickTestId(session, `trade-sender-${fixture.recipient.id}`, 'future-pick recipient sender tab')
    const requestPickClick = await clickTestId(session, `trade-${fixture.recipient.id}-pick-${fixture.recipientFuturePick.id}`, 'recipient future pick selection')
    const proposerTabClick = await clickTestId(session, `trade-sender-${fixture.proposer.id}`, 'future-pick proposer sender tab')
    const offerPickClick = await clickTestId(session, `trade-${fixture.proposer.id}-pick-${fixture.proposerFuturePick.id}`, 'proposer future pick selection')
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-selected.png')], { timeout: 60_000 })
    const submitClick = await clickTestId(session, 'trade-submit', 'future-pick trade proposal submit')
    const confirmClick = await clickTestId(session, 'trade-confirm-submit', 'future-pick trade proposal confirm')
    const tradeProposal = await waitForFuturePickTradeProposal(futureFixture)
    debug = { ...debug, recipientTabClick, proposerTabClick, requestPickClick, offerPickClick, submitClick, confirmClick, tradeProposal }
    if (tradeProposal.failures.length > 0) {
      throw new Error(`future-pick trade proposal did not persist: ${tradeProposal.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-after-submit.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...tradeProposal.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        targetFuturePickYear: fixture.targetFuturePickYear,
        proposerPickId: fixture.proposerFuturePick.id,
        recipientPickId: fixture.recipientFuturePick.id,
      },
      tradeProposal,
      notes,
      failures,
    }
    await writeFile(FUTURE_PICK_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser future-pick trade scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const tradeProposal = await verifyFuturePickTradeProposal(futureFixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, tradeProposal, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        targetFuturePickYear: fixture.targetFuturePickYear,
        proposerPickId: fixture.proposerFuturePick.id,
        recipientPickId: fixture.recipientFuturePick.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(FUTURE_PICK_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  }
}

export async function runBrowserTradeFuturePickAcceptScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedTradeEnv()
  const fixture = await setupTradeFuturePickAcceptGameplayFixture(env, season)
  if (!fixture.proposer.team_name) throw new Error('Trade fixture proposer must have a team name')
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('fpa', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-future-pick-accept')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Recipient: ${fixture.users[1].email}`,
    `Trade: ${fixture.trade.id}`,
    `Future pick year: ${fixture.targetFuturePickYear}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[1], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await openOffersTab(session, env)
    await assertPageText(
      session,
      [
        'Trades',
        'INCOMING',
        fixture.proposer.team_name,
        String(fixture.targetFuturePickYear),
        `via ${fixture.proposerFuturePick.originalTeamName}`,
        `via ${fixture.recipientFuturePick.originalTeamName}`,
        'Accept',
      ],
      'future-pick trade accept before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-accept-before.png')], { timeout: 60_000 })

    const acceptClick = await clickTestId(session, `trade-accept-${fixture.trade.id}`, 'future-pick trade accept button')
    await expireAndCompleteAcceptedTrade(fixture)
    const accepted = await waitForFuturePickTradeAccepted(fixture)
    debug = { ...debug, acceptClick, accepted }
    if (accepted.failures.length > 0) {
      throw new Error(`future-pick trade accept did not complete: ${accepted.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-accept-after.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...accepted.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        tradeId: fixture.trade.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        targetFuturePickYear: fixture.targetFuturePickYear,
        proposerPickId: fixture.proposerFuturePick.id,
        recipientPickId: fixture.recipientFuturePick.id,
      },
      accepted,
      notes,
      failures,
    }
    await writeFile(FUTURE_PICK_ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser future-pick trade accept scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const accepted = await verifyFuturePickTradeAccepted(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, accepted, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        tradeId: fixture.trade.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        targetFuturePickYear: fixture.targetFuturePickYear,
        proposerPickId: fixture.proposerFuturePick.id,
        recipientPickId: fixture.recipientFuturePick.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(FUTURE_PICK_ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  }
}

export async function runBrowserTradeOverflowAcceptScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedTradeEnv()
  const fixture = await setupTradeOverflowAcceptGameplayFixture(env, season)
  if (!fixture.proposer.team_name) throw new Error('Trade fixture proposer must have a team name')
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('oa', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-overflow-accept')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Recipient: ${fixture.users[1].email}`,
    `Trade: ${fixture.trade.id}`,
    `Roster size: ${fixture.rosterSize}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[1], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844'])
    await openOffersTab(session, env)
    await assertPageText(
      session,
      [
        'Trades',
        'INCOMING',
        fixture.proposer.team_name,
        fixture.proposerPlayer.display_name,
        `${fixture.recipientFuturePick.seasonYear} Rd ${fixture.recipientFuturePick.round}`,
        'Accept',
      ],
      'overflow trade accept before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'overflow-accept-before.png')], { timeout: 60_000 })

    const acceptClick = await clickTestId(session, `trade-accept-${fixture.trade.id}`, 'overflow trade accept button')
    await expireAndCompleteAcceptedTrade(fixture)
    const accepted = await waitForOverflowTradeAccepted(fixture)
    debug = { ...debug, acceptClick, accepted }
    if (accepted.failures.length > 0) {
      throw new Error(`overflow trade accept did not complete: ${accepted.failures.join('; ')}`)
    }
    const lazyActions = await exerciseLazyOverflowActions(fixture, env)
    debug = { ...debug, lazyActions }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'overflow-accept-after.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...accepted.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        tradeId: fixture.trade.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        incomingPlayerId: fixture.proposerPlayer.id,
        correctiveDropPlayerId: fixture.recipientPlayer.id,
        correctiveDropRosterPlayerId: fixture.dropCandidateRosterId,
        recipientPickId: fixture.recipientFuturePick.id,
        rosterSize: fixture.rosterSize,
      },
      accepted,
      lazyActions,
      notes,
      failures,
    }
    await writeFile(OVERFLOW_ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser trade overflow accept scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const accepted = await verifyOverflowTradeAccepted(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, accepted, consoleOutput, errorOutput, networkOutput }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixture: {
        runId: fixture.runId,
        leagueId: fixture.league.id,
        leagueSeasonId: fixture.currentSeason.id,
        tradeId: fixture.trade.id,
        proposerMemberId: fixture.proposer.id,
        recipientMemberId: fixture.recipient.id,
        incomingPlayerId: fixture.proposerPlayer.id,
        correctiveDropPlayerId: fixture.recipientPlayer.id,
        correctiveDropRosterPlayerId: fixture.dropCandidateRosterId,
        recipientPickId: fixture.recipientFuturePick.id,
        rosterSize: fixture.rosterSize,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(OVERFLOW_ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  }
}
