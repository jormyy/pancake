import {
  ARTIFACT_ROOT,
  POST_DEADLINE_REPORT_PATH,
  REPORT_PATH,
  ROOT,
  assertPageText,
  browser,
  clickTestId,
  describeEndpoint,
  installBrowserHooks,
  joinUrl,
  listSessions,
  mkdir,
  normalizeBrowserErrors,
  path,
  readBrowserAlerts,
  readButtonState,
  resolvedTradeEnv,
  setupTradeGameplayFixture,
  setupTradePostDeadlineGameplayFixture,
  signInBrowser,
  tradeSessionName,
  verifyPostDeadlineTradeRejected,
  verifyTradeProposal,
  waitForTradeProposal,
  waitForTradeReplacement,
  writeFile,
} from './browser-trade-support.mjs'

export async function runBrowserTradeScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedTradeEnv()
  const fixture = await setupTradeGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('tr', fixture.runId)
  const counterSession = `${session}-counter`
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Proposer: ${fixture.users[0].email}`,
    `Recipient member: ${fixture.recipient.id}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[0], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await browser(session, ['open', joinUrl(env.frontendUrl, `/propose-trade?recipientMemberId=${fixture.recipient.id}`)])
    await browser(session, ['wait', '3500'])
    await assertPageText(
      session,
      [
        'Propose Trade',
        'DEAL OVERVIEW',
        'BUILD THE DEAL',
        'You send',
        `${fixture.recipient.team_name} sends`,
        fixture.proposerPlayer.display_name,
      ],
      'trade proposal before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-before-submit.png')], { timeout: 60_000 })

    const recipientTabClick = await clickTestId(session, `trade-sender-${fixture.recipient.id}`, 'recipient sender tab')
    await assertPageText(session, [fixture.recipientPlayer.display_name], 'recipient trade assets')
    const requestClick = await clickTestId(session, `trade-${fixture.recipient.id}-player-${fixture.recipientPlayer.id}`, 'recipient player selection')
    const proposerTabClick = await clickTestId(session, `trade-sender-${fixture.proposer.id}`, 'proposer sender tab')
    const offerClick = await clickTestId(session, `trade-${fixture.proposer.id}-player-${fixture.proposerPlayer.id}`, 'proposer player selection')
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-selected.png')], { timeout: 60_000 })
    const submitClick = await clickTestId(session, 'trade-submit', 'trade proposal submit')
    const tradeProposal = await waitForTradeProposal(fixture)
    debug = { ...debug, recipientTabClick, proposerTabClick, requestClick, offerClick, submitClick, tradeProposal }
    if (tradeProposal.failures.length > 0) {
      throw new Error(`trade proposal did not persist: ${tradeProposal.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-after-submit.png')], { timeout: 60_000 })

    await browser(session, ['open', joinUrl(env.frontendUrl, `/propose-trade?editTradeId=${tradeProposal.trade.id}`)])
    await installBrowserHooks(session, env)
    await browser(session, ['wait', '3500'])
    await assertPageText(session, [
      'Edit Trade',
      fixture.proposerPlayer.display_name,
      fixture.recipientPlayer.display_name,
    ], 'two-team edit composer prefilled')
    const editSubmitClick = await clickTestId(session, 'trade-submit', 'two-team edit submit')
    const editReplacement = await waitForTradeReplacement(fixture, tradeProposal.trade.id, {
      initialTradeId: tradeProposal.trade.id,
      sourceStatus: 'edited',
      sourceColumn: 'edited_from_trade_id',
      expectedProposerId: fixture.proposer.id,
      expectedRecipientId: fixture.recipient.id,
      expectedVersion: 2,
    })
    if (editReplacement.failures.length > 0 || !editReplacement.replacement) {
      throw new Error(`two-team edit replacement failed: ${editReplacement.failures.join('; ')}`)
    }

    await signInBrowser(counterSession, env, fixture.users[1], fixture.password)
    await browser(counterSession, ['open', joinUrl(env.frontendUrl, `/propose-trade?counterTradeId=${editReplacement.replacement.id}`)])
    await installBrowserHooks(counterSession, env)
    await browser(counterSession, ['wait', '3500'])
    await assertPageText(counterSession, [
      'Counter Trade',
      fixture.proposerPlayer.display_name,
      fixture.recipientPlayer.display_name,
    ], 'two-team counter composer prefilled')
    const counterSubmitClick = await clickTestId(counterSession, 'trade-submit', 'two-team counter submit')
    const counterReplacement = await waitForTradeReplacement(fixture, editReplacement.replacement.id, {
      initialTradeId: tradeProposal.trade.id,
      sourceStatus: 'countered',
      sourceColumn: 'countered_from_trade_id',
      expectedProposerId: fixture.recipient.id,
      expectedRecipientId: fixture.proposer.id,
      expectedVersion: 3,
    })
    if (counterReplacement.failures.length > 0) {
      throw new Error(`two-team counter replacement failed: ${counterReplacement.failures.join('; ')}`)
    }
    debug = { ...debug, editSubmitClick, editReplacement, counterSubmitClick, counterReplacement }

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
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
      },
      tradeProposal,
      editReplacement,
      counterReplacement,
      notes,
      failures,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser trade scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const tradeProposal = await verifyTradeProposal(fixture).catch((verifyError) => ({
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
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
    await browser(counterSession, ['close']).catch(() => {})
    await fixture.dispose()
  }
}

export async function runBrowserTradePostDeadlineScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedTradeEnv()
  const fixture = await setupTradePostDeadlineGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('pd', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-post-deadline')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Proposer: ${fixture.users[0].email}`,
    `Recipient member: ${fixture.recipient.id}`,
    `Trade deadline: ${fixture.tradeDeadline}`,
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
        'You send',
        `${fixture.recipient.team_name} sends`,
        fixture.proposerPlayer.display_name,
        'Trades are locked only from the trade deadline until the champion is finalized.',
      ],
      'post-deadline trade proposal before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'post-deadline-before-submit.png')], { timeout: 60_000 })

    const recipientTabClick = await clickTestId(session, `trade-sender-${fixture.recipient.id}`, 'post-deadline recipient sender tab')
    const requestClick = await clickTestId(session, `trade-${fixture.recipient.id}-player-${fixture.recipientPlayer.id}`, 'post-deadline recipient player selection')
    const proposerTabClick = await clickTestId(session, `trade-sender-${fixture.proposer.id}`, 'post-deadline proposer sender tab')
    const offerClick = await clickTestId(session, `trade-${fixture.proposer.id}-player-${fixture.proposerPlayer.id}`, 'post-deadline proposer player selection')
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'post-deadline-selected.png')], { timeout: 60_000 })
    const submitState = await readButtonState(session, 'Send trade proposal', 'post-deadline trade proposal submit')

    const alerts = await readBrowserAlerts(session)
    const rejected = await verifyPostDeadlineTradeRejected(fixture)
    debug = { ...debug, recipientTabClick, proposerTabClick, requestClick, offerClick, submitState, alerts, rejected }
    const failures = [...rejected.failures]
    if (submitState.disabled !== true && submitState.ariaDisabled !== 'true') {
      failures.push(`send button was not disabled after deadline; state=${JSON.stringify(submitState)}`)
    }
    await browser(session, ['screenshot', path.join(artifactDir, 'post-deadline-disabled-submit.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

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
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
        tradeDeadline: fixture.tradeDeadline,
      },
      alerts,
      submitState,
      rejected,
      notes,
      failures,
    }
    await writeFile(POST_DEADLINE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser post-deadline trade scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const [alerts, rejected] = await Promise.all([
      readBrowserAlerts(session).catch((alertError) => [`alerts unavailable: ${alertError.message}`]),
      verifyPostDeadlineTradeRejected(fixture).catch((verifyError) => ({
        failures: [`verify unavailable: ${verifyError.message}`],
      })),
    ])
    debug = { ...debug, alerts, rejected, consoleOutput, errorOutput, networkOutput }
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
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
        tradeDeadline: fixture.tradeDeadline,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(POST_DEADLINE_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
    await fixture.dispose()
  }
}
