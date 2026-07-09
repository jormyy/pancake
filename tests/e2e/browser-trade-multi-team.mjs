import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import {
  ROOT,
  ARTIFACT_ROOT,
  MULTI_TEAM_REPORT_PATH,
  assertPageText,
  browser,
  clickButton,
  installBrowserHooks,
  joinUrl,
  listSessions,
  openOffersTab,
  setupMultiTeamTradeGameplayFixture,
  signInBrowser,
  tradeSessionName,
} from './browser-trade-gameplay.mjs'

const verifyMultiTeamTradeProposal = async (fixture) => {
  const { data: trades, error: tradesError } = await fixture.admin
    .from('trades')
    .select('id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, notes, is_multi_team')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('proposer_member_id', fixture.proposer.id)
    .eq('is_multi_team', true)
    .eq('status', 'pending')
  if (tradesError) throw new Error(`multi-team trade verify: ${tradesError.message}`)

  const failures = []
  if ((trades ?? []).length !== 1) {
    failures.push(`multi-team pending trade rows=${(trades ?? []).length}; expected 1`)
  }
  const trade = trades?.[0] ?? null
  if (!trade) return { trade, items: [], participants: [], failures }

  const [itemsResult, participantsResult] = await Promise.all([
    fixture.admin
      .from('trade_items')
      .select('id, trade_id, side, player_id, pick_id, from_member_id, to_member_id, faab_amount')
      .eq('trade_id', trade.id),
    fixture.admin
      .from('trade_participants')
      .select('trade_id, member_id, sort_order, is_initiator, accepted_at')
      .eq('trade_id', trade.id)
      .order('sort_order', { ascending: true }),
  ])
  if (itemsResult.error) throw new Error(`multi-team trade item verify: ${itemsResult.error.message}`)
  if (participantsResult.error) throw new Error(`multi-team participant verify: ${participantsResult.error.message}`)

  const items = itemsResult.data ?? []
  const participants = participantsResult.data ?? []
  const participantIds = new Set(participants.map((participant) => participant.member_id))
  const expectedParticipantIds = [fixture.proposer.id, fixture.recipient.id, fixture.observer.id]
  const expectedRoutes = multiTeamExpectedRoutes(fixture)

  if (trade.recipient_member_id !== fixture.recipient.id) {
    failures.push(`multi-team recipient_member_id=${trade.recipient_member_id}; expected first selected recipient ${fixture.recipient.id}`)
  }
  if (participants.length !== expectedParticipantIds.length) {
    failures.push(`trade_participants rows=${participants.length}; expected ${expectedParticipantIds.length}`)
  }
  for (const memberId of expectedParticipantIds) {
    if (!participantIds.has(memberId)) failures.push(`missing trade_participants row for ${memberId}`)
  }
  const proposerParticipant = participants.find((participant) => participant.member_id === fixture.proposer.id)
  if (!proposerParticipant?.is_initiator) failures.push('proposer participant is not marked as initiator')
  if (!proposerParticipant?.accepted_at) failures.push('proposer participant was not auto-accepted for no-drop proposal')

  if (items.length !== expectedRoutes.size) failures.push(`trade_items rows=${items.length}; expected ${expectedRoutes.size}`)
  for (const [playerId, expected] of expectedRoutes) {
    const item = items.find((row) => row.player_id === playerId)
    if (!item) {
      failures.push(`missing routed player item ${playerId}`)
      continue
    }
    if (item.from_member_id !== expected.from || item.to_member_id !== expected.to) {
      failures.push(`player ${playerId} route=${item.from_member_id}->${item.to_member_id}; expected ${expected.from}->${expected.to}`)
    }
    if (item.pick_id != null) failures.push(`player ${playerId} item unexpectedly has pick_id=${item.pick_id}`)
    if (item.faab_amount !== 0) failures.push(`player ${playerId} item unexpectedly has faab_amount=${item.faab_amount}`)
  }

  return { trade, items, participants, failures }
}

const waitForMultiTeamTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyMultiTeamTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyMultiTeamTradeProposal(fixture)
  }
  return last
}

const multiTeamExpectedRoutes = (fixture) => new Map([
  [fixture.proposerPlayer.id, { from: fixture.proposer.id, to: fixture.observer.id }],
  [fixture.recipientPlayer.id, { from: fixture.recipient.id, to: fixture.observer.id }],
  [fixture.observerPlayer.id, { from: fixture.observer.id, to: fixture.proposer.id }],
])

const verifyMultiTeamReplacement = async (fixture, sourceTradeId, {
  sourceStatus,
  sourceColumn,
  expectedProposerId,
  expectedRecipientId,
  expectedVersion,
}) => {
  const { data: source, error: sourceError } = await fixture.admin
    .from('trades')
    .select('id, status, replaced_by_trade_id')
    .eq('id', sourceTradeId)
    .single()
  if (sourceError) throw new Error(`multi-team replacement source lookup: ${sourceError.message}`)

  const failures = []
  if (source.status !== sourceStatus) {
    failures.push(`source trade status=${source.status}; expected ${sourceStatus}`)
  }
  if (!source.replaced_by_trade_id) {
    failures.push('source trade missing replaced_by_trade_id')
    return { source, replacement: null, items: [], participants: [], failures }
  }

  const { data: replacement, error: replacementError } = await fixture.admin
    .from('trades')
    .select('id, status, proposer_member_id, recipient_member_id, is_multi_team, parent_trade_id, countered_from_trade_id, edited_from_trade_id, version')
    .eq('id', source.replaced_by_trade_id)
    .single()
  if (replacementError) throw new Error(`multi-team replacement lookup: ${replacementError.message}`)

  const [itemsResult, participantsResult] = await Promise.all([
    fixture.admin
      .from('trade_items')
      .select('id, trade_id, side, player_id, pick_id, from_member_id, to_member_id, faab_amount')
      .eq('trade_id', replacement.id),
    fixture.admin
      .from('trade_participants')
      .select('trade_id, member_id, sort_order, is_initiator, accepted_at')
      .eq('trade_id', replacement.id)
      .order('sort_order', { ascending: true }),
  ])
  if (itemsResult.error) throw new Error(`multi-team replacement item lookup: ${itemsResult.error.message}`)
  if (participantsResult.error) throw new Error(`multi-team replacement participant lookup: ${participantsResult.error.message}`)

  const items = itemsResult.data ?? []
  const participants = participantsResult.data ?? []
  const participantIds = new Set(participants.map((participant) => participant.member_id))
  const expectedParticipantIds = [fixture.proposer.id, fixture.recipient.id, fixture.observer.id]
  const expectedRoutes = multiTeamExpectedRoutes(fixture)

  if (replacement.status !== 'pending') failures.push(`replacement status=${replacement.status}; expected pending`)
  if (!replacement.is_multi_team) failures.push('replacement is not marked multi-team')
  if (replacement.proposer_member_id !== expectedProposerId) {
    failures.push(`replacement proposer=${replacement.proposer_member_id}; expected ${expectedProposerId}`)
  }
  if (replacement.recipient_member_id !== expectedRecipientId) {
    failures.push(`replacement recipient=${replacement.recipient_member_id}; expected ${expectedRecipientId}`)
  }
  if (replacement.version !== expectedVersion) {
    failures.push(`replacement version=${replacement.version}; expected ${expectedVersion}`)
  }
  if (replacement.parent_trade_id !== fixture.initialMultiTeamTradeId) {
    failures.push(`replacement parent=${replacement.parent_trade_id}; expected ${fixture.initialMultiTeamTradeId}`)
  }
  if (replacement[sourceColumn] !== sourceTradeId) {
    failures.push(`replacement ${sourceColumn}=${replacement[sourceColumn]}; expected ${sourceTradeId}`)
  }
  if (participants.length !== expectedParticipantIds.length) {
    failures.push(`replacement participants rows=${participants.length}; expected ${expectedParticipantIds.length}`)
  }
  for (const memberId of expectedParticipantIds) {
    if (!participantIds.has(memberId)) failures.push(`replacement missing participant ${memberId}`)
  }
  const proposerParticipant = participants.find((participant) => participant.member_id === expectedProposerId)
  if (!proposerParticipant?.is_initiator) failures.push('replacement proposer is not initiator')
  if (!proposerParticipant?.accepted_at) failures.push('replacement proposer was not auto-accepted')

  if (items.length !== expectedRoutes.size) failures.push(`replacement items rows=${items.length}; expected ${expectedRoutes.size}`)
  for (const [playerId, expected] of expectedRoutes) {
    const item = items.find((row) => row.player_id === playerId)
    if (!item) {
      failures.push(`replacement missing routed player item ${playerId}`)
      continue
    }
    if (item.from_member_id !== expected.from || item.to_member_id !== expected.to) {
      failures.push(`replacement player ${playerId} route=${item.from_member_id}->${item.to_member_id}; expected ${expected.from}->${expected.to}`)
    }
  }

  return { source, replacement, items, participants, failures }
}

const waitForMultiTeamReplacement = async (fixture, sourceTradeId, options, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyMultiTeamReplacement(fixture, sourceTradeId, options)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyMultiTeamReplacement(fixture, sourceTradeId, options)
  }
  return last
}

export async function runBrowserMultiTeamTradeScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupMultiTeamTradeGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? tradeSessionName('mt', fixture.runId)
  const counterSession = `${session}-counter`
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`, 'browser-trade-multi-team')
  await mkdir(artifactDir, { recursive: true })

  const notes = [
    `Frontend: ${describeEndpoint(env.frontendUrl)}`,
    `Session: ${session}`,
    `Proposer: ${fixture.users[0].email}`,
    `Recipient member: ${fixture.recipient.id}`,
    `Observer member: ${fixture.observer.id}`,
    sessionList,
  ]
  let debug = {}

  try {
    await signInBrowser(session, env, fixture.users[0], fixture.password)
    await browser(session, ['set', 'viewport', '1180', '900'])
    await browser(session, ['open', joinUrl(env.frontendUrl, '/propose-trade')])
    await installBrowserHooks(session, env)
    await browser(session, ['wait', '2500'])
    await assertPageText(
      session,
      [
        'Propose Trade',
        '2-Team',
        'Multi-Team',
        fixture.recipient.team_name,
        fixture.observer.team_name,
      ],
      'multi-team trade proposal initial screen',
    )

    const modeClick = await clickButton(session, 'Use multi-team trade mode', 'multi-team mode toggle')
    const recipientClick = await clickButton(
      session,
      `Trade with ${fixture.recipient.team_name}`,
      'multi-team recipient team selection',
    )
    const observerClick = await clickButton(
      session,
      `Trade with ${fixture.observer.team_name}`,
      'multi-team third team selection',
    )
    await browser(session, ['wait', '4500'])
    await assertPageText(
      session,
      [
      'DEAL OVERVIEW',
      'YOU SEND',
        `${fixture.recipient.team_name.toUpperCase()} SENDS`,
        `${fixture.observer.team_name.toUpperCase()} SENDS`,
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        fixture.observerPlayer.display_name,
      ],
      'multi-team trade builder loaded',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-builder.png')], { timeout: 60_000 })

    await browser(session, ['set', 'viewport', '390', '844'])
    await browser(session, ['wait', '500'])
    await assertPageText(
      session,
      ['DEAL OVERVIEW', 'You send', `${fixture.recipient.team_name} sends`, `${fixture.observer.team_name} sends`],
      'mobile multi-team sender tabs',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-builder-mobile.png')], { timeout: 60_000 })

    const recipientTabClick = await clickButton(
      session,
      `Edit assets sent by ${fixture.recipient.team_name}`,
      'mobile recipient sender tab',
    )

    const routeClick = await clickButton(
      session,
      `${fixture.recipient.team_name} sends selected assets to ${fixture.observer.team_name}`,
      'multi-team recipient route selection',
    )
    const proposerTabClick = await clickButton(
      session,
      'Edit assets sent by you',
      'mobile proposer sender tab',
    )
    const proposerPlayerClick = await clickButton(
      session,
      `Select ${fixture.proposerPlayer.display_name} for trade`,
      'multi-team proposer player selection',
    )
    await clickButton(
      session,
      `Edit assets sent by ${fixture.recipient.team_name}`,
      'mobile recipient sender tab after proposer selection',
    )
    const recipientPlayerClick = await clickButton(
      session,
      `Select ${fixture.recipientPlayer.display_name} for trade`,
      'multi-team recipient player selection',
    )
    const observerTabClick = await clickButton(
      session,
      `Edit assets sent by ${fixture.observer.team_name}`,
      'mobile observer sender tab',
    )
    const observerPlayerClick = await clickButton(
      session,
      `Select ${fixture.observerPlayer.display_name} for trade`,
      'multi-team observer player selection',
    )
    await clickButton(
      session,
      'Edit assets sent by you',
      'mobile proposer sender tab for route override',
    )
    const proposerPlayerRouteClick = await clickButton(
      session,
      `Route ${fixture.proposerPlayer.display_name} to ${fixture.observer.team_name}`,
      'multi-team proposer player per-asset route selection',
    )
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-selected.png')], { timeout: 60_000 })
    const submitClick = await clickButton(session, 'Send trade proposal', 'multi-team trade proposal submit')
    const tradeProposal = await waitForMultiTeamTradeProposal(fixture)
    debug = {
      ...debug,
      modeClick,
      recipientClick,
      observerClick,
      recipientTabClick,
      proposerTabClick,
      observerTabClick,
      routeClick,
      proposerPlayerClick,
      recipientPlayerClick,
      observerPlayerClick,
      proposerPlayerRouteClick,
      submitClick,
      tradeProposal,
    }
    if (tradeProposal.failures.length > 0) {
      throw new Error(`multi-team trade proposal did not persist: ${tradeProposal.failures.join('; ')}`)
    }
    fixture.initialMultiTeamTradeId = tradeProposal.trade.id
    await browser(session, ['wait', '1000'])
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-after-submit.png')], { timeout: 60_000 })

    await openOffersTab(session, env)
    await assertPageText(
      session,
      [
        'DEAL OVERVIEW',
        fixture.recipient.team_name,
        fixture.observer.team_name,
        'RECEIVES',
        'Accepted',
        'Waiting',
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        fixture.observerPlayer.display_name,
      ],
      'mobile multi-team offer overview',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-offer-mobile.png')], { timeout: 60_000 })

    await browser(session, ['open', joinUrl(env.frontendUrl, `/propose-trade?editTradeId=${tradeProposal.trade.id}`)])
    await installBrowserHooks(session, env)
    await browser(session, ['wait', '4500'])
    await assertPageText(
      session,
      [
        'Edit Trade',
        'DEAL OVERVIEW',
        'SELECTED ROUTES',
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        fixture.observerPlayer.display_name,
      ],
      'multi-team edit composer prefilled',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-edit-prefill.png')], { timeout: 60_000 })
    const editSubmitClick = await clickButton(session, 'Send trade proposal', 'multi-team edit submit')
    const editReplacement = await waitForMultiTeamReplacement(fixture, tradeProposal.trade.id, {
      sourceStatus: 'edited',
      sourceColumn: 'edited_from_trade_id',
      expectedProposerId: fixture.proposer.id,
      expectedRecipientId: fixture.recipient.id,
      expectedVersion: 2,
    })
    if (editReplacement.failures.length > 0) {
      throw new Error(`multi-team trade edit replacement failed: ${editReplacement.failures.join('; ')}`)
    }

    await signInBrowser(counterSession, env, fixture.users[1], fixture.password)
    await browser(counterSession, ['set', 'viewport', '1180', '900'])
    await browser(counterSession, ['open', joinUrl(env.frontendUrl, `/propose-trade?counterTradeId=${editReplacement.replacement.id}`)])
    await installBrowserHooks(counterSession, env)
    await browser(counterSession, ['wait', '4500'])
    await assertPageText(
      counterSession,
      [
        'Counter Trade',
        'DEAL OVERVIEW',
        'SELECTED ROUTES',
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        fixture.observerPlayer.display_name,
      ],
      'multi-team counter composer prefilled',
    )
    await browser(counterSession, ['screenshot', path.join(artifactDir, 'multi-team-counter-prefill.png')], { timeout: 60_000 })
    const counterSubmitClick = await clickButton(counterSession, 'Send trade proposal', 'multi-team counter submit')
    const counterReplacement = await waitForMultiTeamReplacement(fixture, editReplacement.replacement.id, {
      sourceStatus: 'countered',
      sourceColumn: 'countered_from_trade_id',
      expectedProposerId: fixture.recipient.id,
      expectedRecipientId: fixture.proposer.id,
      expectedVersion: 3,
    })
    if (counterReplacement.failures.length > 0) {
      throw new Error(`multi-team trade counter replacement failed: ${counterReplacement.failures.join('; ')}`)
    }

    const consoleOutput = await browser(session, ['console']).catch((error) => `console unavailable: ${error.message}`)
    const errorOutput = await browser(session, ['errors']).catch((error) => `errors unavailable: ${error.message}`)
    const counterConsoleOutput = await browser(counterSession, ['console']).catch((error) => `counter console unavailable: ${error.message}`)
    const counterErrorOutput = await browser(counterSession, ['errors']).catch((error) => `counter errors unavailable: ${error.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`)
    await writeFile(path.join(artifactDir, 'counter-console.txt'), `${counterConsoleOutput}\n`)
    await writeFile(path.join(artifactDir, 'counter-errors.txt'), `${counterErrorOutput}\n`)

    const failures = [...tradeProposal.failures]
    if (normalizeBrowserErrors(errorOutput)) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
    if (normalizeBrowserErrors(counterErrorOutput)) failures.push(`counter browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'counter-errors.txt'))}`)
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
        observerMemberId: fixture.observer.id,
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
        observerPlayerId: fixture.observerPlayer.id,
      },
      tradeProposal,
      editSubmitClick,
      editReplacement,
      counterSubmitClick,
      counterReplacement,
      notes,
      failures,
    }
    await writeFile(MULTI_TEAM_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`)
    await writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`)
    if (failures.length > 0) throw new Error(`Browser multi-team trade scenario failed: ${failures.join('; ')}`)
    return report
  } catch (error) {
    await browser(session, ['screenshot', path.join(artifactDir, 'failure.png')], { timeout: 60_000 }).catch(() => {})
    await browser(counterSession, ['screenshot', path.join(artifactDir, 'counter-failure.png')], { timeout: 60_000 }).catch(() => {})
    const consoleOutput = await browser(session, ['console']).catch((consoleError) => `console unavailable: ${consoleError.message}`)
    const errorOutput = await browser(session, ['errors']).catch((errorError) => `errors unavailable: ${errorError.message}`)
    const networkOutput = await browser(session, ['network', 'requests']).catch((networkError) => `network unavailable: ${networkError.message}`)
    const counterConsoleOutput = await browser(counterSession, ['console']).catch((consoleError) => `counter console unavailable: ${consoleError.message}`)
    const counterErrorOutput = await browser(counterSession, ['errors']).catch((errorError) => `counter errors unavailable: ${errorError.message}`)
    const counterNetworkOutput = await browser(counterSession, ['network', 'requests']).catch((networkError) => `counter network unavailable: ${networkError.message}`)
    await writeFile(path.join(artifactDir, 'console.txt'), `${consoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'errors.txt'), `${errorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'network.txt'), `${networkOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'counter-console.txt'), `${counterConsoleOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'counter-errors.txt'), `${counterErrorOutput}\n`).catch(() => {})
    await writeFile(path.join(artifactDir, 'counter-network.txt'), `${counterNetworkOutput}\n`).catch(() => {})
    const tradeProposal = await verifyMultiTeamTradeProposal(fixture).catch((verifyError) => ({
      failures: [`verify unavailable: ${verifyError.message}`],
    }))
    debug = { ...debug, tradeProposal, consoleOutput, errorOutput, networkOutput, counterConsoleOutput, counterErrorOutput, counterNetworkOutput }
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
        observerMemberId: fixture.observer.id,
        proposerPlayerId: fixture.proposerPlayer.id,
        recipientPlayerId: fixture.recipientPlayer.id,
        observerPlayerId: fixture.observerPlayer.id,
      },
      error: error instanceof Error ? error.message : String(error),
      debug,
      notes,
    }
    await writeFile(MULTI_TEAM_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`).catch(() => {})
    throw error
  } finally {
    await browser(session, ['close']).catch(() => {})
    await browser(counterSession, ['close']).catch(() => {})
  }
}
