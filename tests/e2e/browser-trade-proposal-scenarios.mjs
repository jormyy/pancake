import {
  ARTIFACT_ROOT,
  POST_DEADLINE_REPORT_PATH,
  REPORT_PATH,
  ROOT,
  assertPageText,
  browser,
  clickButton,
  describeEndpoint,
  installBrowserHooks,
  joinUrl,
  listSessions,
  mkdir,
  normalizeBrowserErrors,
  path,
  readBrowserAlerts,
  readButtonState,
  requireEnv,
  resolvedEnv,
  setupTradeGameplayFixture,
  setupTradePostDeadlineGameplayFixture,
  signInBrowser,
  tradeSessionName,
  verifyPostDeadlineTradeRejected,
  verifyTradeProposal,
  waitForTradeProposal,
  writeFile,
} from './browser-trade-support.mjs'

export async function runBrowserTradeScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('tr', fixture.runId)
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

    const recipientTabClick = await clickButton(
      session,
      `Edit assets sent by ${fixture.recipient.team_name}`,
      'recipient sender tab',
    )
    await assertPageText(session, [fixture.recipientPlayer.display_name], 'recipient trade assets')
    const requestClick = await clickButton(
      session,
      `Select ${fixture.recipientPlayer.display_name} for trade`,
      'recipient player selection',
    )
    const proposerTabClick = await clickButton(session, 'Edit assets sent by you', 'proposer sender tab')
    const offerClick = await clickButton(
      session,
      `Select ${fixture.proposerPlayer.display_name} for trade`,
      'proposer player selection',
    )
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-selected.png')], { timeout: 60_000 })
    const submitClick = await clickButton(session, 'Send trade proposal', 'trade proposal submit')
    const tradeProposal = await waitForTradeProposal(fixture)
    debug = { ...debug, recipientTabClick, proposerTabClick, requestClick, offerClick, submitClick, tradeProposal }
    if (tradeProposal.failures.length > 0) {
      throw new Error(`trade proposal did not persist: ${tradeProposal.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-after-submit.png')], { timeout: 60_000 })

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
    await fixture.dispose()
  }
}

export async function runBrowserMultiTeamTradeScenario(options = {}) {
  const { runBrowserMultiTeamTradeScenario: run } = await import('./browser-trade-multi-team.mjs')
  return run(options)
}

export async function runBrowserTradePostDeadlineScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
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

    const recipientTabClick = await clickButton(
      session,
      `Edit assets sent by ${fixture.recipient.team_name}`,
      'post-deadline recipient sender tab',
    )
    const requestClick = await clickButton(
      session,
      `Select ${fixture.recipientPlayer.display_name} for trade`,
      'post-deadline recipient player selection',
    )
    const proposerTabClick = await clickButton(session, 'Edit assets sent by you', 'post-deadline proposer sender tab')
    const offerClick = await clickButton(
      session,
      `Select ${fixture.proposerPlayer.display_name} for trade`,
      'post-deadline proposer player selection',
    )
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
