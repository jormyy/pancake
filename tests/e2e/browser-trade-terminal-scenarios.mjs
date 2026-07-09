import {
  ARTIFACT_ROOT,
  ROOT,
  TERMINAL_REPORT_PATH,
  VETO_REPORT_PATH,
  assertPageText,
  browser,
  clickButton,
  clickLastButton,
  describeEndpoint,
  listSessions,
  mkdir,
  normalizeBrowserErrors,
  openOffersTab,
  path,
  requireEnv,
  resolvedEnv,
  safeName,
  setupTradeAcceptGameplayFixture,
  setupTradeVetoGameplayFixture,
  signInBrowser,
  tradeSessionName,
  verifyTradeTerminalStatus,
  verifyTradeVetoed,
  waitForTradeTerminalStatus,
  waitForTradeVetoed,
  writeFile,
} from './browser-trade-support.mjs'

export async function runBrowserTradeVetoScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeVetoGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('vt', fixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-veto')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Observer: ${fixture.users[2].email}`,
    `Trade: ${fixture.trade.id}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[2], fixture.password)
    await browser(session, ['set', 'viewport', '390', '844']).catch(() => {})
    await openOffersTab(session, env)
    await assertPageText(
      session,
      [
        'Trades',
        'VETO WINDOW',
        fixture.proposer.team_name,
        fixture.recipient.team_name,
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        'Veto',
      ],
      'trade veto before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-veto-before.png')], { timeout: 60_000 })
    const vetoClick = await clickButton(
      session,
      `Veto trade between ${fixture.proposer.team_name} and ${fixture.recipient.team_name}`,
      'trade veto button',
    )
    await browser(session, ['wait', '300'])
    const vetoConfirmClick = await clickLastButton(session, 'Veto', 'trade veto confirmation')
    const vetoed = await waitForTradeVetoed(fixture)
    debug = { ...debug, vetoClick, vetoConfirmClick, vetoed }
    if (vetoed.failures.length > 0) {
      throw new Error(`trade veto did not persist: ${vetoed.failures.join('; ')}`)
    }
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-veto-after.png')], { timeout: 60_000 })

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)

    const failures = [...vetoed.failures]
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
        observerMemberId: fixture.observer.id,
      },
      vetoed,
      notes,
      failures,
    }
    await writeFile(VETO_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser trade veto scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    const vetoed = await verifyTradeVetoed(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, vetoed, consoleOutput, errorOutput, networkOutput }
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
        observerMemberId: fixture.observer.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(VETO_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
    await fixture.dispose()
  }
}

export async function runBrowserTradeTerminalScenario({
  season = 0,
  sessionName = undefined,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const rejectFixture = await setupTradeAcceptGameplayFixture(env, season)
  const withdrawFixture = await setupTradeAcceptGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const rejectSession = sessionName
    ? `${safeName(sessionName)}-reject`
    : tradeSessionName('rj', rejectFixture.runId)
  const withdrawSession = sessionName
    ? `${safeName(sessionName)}-withdraw`
    : tradeSessionName('wd', withdrawFixture.runId)
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-terminal')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Reject session: ${rejectSession}`,
    `Withdraw session: ${withdrawSession}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(rejectSession, env, rejectFixture.users[1], rejectFixture.password)
    await browser(rejectSession, ['set', 'viewport', '390', '844']).catch(() => {})
    await openOffersTab(rejectSession, env)
    await assertPageText(
      rejectSession,
      [
        'Trades',
        'INCOMING',
        rejectFixture.proposer.team_name,
        rejectFixture.proposerPlayer.display_name,
        rejectFixture.recipientPlayer.display_name,
        'Reject',
      ],
      'trade reject before submit',
    )
    await browser(rejectSession, ['screenshot', path.join(artifactDir, 'trade-reject-before.png')], { timeout: 60_000 })
    const rejectClick = await clickButton(
      rejectSession,
      `Reject trade with ${rejectFixture.proposer.team_name}`,
      'trade reject button',
    )
    await browser(rejectSession, ['wait', '300'])
    const rejectConfirmClick = await clickLastButton(rejectSession, 'Reject', 'trade reject confirmation')
    debug = { ...debug, rejectClick, rejectConfirmClick }
    const rejected = await waitForTradeTerminalStatus(rejectFixture, 'rejected')
    if (rejected.failures.length > 0) {
      throw new Error(`trade reject did not persist: ${rejected.failures.join('; ')}`)
    }
    await browser(rejectSession, ['wait', '1000'])
    await browser(rejectSession, ['screenshot', path.join(artifactDir, 'trade-reject-after.png')], { timeout: 60_000 })

    await signInBrowser(withdrawSession, env, withdrawFixture.users[0], withdrawFixture.password)
    await browser(withdrawSession, ['set', 'viewport', '390', '844']).catch(() => {})
    await openOffersTab(withdrawSession, env)
    await assertPageText(
      withdrawSession,
      [
        'Trades',
        'OUTGOING',
        withdrawFixture.recipient.team_name,
        withdrawFixture.proposerPlayer.display_name,
        withdrawFixture.recipientPlayer.display_name,
        'Withdraw',
      ],
      'trade withdraw before submit',
    )
    await browser(withdrawSession, ['screenshot', path.join(artifactDir, 'trade-withdraw-before.png')], { timeout: 60_000 })
    const withdrawClick = await clickButton(
      withdrawSession,
      `Withdraw trade with ${withdrawFixture.recipient.team_name}`,
      'trade withdraw button',
    )
    await browser(withdrawSession, ['wait', '300'])
    const withdrawConfirmClick = await clickLastButton(withdrawSession, 'Withdraw', 'trade withdraw confirmation')
    debug = { ...debug, withdrawClick, withdrawConfirmClick }
    const withdrawn = await waitForTradeTerminalStatus(withdrawFixture, 'withdrawn')
    if (withdrawn.failures.length > 0) {
      throw new Error(`trade withdraw did not persist: ${withdrawn.failures.join('; ')}`)
    }
    await browser(withdrawSession, ['wait', '1000'])
    await browser(withdrawSession, ['screenshot', path.join(artifactDir, 'trade-withdraw-after.png')], { timeout: 60_000 })

    const [rejectConsole, rejectErrors, withdrawConsole, withdrawErrors] = await Promise.all([
      browser(rejectSession, ['console']).catch((error) => `console unavailable: ${error.message}`),
      browser(rejectSession, ['errors']).catch((error) => `errors unavailable: ${error.message}`),
      browser(withdrawSession, ['console']).catch((error) => `console unavailable: ${error.message}`),
      browser(withdrawSession, ['errors']).catch((error) => `errors unavailable: ${error.message}`),
    ])
    await writeFile(path.join(artifactDir, 'reject-console.txt'), `${rejectConsole}\n`)
    await writeFile(path.join(artifactDir, 'reject-errors.txt'), `${rejectErrors}\n`)
    await writeFile(path.join(artifactDir, 'withdraw-console.txt'), `${withdrawConsole}\n`)
    await writeFile(path.join(artifactDir, 'withdraw-errors.txt'), `${withdrawErrors}\n`)

    const failures = [...rejected.failures, ...withdrawn.failures]
    if (normalizeBrowserErrors(rejectErrors)) failures.push(`reject browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'reject-errors.txt'))}`)
    if (normalizeBrowserErrors(withdrawErrors)) failures.push(`withdraw browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'withdraw-errors.txt'))}`)
    const report = {
      status: failures.length === 0 ? 'PASS' : 'FAIL',
      season,
      artifactDir,
      fixtures: {
        rejectedTradeId: rejectFixture.trade.id,
        withdrawnTradeId: withdrawFixture.trade.id,
        rejectLeagueId: rejectFixture.league.id,
        withdrawLeagueId: withdrawFixture.league.id,
      },
      rejected,
      withdrawn,
      clicks: { rejectClick, withdrawClick },
      notes,
      failures,
    }
    await writeFile(TERMINAL_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser trade terminal scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(rejectSession, ['screenshot', path.join(artifactDir, 'reject-failure.png')], { timeout: 60_000 }).catch(() => {})
    await browser(withdrawSession, ['screenshot', path.join(artifactDir, 'withdraw-failure.png')], { timeout: 60_000 }).catch(() => {})
    const [rejectConsole, rejectErrors, rejectNetwork, withdrawConsole, withdrawErrors, withdrawNetwork] = await Promise.all([
      browser(rejectSession, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`),
      browser(rejectSession, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`),
      browser(rejectSession, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`),
      browser(withdrawSession, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`),
      browser(withdrawSession, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`),
      browser(withdrawSession, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`),
    ])
    await writeFile(path.join(artifactDir, 'reject-console.txt'), `${rejectConsole}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'reject-errors.txt'), `${rejectErrors}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'reject-network.txt'), `${rejectNetwork}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'withdraw-console.txt'), `${withdrawConsole}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'withdraw-errors.txt'), `${withdrawErrors}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'withdraw-network.txt'), `${withdrawNetwork}\n`).catch(() => {})
    const [rejected, withdrawn] = await Promise.all([
      verifyTradeTerminalStatus(rejectFixture, 'rejected').catch((verifyError) => ({
        failures: [`reject verify unavailable: ${verifyError.message}`],
      })),
      verifyTradeTerminalStatus(withdrawFixture, 'withdrawn').catch((verifyError) => ({
        failures: [`withdraw verify unavailable: ${verifyError.message}`],
      })),
    ])
    debug = { ...debug, rejected, withdrawn, rejectConsole, rejectErrors, rejectNetwork, withdrawConsole, withdrawErrors, withdrawNetwork }
    const report = {
      status: 'FAIL',
      season,
      artifactDir,
      fixtures: {
        rejectedTradeId: rejectFixture.trade.id,
        withdrawnTradeId: withdrawFixture.trade.id,
        rejectLeagueId: rejectFixture.league.id,
        withdrawLeagueId: withdrawFixture.league.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(TERMINAL_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(rejectSession, ['close']).catch(() => {})
    await browser(withdrawSession, ['close']).catch(() => {})
    await rejectFixture.dispose()
    await withdrawFixture.dispose()
  }
}
