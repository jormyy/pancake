import {
  ACCEPT_REPORT_PATH,
  ARTIFACT_ROOT,
  FUTURE_PICK_ACCEPT_REPORT_PATH,
  FUTURE_PICK_REPORT_PATH,
  OVERFLOW_ACCEPT_REPORT_PATH,
  ROOT,
  assertPageText,
  browser,
  clickButton,
  describeEndpoint,
  expireAndCompleteAcceptedTrade,
  installBrowserHooks,
  joinUrl,
  listSessions,
  mkdir,
  normalizeBrowserErrors,
  openOffersTab,
  path,
  requireEnv,
  resolvedEnv,
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

export async function runBrowserTradeAcceptScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
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
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
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

    const acceptClick = await clickButton(
      session,
      `Accept trade with ${fixture.proposer.team_name}`,
      'trade accept button',
    )
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
  } finally {
    await browser(session, ['close']).catch(() => {})
    await fixture.dispose()
  }
}

export async function runBrowserTradeFuturePickScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  if (!env.frontendUrl) throw new Error('Missing E2E_FRONTEND_URL')
  const fixture = await setupTradeGameplayFixture(env, season)
  if (!fixture.proposerFuturePick || !fixture.recipientFuturePick) {
    throw new Error('Future-pick fixture must provide both traded picks')
  }
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('fp', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-future-pick')
  await mkdir(artifactDir, { recursive: true })

  const recipientPickLabel = `Select ${fixture.recipientFuturePick.seasonYear} round ${fixture.recipientFuturePick.round} pick via ${fixture.recipientFuturePick.originalTeamName} for trade`
  const proposerPickLabel = `Select ${fixture.proposerFuturePick.seasonYear} round ${fixture.proposerFuturePick.round} pick via ${fixture.proposerFuturePick.originalTeamName} for trade`
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
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, `/propose-trade?recipientMemberId=${fixture.recipient.id}`)])
    await installBrowserHooks(session, env)
    await browser(session, ['wait', '3500'])
    await assertPageText(
      session,
      [
        'Propose Trade',
        'DEAL OVERVIEW',
        'BUILD THE DEAL',
        'DRAFT PICKS',
        String(fixture.targetFuturePickYear),
        fixture.proposerFuturePick.originalTeamName,
      ],
      'future-pick trade before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-before-submit.png')], { timeout: 60_000 })

    const recipientTabClick = await clickButton(
      session,
      `Edit assets sent by ${fixture.recipient.team_name}`,
      'future-pick recipient sender tab',
    )
    const requestPickClick = await clickButton(session, recipientPickLabel, 'recipient future pick selection')
    const proposerTabClick = await clickButton(session, 'Edit assets sent by you', 'future-pick proposer sender tab')
    const offerPickClick = await clickButton(session, proposerPickLabel, 'proposer future pick selection')
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-selected.png')], { timeout: 60_000 })
    const submitClick = await clickButton(session, 'Send trade proposal', 'future-pick trade proposal submit')
    const tradeProposal = await waitForFuturePickTradeProposal(fixture)
    debug = { ...debug, recipientTabClick, proposerTabClick, requestPickClick, offerPickClick, submitClick, tradeProposal }
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
    const tradeProposal = await verifyFuturePickTradeProposal(fixture).catch((verifyError) => ({
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
  } finally {
    await browser(session, ['close']).catch(() => {})
    await fixture.dispose()
  }
}

export async function runBrowserTradeFuturePickAcceptScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
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
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
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

    const acceptClick = await clickButton(
      session,
      `Accept trade with ${fixture.proposer.team_name}`,
      'future-pick trade accept button',
    )
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
  } finally {
    await browser(session, ['close']).catch(() => {})
    await fixture.dispose()
  }
}

export async function runBrowserTradeOverflowAcceptScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
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
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
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

    const acceptClick = await clickButton(
      session,
      `Accept trade with ${fixture.proposer.team_name}`,
      'overflow trade accept button',
    )
    await browser(session, ['wait', '750'])
    await assertPageText(
      session,
      [
        'Drop 1 player to make room',
        'Select 1 player to drop, then the trade will be accepted atomically.',
        fixture.recipientPlayer.display_name,
      ],
      'overflow drop picker',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'overflow-drop-picker.png')], { timeout: 60_000 })

    const dropClick = await clickButton(
      session,
      `Drop ${fixture.recipientPlayer.display_name}`,
      'overflow drop candidate button',
    )
    await expireAndCompleteAcceptedTrade(fixture)
    const accepted = await waitForOverflowTradeAccepted(fixture)
    debug = { ...debug, acceptClick, dropClick, accepted }
    if (accepted.failures.length > 0) {
      throw new Error(`overflow trade accept did not complete: ${accepted.failures.join('; ')}`)
    }
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
        droppedPlayerId: fixture.recipientPlayer.id,
        droppedRosterPlayerId: fixture.dropCandidateRosterId,
        recipientPickId: fixture.recipientFuturePick.id,
        rosterSize: fixture.rosterSize,
      },
      accepted,
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
        droppedPlayerId: fixture.recipientPlayer.id,
        droppedRosterPlayerId: fixture.dropCandidateRosterId,
        recipientPickId: fixture.recipientFuturePick.id,
        rosterSize: fixture.rosterSize,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(OVERFLOW_ACCEPT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
    await fixture.dispose()
  }
}
