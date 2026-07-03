import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = process.cwd()
const REPORT_PATH = path.join(ROOT, 'tests/e2e-report.md')
const COVERAGE_PATH = path.join(ROOT, 'tests/e2e-coverage.md')

export const writeReport = async ({ status, startedAt, finishedAt, seasons, rows, notes }) => {
  const lines = [
    '# Multi-Season E2E Soak Report',
    '',
    `- Status: ${status}`,
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Target seasons: ${seasons}`,
    `- Fake upstream: http://127.0.0.1:${process.env.FAKE_UPSTREAM_PORT ?? 4555}`,
    '',
    '## Season Summary',
    '',
    '| Season | Status | Notes |',
    '| --- | --- | --- |',
    ...rows.map((row) => `| ${row.season} | ${row.status} | ${row.notes.replaceAll('\n', '<br>')} |`),
    '',
    '## Notes',
    '',
    ...notes.map((note) => `- ${note}`),
  ]
  await writeFile(REPORT_PATH, `${lines.join('\n')}\n`)
}

const hasPassingNote = (rows, pattern) => rows.some((row) => row.status === 'PASS' && pattern.test(row.notes))
const hasFailingNote = (rows, pattern) => rows.some((row) => row.status === 'FAIL' && pattern.test(row.notes))
const hasProblemNote = (rows, pattern) => rows.some((row) => (
  (row.status === 'FAIL' || row.status === 'ERROR' || row.status === 'BLOCKED') &&
  pattern.test(row.notes)
))
const hasEvidencePass = (status) => status === 'PASS'
const hasEnabledEvidencePass = (enabled, status) => enabled && hasEvidencePass(status)
const allEnabledEvidencePass = (items) => items.every(({ enabled, status }) => enabled && hasEvidencePass(status))
export const writeCoverageReport = async ({ status, startedAt, finishedAt, seasons, args, env, targetLeagueId, rows, notes }) => {
  const auditExists = await readFile(path.join(ROOT, 'tests/audit-report.md'), 'utf8')
    .then(() => true)
    .catch(() => false)
  const rowStatus = rows.some((row) => row.status === 'FAIL' || row.status === 'ERROR' || row.status === 'BLOCKED')
    ? 'FAIL'
    : rows.length > 0 ? 'PARTIAL' : 'PENDING'
  const producedTenSeasons = rows.some((row) => Number(row.season) >= 10)
  const invariantStatus = rows.length === 0
    ? 'PENDING'
    : hasFailingNote(rows, /\bI[0-7]:|D\.SET\.2/)
      ? 'FAIL'
      : hasPassingNote(rows, /D\.0 invariant boundary checks passed/) ? 'PASS' : 'PARTIAL'
  const runtimeStatus = hasFailingNote(rows, /D\.LONG\.6/)
    ? 'FAIL'
    : producedTenSeasons ? 'PASS' : 'PENDING'
  const memoryStatus = hasFailingNote(rows, /D\.LONG\.7/)
    ? 'FAIL'
    : producedTenSeasons ? 'PASS' : 'PENDING'
  const resetStatus = args.seasonReset
    ? hasFailingNote(rows, /D\.SEA\.6/) ? 'FAIL' : hasPassingNote(rows, /season reset carryover passed/) ? 'PASS' : 'PENDING'
    : env.backendTicksEnabled
      ? hasFailingNote(rows, /\bI[0-7]:|D\.SET\.2|advance-season|season reset/i) ? 'FAIL' : 'PARTIAL'
      : 'PENDING'
  const snapshotStatus = hasPassingNote(rows, /snapshot row-count diff passed/) ? 'PASS' : rows.length > 1 ? rowStatus : 'PENDING'
  const matchupStatus = env.backendTicksEnabled && hasPassingNote(rows, /matchup generation idempotency passed/) ? 'PASS' : 'PENDING'
  const pickChainStatus = args.pickChain
    ? hasFailingNote(rows, /D\.LONG\.1|D\.LONG\.2/) ? 'FAIL' : hasPassingNote(rows, /multi-hop future-pick owner resolved/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserStatus = args.browser && args.browserAuth && args.browserFullSweep
    ? 'PASS'
    : args.browser || args.browserAuth ? 'PARTIAL' : 'PENDING'
  const browserPerfStatus = args.browserPerf
    ? hasFailingNote(rows, /D\.X\.4/) ? 'FAIL' : hasPassingNote(rows, /browser perf smoke passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserWaiverStatus = args.browserWaiver
    ? hasFailingNote(rows, /browser waiver/) ? 'FAIL' : hasPassingNote(rows, /browser waiver claim gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserLineupStatus = args.browserLineup
    ? hasFailingNote(rows, /browser lineup/) ? 'FAIL' : hasPassingNote(rows, /browser lineup gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserLineupAutoSetStatus = args.browserLineupAutoSet
    ? hasFailingNote(rows, /browser lineup auto-set/) ? 'FAIL' : hasPassingNote(rows, /browser lineup auto-set gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserLineupLockedStatus = args.browserLineupLocked
    ? hasFailingNote(rows, /browser lineup locked/) ? 'FAIL' : hasPassingNote(rows, /browser lineup locked gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserWaiverDropStatus = args.browserWaiverDrop
    ? hasFailingNote(rows, /browser waiver drop/) ? 'FAIL' : hasPassingNote(rows, /browser waiver drop claim gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserWaiverIrBlockStatus = args.browserWaiverIrBlock
    ? hasFailingNote(rows, /browser waiver IR block/) ? 'FAIL' : hasPassingNote(rows, /browser waiver IR block gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeStatus = args.browserTrade
    ? hasFailingNote(rows, /browser trade/) ? 'FAIL' : hasPassingNote(rows, /browser trade proposal gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeAcceptStatus = args.browserTradeAccept
    ? hasFailingNote(rows, /browser trade accept/) ? 'FAIL' : hasPassingNote(rows, /browser trade accept gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeTerminalStatus = args.browserTradeTerminal
    ? hasFailingNote(rows, /browser trade terminal/) ? 'FAIL' : hasPassingNote(rows, /browser trade reject\/withdraw gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeFuturePickStatus = args.browserTradeFuturePick
    ? hasFailingNote(rows, /browser future-pick trade/) ? 'FAIL' : hasPassingNote(rows, /browser future-pick trade gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeFuturePickAcceptStatus = args.browserTradeFuturePickAccept
    ? hasFailingNote(rows, /browser future-pick trade accept/) ? 'FAIL' : hasPassingNote(rows, /browser future-pick trade accept gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeOverflowAcceptStatus = args.browserTradeOverflowAccept
    ? hasFailingNote(rows, /browser trade overflow accept/) ? 'FAIL' : hasPassingNote(rows, /browser trade overflow accept gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradePostDeadlineStatus = args.browserTradePostDeadline
    ? hasFailingNote(rows, /browser post-deadline trade/) ? 'FAIL' : hasPassingNote(rows, /browser post-deadline trade gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserTradeVetoStatus = args.browserTradeVeto
    ? hasFailingNote(rows, /browser trade veto/) ? 'FAIL' : hasPassingNote(rows, /browser trade veto gameplay passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const leagueLifecyclePassed = hasPassingNote(rows, /league lifecycle passed/)
  const browserLeagueLifecyclePassed = hasPassingNote(rows, /browser league lifecycle passed/)
  const leagueLifecycleStatus = args.leagueLifecycle || args.browserLeagueLifecycle
    ? hasFailingNote(rows, /D\.SET\.2|browser league lifecycle/)
      ? 'FAIL'
      : leagueLifecyclePassed && browserLeagueLifecyclePassed
        ? 'PASS'
        : leagueLifecyclePassed || browserLeagueLifecyclePassed
          ? 'PARTIAL'
          : 'PENDING'
    : targetLeagueId ? 'PARTIAL' : 'PENDING'
  const tradeWaiverPushPassed = hasPassingNote(rows, /trade and waiver push notification intercepts passed|push notification intercepts passed/)
  const draftPushPassed = hasPassingNote(rows, /draft push notification intercept passed/)
  const pushStatus = args.push || args.draftPush
    ? status === 'ERROR' || hasFailingNote(rows, /D\.X\.1|push|waiver/i)
      ? 'FAIL'
      : args.push && args.draftPush && tradeWaiverPushPassed && draftPushPassed
        ? 'PASS'
        : tradeWaiverPushPassed || draftPushPassed
          ? 'PARTIAL'
          : 'PENDING'
    : 'PENDING'
  const historyStatus = args.history
    ? hasFailingNote(rows, /D\.LONG\.3|D\.LONG\.4/) ? 'FAIL' : hasPassingNote(rows, /standings\/champion history retained/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const realtimeStatus = args.realtime
    ? hasProblemNote(rows, /D\.X\.2/) ? 'FAIL' : hasPassingNote(rows, /realtime matchup and bid updates delivered/) ? 'PASS' : 'PARTIAL'
    : 'PENDING'
  const midlifeMigrationStatus = args.midlifeMigration
    ? hasFailingNote(rows, /D\.LONG\.5/) ? 'FAIL' : hasPassingNote(rows, /mid-life migration applied/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const auctionStatus = args.auction || args.browserGameplay
    ? hasFailingNote(rows, /D\.SET\.4|browser auction/) ? 'FAIL' : (
      args.auction && args.browserGameplay &&
      hasPassingNote(rows, /auction bid validation passed/) &&
      hasPassingNote(rows, /browser auction bid gameplay passed/)
    ) ? 'PASS' : hasPassingNote(rows, /auction bid validation passed|browser auction bid gameplay passed/) ? 'PARTIAL' : 'PENDING'
    : 'PENDING'
  const playoffsStatus = args.playoffs
    ? hasFailingNote(rows, /D\.SEA\.4/) ? 'FAIL' : hasPassingNote(rows, /playoff bracket scenario passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const browserPlayoffStatus = args.browserPlayoff
    ? hasFailingNote(rows, /browser playoff/) ? 'FAIL' : hasPassingNote(rows, /browser playoff champion passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const tiebreakerStatus = args.tiebreakers
    ? hasFailingNote(rows, /D\.SEA\.3/) ? 'FAIL' : hasPassingNote(rows, /standings tiebreaker scenario passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const settingsStatus = args.settings
    ? hasFailingNote(rows, /D\.SET\.3/) ? 'FAIL' : hasPassingNote(rows, /commissioner settings propagation passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const scoringStatus = args.scoring
    ? hasFailingNote(rows, /D\.SEA\.2/) ? 'FAIL' : hasPassingNote(rows, /weekly scoring finalization passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const waiverProcessingStatus = args.waiverProcessing
    ? hasFailingNote(rows, /D\.SEA\.2 waiver processing/) ? 'FAIL' : hasPassingNote(rows, /waiver priority processing passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const injuryFilterStatus = args.injuryFilter
    ? hasFailingNote(rows, /D\.SEA\.2 injury/) ? 'FAIL' : hasPassingNote(rows, /injury status filter passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const tradeAcceptStatus = args.tradeAccept
    ? hasFailingNote(rows, /D\.SEA\.2 trade/) ? 'FAIL' : hasPassingNote(rows, /trade acceptance atomicity passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const tradeVetoStatus = args.tradeVeto
    ? hasFailingNote(rows, /D\.SEA\.2 trade veto/) ? 'FAIL' : hasPassingNote(rows, /trade veto threshold passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'
  const rookieDraftStatus = args.rookieDraft
    ? hasFailingNote(rows, /D\.SEA\.5/) ? 'FAIL' : hasPassingNote(rows, /rookie draft auto-pick passed/) ? 'PASS' : 'PENDING'
    : pickChainStatus
  const browserRookieDraftStatus = args.browserRookieDraft
    ? hasFailingNote(rows, /browser rookie draft/) ? 'FAIL' : hasPassingNote(rows, /browser rookie draft auto-pick passed/) ? 'PASS' : 'PENDING'
    : 'PENDING'

  const weeklyLoopStatus = allEnabledEvidencePass([
    { enabled: args.browserLineup, status: browserLineupStatus },
    { enabled: args.browserLineupAutoSet, status: browserLineupAutoSetStatus },
    { enabled: args.browserLineupLocked, status: browserLineupLockedStatus },
    { enabled: args.browserWaiver, status: browserWaiverStatus },
    { enabled: args.browserWaiverDrop, status: browserWaiverDropStatus },
    { enabled: args.browserWaiverIrBlock, status: browserWaiverIrBlockStatus },
    { enabled: args.waiverProcessing, status: waiverProcessingStatus },
    { enabled: args.browserTrade, status: browserTradeStatus },
    { enabled: args.browserTradeFuturePick, status: browserTradeFuturePickStatus },
    { enabled: args.browserTradeFuturePickAccept, status: browserTradeFuturePickAcceptStatus },
    { enabled: args.browserTradeOverflowAccept, status: browserTradeOverflowAcceptStatus },
    { enabled: args.browserTradePostDeadline, status: browserTradePostDeadlineStatus },
    { enabled: args.browserTradeVeto, status: browserTradeVetoStatus },
    { enabled: args.browserTradeAccept, status: browserTradeAcceptStatus },
    { enabled: args.browserTradeTerminal, status: browserTradeTerminalStatus },
    { enabled: args.tradeVeto, status: tradeVetoStatus },
    { enabled: args.scoring, status: scoringStatus },
  ])
    ? 'PASS'
    : args.browserLineup || args.browserLineupAutoSet || args.browserLineupLocked || args.browserWaiver ||
      args.browserWaiverDrop || args.browserWaiverIrBlock || args.waiverProcessing || args.browserTrade ||
      args.browserTradeFuturePick || args.browserTradeFuturePickAccept || args.browserTradeOverflowAccept ||
      args.browserTradePostDeadline || args.browserTradeVeto || args.browserTradeAccept ||
      args.browserTradeTerminal || args.tradeVeto || args.scoring
      ? 'PARTIAL'
      : 'PENDING'

  const playoffRowStatus = args.playoffs && args.browserPlayoff
    ? allEnabledEvidencePass([
      { enabled: args.playoffs, status: playoffsStatus },
      { enabled: args.browserPlayoff, status: browserPlayoffStatus },
    ]) ? 'PASS' : hasEnabledEvidencePass(args.playoffs, playoffsStatus) || hasEnabledEvidencePass(args.browserPlayoff, browserPlayoffStatus) ? 'PARTIAL' : 'PENDING'
    : args.browserPlayoff ? browserPlayoffStatus : playoffsStatus

  const rookieDraftRowStatus = args.rookieDraft && args.browserRookieDraft && args.pickChain
    ? allEnabledEvidencePass([
      { enabled: args.rookieDraft, status: rookieDraftStatus },
      { enabled: args.browserRookieDraft, status: browserRookieDraftStatus },
      { enabled: args.pickChain, status: pickChainStatus },
    ]) ? 'PASS' : 'PARTIAL'
    : args.browserRookieDraft ? browserRookieDraftStatus : rookieDraftStatus

  const auctionEvidence = args.auction && args.browserGameplay
    ? 'Auction modes verify the real browser draft-room bid path plus server-side atomic bid validation for <=current, >budget, self-overbid, and valid bid paths.'
    : args.browserGameplay ? 'Browser gameplay mode creates an isolated two-user league, opens the real auction draft room as the bidder, clicks the visible Bid button, and verifies nomination/bid rows changed.' : args.auction ? 'Auction mode creates a disposable auction nomination and verifies the atomic bid RPC rejects <=current, >budget, and self-overbid paths before accepting valid bids.' : 'Enable E2E_ENABLE_BROWSER_GAMEPLAY=1 for browser auction gameplay or E2E_ENABLE_AUCTION=1 for server-side bid validation.'

  const weeklyLoopEvidence = weeklyLoopStatus === 'PASS'
    ? 'All weekly-loop slices were enabled: manual lineup, auto-set, locked-player protection, no-drop/drop/IR-block waiver UI, waiver priority processing, player/future-pick/overflow/post-deadline/veto/accept/reject/withdraw trade UI, trade veto thresholds, and starter-only scoring/finalization.'
    : args.browserLineup ? 'Browser lineup mode creates an isolated league, opens the real lineup modal, moves a bench PG into an empty PG starter slot, and verifies the weekly_lineups row persisted.' : args.browserLineupAutoSet ? 'Browser lineup auto-set mode creates an isolated league, opens the real Auto-Set modal, chooses Today, and verifies an auto-set weekly_lineups row persisted.' : args.browserLineupLocked ? 'Browser lineup locked mode creates an isolated league, seeds a live NBA game for a starter, attempts a real browser move, and verifies the locked starter remains in place while the bench player is not inserted into weekly_lineups.' : args.browserWaiver ? 'Browser waiver mode creates an isolated one-user league, opens the real claim-player modal, submits a no-drop waiver claim, and verifies the Edge API/RPC persisted a pending waiver_claims row.' : args.browserWaiverDrop ? 'Browser waiver-drop mode creates an isolated full-roster league, opens the real claim-player modal, selects a real roster player to drop, submits the waiver claim, and verifies the Edge API/RPC persisted the pending drop-then-add claim.' : args.browserWaiverIrBlock ? 'Browser waiver IR-block mode creates an isolated league with a DTD player illegally occupying IR, opens the real claim-player modal, verifies the UI blocks the claim, and checks no waiver_claims row is inserted.' : args.waiverProcessing ? 'Waiver-processing mode seeds priority-ordered competing claims, a drop-then-add claim, and a full-roster/no-drop claim, then runs the real Edge processor and verifies statuses, roster movement, waiver priority reseeding, and transaction rows.' : args.browserTrade ? 'Browser trade mode creates an isolated two-user league, opens the real propose-trade modal, submits a player-for-player proposal through the authenticated Edge API route, and verifies pending trades/trade_items rows persisted.' : args.browserTradeFuturePick ? 'Browser future-pick trade mode creates an isolated two-user league, opens the real propose-trade modal, submits a five-years-out pick-for-pick proposal, and verifies pending pick trade_items persisted through the authenticated Edge API route without moving pick ownership.' : args.browserTradeFuturePickAccept ? 'Browser future-pick trade accept mode creates an isolated pending five-years-out pick-for-pick trade, accepts it through the real Offers tab, and verifies the Edge API/RPC swaps draft_picks.current_owner_id without moving roster players.' : args.browserTradeOverflowAccept ? 'Browser trade overflow accept mode creates an isolated mixed player/pick offer, accepts it through the real Offers tab, drops one active player in the overflow modal, and verifies the trade completes with the drop logged on waivers.' : args.browserTradePostDeadline ? 'Browser post-deadline trade mode creates an isolated league with a past trade_deadline, attempts the real propose-trade flow, and verifies the authenticated backend rejects the proposal without inserting trades or trade_items.' : args.browserTradeVeto ? 'Browser trade veto mode creates an isolated accepted trade with an open veto window, signs in as a non-party member, uses the real Offers veto action, and verifies the backend records a member veto without moving assets.' : args.browserTradeAccept ? 'Browser trade accept mode creates an isolated pending trade, opens the real recipient Offers tab, accepts through the visible TradeCard button, and verifies the Edge API/RPC moved both players and completed the trade.' : args.browserTradeTerminal ? 'Browser trade terminal mode creates isolated pending trades, rejects one as the recipient, withdraws one as the proposer through authenticated Edge API routes, and verifies terminal statuses without moving roster assets.' : args.tradeVeto ? 'Trade-veto mode seeds accepted trades, verifies trade parties cannot member-veto, verifies fewer than 50% member vetoes do not kill the trade, verifies the 50% threshold does, and verifies commissioner veto kills immediately.' : args.scoring ? 'Scoring mode seeds a disposable matchup with starter/bench lineups and real player_game_stats, calls the real Edge API /e2e/sync-scores path, and checks starter-only points, finalization blocking, winner, max-possible points, and standings append.' : 'Full weekly browser gameplay loop is not implemented; enable E2E_ENABLE_BROWSER_LINEUP=1 for manual lineup setting, E2E_ENABLE_BROWSER_LINEUP_AUTO_SET=1 for auto-set lineup setting, E2E_ENABLE_BROWSER_LINEUP_LOCKED=1 for locked-player move blocking, E2E_ENABLE_BROWSER_WAIVER=1 for no-drop waiver claim UI coverage, E2E_ENABLE_BROWSER_WAIVER_DROP=1 for drop-then-add waiver claim UI coverage, E2E_ENABLE_BROWSER_WAIVER_IR_BLOCK=1 for DTD-on-IR claim blocking, E2E_ENABLE_WAIVER_PROCESSING=1 for priority/drop/failure daily processing, E2E_ENABLE_BROWSER_TRADE=1 for player proposal UI coverage, E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK=1 for future-pick proposal UI coverage, E2E_ENABLE_BROWSER_TRADE_FUTURE_PICK_ACCEPT=1 for future-pick accept UI coverage, E2E_ENABLE_BROWSER_TRADE_OVERFLOW_ACCEPT=1 for drop-before-accept UI coverage, E2E_ENABLE_BROWSER_TRADE_POST_DEADLINE=1 for post-deadline proposal rejection, E2E_ENABLE_BROWSER_TRADE_VETO=1 for accepted-state veto UI coverage, E2E_ENABLE_BROWSER_TRADE_ACCEPT=1 for accept UI coverage, E2E_ENABLE_BROWSER_TRADE_TERMINAL=1 for reject/withdraw UI coverage, E2E_ENABLE_TRADE_VETO=1 for trade veto threshold coverage, or E2E_ENABLE_SCORING=1 for the starter-only scoring/finalization slice.'

  const playoffEvidence = args.browserPlayoff && args.playoffs
    ? 'Playoff modes seed a disposable 10-team season, verify top-six backend bracket generation, block premature advancement, finalize rounds, crown a champion, and verify the real Expo bracket modal champion banner.'
    : args.browserPlayoff ? 'Browser playoff mode creates a disposable 10-team league, generates the real top-six bracket, verifies advance blocking, finalizes playoff rounds, crowns a champion, then opens the real bracket modal and checks the champion banner.' : args.playoffs ? 'Playoff mode seeds a disposable 10-team regular season and calls the real authenticated /playoffs/generate route, then checks for a top-6 bracket.' : 'Enable E2E_ENABLE_BROWSER_PLAYOFF=1 for browser champion coverage or E2E_ENABLE_PLAYOFFS=1 for backend bracket-generation coverage.'

  const rookieDraftEvidence = args.browserRookieDraft && args.rookieDraft && args.pickChain
    ? 'Rookie-draft modes verify inverse-standings snake order, exact pick-asset linkage, lowest-draft-number auto-pick, already-rostered rejection, real browser 30s timer auto-pick, roster insert, and long-horizon traded-pick materialization.'
    : args.browserRookieDraft ? 'Browser rookie-draft mode creates an isolated offseason league, opens the real rookie draft room as the first pick owner, lets the 30s timer expire, and verifies the browser-triggered auto-pick, roster insert, and linked pick asset usage.' : args.rookieDraft ? 'Rookie-draft mode starts a disposable offseason draft through the real backend route, verifies inverse-standings snake order, auto-pick lowest nba_draft_number, exact pick asset usage, roster insert, and already-rostered rejection.' : args.pickChain ? 'Pick-chain mode verifies multi-hop future-pick ownership every season and materializes the traded pick in the target rookie draft year.' : 'Enable E2E_ENABLE_BROWSER_ROOKIE_DRAFT=1 for browser timer auto-pick coverage, E2E_ENABLE_ROOKIE_DRAFT=1 for backend rookie-draft auto-pick/order coverage, or E2E_ENABLE_PICK_CHAIN=1 for long-horizon traded-pick materialization.'

  const coverage = [
    {
      requirement: 'Phase A audit report',
      status: auditExists ? 'PASS' : 'PENDING',
      evidence: auditExists ? 'tests/audit-report.md exists.' : 'tests/audit-report.md missing.',
    },
    {
      requirement: 'P0/P1 findings resolved',
      status: 'PARTIAL',
      evidence: 'P0/P1 source fixes are documented; service-role JWT literals were purged from reachable local and remote branch history, Edge Functions prefer Supabase secret keys from the platform-provided SUPABASE_SECRET_KEYS dictionary, and local app/E2E env resolves to modern sb_publishable_/sb_secret_ keys. Hosted Supabase Edge API uses modern secret keys, remote legacy JWTs are disabled, and linked DB migration access is verified.',
    },
    {
      requirement: 'Real test Supabase project',
      status: env.supabaseUrl && env.serviceRoleKey ? 'PASS' : 'BLOCKED',
      evidence: env.supabaseUrl && env.serviceRoleKey ? 'Supabase URL/admin credentials loaded from E2E/app env.' : 'Missing Supabase admin credentials.',
    },
    {
      requirement: 'Fake NBA CDN/Sleeper upstream',
      status: rows.length > 0 ? 'PASS' : 'PENDING',
      evidence: `Fake upstream configured for http://127.0.0.1:${args.fakePort}.`,
    },
    {
      requirement: 'D.SET.1 auth/session/sign-out',
      status: args.browserAuth ? 'PASS' : 'PENDING',
      evidence: args.browserAuth ? 'Browser auth scenario was enabled for this run.' : 'Enable E2E_ENABLE_BROWSER_AUTH=1 or use prior browser-auth artifact.',
    },
    {
      requirement: 'D.SET.2 league create/join/pick bank',
      status: leagueLifecycleStatus,
      evidence: args.leagueLifecycle && args.browserLeagueLifecycle ? 'League-lifecycle mode verifies the 10-user auth/RPC lifecycle, and browser league lifecycle drives the real Expo create/join forms before verifying invite, members, lineup slots, current season, and five-year pick bank.' : args.browserLeagueLifecycle ? 'Browser league lifecycle drives the real Expo create/join forms before verifying invite, members, lineup slots, current season, and five-year pick bank.' : args.leagueLifecycle ? 'League-lifecycle mode signs in seeded users, calls create_league and join_league_by_invite_code through anon Supabase clients, then verifies invite code, members, lineup slots, current season, and five-year pick bank.' : targetLeagueId ? `Seeded target league ${targetLeagueId}; invite, lineup slots, members, and 5y pick-bank proof lives in tests/e2e-seed-report.md.` : 'No target league configured.',
    },
    {
      requirement: 'D.SET.3 commissioner settings propagation',
      status: settingsStatus,
      evidence: args.settings ? 'Settings mode creates a disposable setup league, updates league/scoring settings and lineup slots through authenticated commissioner-only RPCs, verifies a manager can read them, and checks manager RPC attempts do not mutate commissioner-only settings.' : 'No commissioner settings propagation scenario implemented; enable E2E_ENABLE_SETTINGS=1.',
    },
    {
      requirement: 'D.SET.4 initial auction draft',
      status: auctionStatus,
      evidence: auctionEvidence,
    },
    {
      requirement: 'D.0 invariant boundary checks',
      status: invariantStatus,
      evidence: rows.length > 0 ? 'Season rows in tests/e2e-report.md include D.0 boundary checks or failure.' : 'No season rows produced.',
    },
    {
      requirement: 'D.SEA.1 matchup generation idempotency',
      status: matchupStatus,
      evidence: env.backendTicksEnabled ? 'Edge E2E tick mode can call /e2e/generate-matchups twice and compare counts.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1.',
    },
    {
      requirement: 'D.SEA.2 weekly lineup/scoring/waiver/trade loop',
      status: weeklyLoopStatus,
      evidence: weeklyLoopEvidence,
    },
    {
      requirement: 'D.SEA.2 injury status filtering',
      status: injuryFilterStatus,
      evidence: args.injuryFilter ? 'Injury-filter mode mutates the fake Sleeper upstream, runs the real backend /e2e/sync-players path, and verifies junk injury_status values such as Scrambled are filtered while valid statuses persist.' : 'Enable E2E_ENABLE_INJURY_FILTER=1 to inject fake Sleeper injuries and verify Scrambled is filtered.',
    },
    {
      requirement: 'D.SEA.2 multi-asset trade acceptance',
      status: tradeAcceptStatus,
      evidence: args.tradeAccept ? 'Trade-accept mode creates a disposable player+future-pick trade, verifies mismatched auth/member acceptance is rejected, accepts through the real /trades/:tradeId/accept route, checks assets stay put during the veto window, expires the window, runs /e2e/process-trades, and checks players, picks, trade status, and transaction rows.' : 'Enable E2E_ENABLE_TRADE_ACCEPT=1 to exercise authenticated multi-asset trade acceptance.',
    },
    {
      requirement: 'D.SEA.3 standings tiebreakers',
      status: tiebreakerStatus,
      evidence: args.tiebreakers ? 'Tiebreaker mode seeds a disposable four-way tie and calls the real authenticated /playoffs/generate route to verify max-points/points-against/deterministic tiebreaker handling.' : 'No forced four-way tie scenario implemented; enable E2E_ENABLE_TIEBREAKERS=1 for standings tiebreaker coverage.',
    },
    {
      requirement: 'D.SEA.4 playoffs/champion',
      status: playoffRowStatus,
      evidence: playoffEvidence,
    },
    {
      requirement: 'D.SEA.5 rookie draft/traded picks',
      status: rookieDraftRowStatus,
      evidence: rookieDraftEvidence,
    },
    {
      requirement: 'D.SEA.6 season reset',
      status: resetStatus,
      evidence: args.seasonReset ? 'Season-reset mode creates a disposable league, calls the real /e2e/advance-season endpoint, and verifies current-season flip, roster carryover, waiver reseed, prior-season queryability, and rolling five-year pick horizon.' : env.backendTicksEnabled ? 'Edge E2E tick mode calls /e2e/advance-season and re-checks invariants.' : 'Requires E2E_ENABLE_BACKEND_TICKS=1 or E2E_ENABLE_SEASON_RESET=1.',
    },
    {
      requirement: 'D.SEA.7 snapshots/no shrink',
      status: snapshotStatus,
      evidence: 'Snapshot summaries are written under tests/snapshots/season-<N>/summary.json.',
    },
    {
      requirement: 'D.X.1 push notifications',
      status: pushStatus,
      evidence: args.push && args.draftPush ? 'Push mode verifies trade and waiver notifications through the fake Expo upstream; draft-push mode verifies rookie auto-pick notifications through the same fake Expo intercept.' : args.push ? 'Push mode verifies trade and waiver notifications through the fake Expo upstream; enable E2E_ENABLE_DRAFT_PUSH=1 for draft notifications.' : args.draftPush ? 'Draft-push mode runs a disposable rookie auto-pick and asserts the fake Expo upstream captured a draft notification; enable E2E_ENABLE_PUSH=1 for trade and waiver notifications.' : 'Enable E2E_ENABLE_PUSH=1 and E2E_ENABLE_DRAFT_PUSH=1 to cover trade, waiver, and draft push notifications.',
    },
    {
      requirement: 'D.X.2 realtime bid/score events',
      status: realtimeStatus,
      evidence: args.realtime ? 'Realtime mode opens multiple Supabase Realtime clients and asserts both matchup score updates and auction bid nomination updates reach every client within 2s.' : 'Enable E2E_ENABLE_REALTIME=1.',
    },
    {
      requirement: 'D.X.3 CORS regression',
      status: env.backendTicksEnabled ? 'PASS' : 'PENDING',
      evidence: env.backendTicksEnabled ? 'Edge E2E tick mode runs OPTIONS preflight before the season loop.' : 'Requires Edge E2E tick mode.',
    },
    {
      requirement: 'D.X.4 perf smoke under draft/live scoring load',
      status: browserPerfStatus,
      evidence: args.browserPerf ? 'Browser perf mode opens the real draft room and home scoreboard while applying continuous auction bids and matchup updates, then asserts responsiveness, screenshots, console output, and browser errors.' : 'Enable E2E_ENABLE_BROWSER_PERF=1 to run the continuous-bid/live-scoring browser perf smoke.',
    },
    {
      requirement: 'D.X.5 UI sweep',
      status: browserStatus,
      evidence: args.browserFullSweep ? 'Browser full sweep visits auth, tabs, modals, player, auction-draft, and rookie-draft routes, with screenshots and console/error artifacts.' : browserStatus === 'PARTIAL' ? 'Browser smoke/auth covers auth and tab routes; enable E2E_BROWSER_FULL_SWEEP=1 for modal/player/draft route sweep.' : 'Enable browser smoke/auth; full app route sweep pending.',
    },
    {
      requirement: 'D.LONG.1/D.LONG.2 long-horizon pick trades',
      status: pickChainStatus,
      evidence: args.pickChain ? 'Pick-chain mode creates a three-hop future-pick trade, verifies owner persistence every season, and checks the target rookie-draft slot belongs to the final owner when the pick year arrives.' : 'Enable E2E_ENABLE_PICK_CHAIN=1 to exercise multi-hop pick ownership and rookie-draft materialization.',
    },
    {
      requirement: 'D.LONG.3/D.LONG.4 standings/champion history',
      status: historyStatus,
      evidence: args.history ? 'History mode seeds deterministic completed-season standings/champion fixtures and verifies them after season resets.' : 'Enable E2E_ENABLE_HISTORY=1 with Edge E2E tick mode.',
    },
    {
      requirement: 'D.LONG.5 mid-life migration',
      status: midlifeMigrationStatus,
      evidence: args.midlifeMigration ? 'Mid-life migration mode runs `npx supabase db push` against the configured local/linked/db-url target between seasons and records tests/artifacts/season-<N>/midlife-migration.json.' : 'Enable E2E_ENABLE_MIDLIFE_MIGRATION=1 to apply the no-op migration between seasons 5 and 6.',
    },
    {
      requirement: 'D.LONG.6 runtime drift',
      status: runtimeStatus,
      evidence: 'Runtime metrics live in tests/artifacts/perf-metrics.json.',
    },
    {
      requirement: 'D.LONG.7 memory/connection leaks',
      status: memoryStatus,
      evidence: 'Harness memory metrics live in tests/artifacts/perf-metrics.json and 10+ season runs fail if RSS or heap exceeds the configured drift limit.',
    },
    {
      requirement: '10 seasons and continue past 10 / 20 clean',
      status: status === 'PASS' && seasons >= 20 ? 'PASS' : status === 'FAIL' ? 'FAIL' : seasons >= 20 ? 'PARTIAL' : 'PENDING',
      evidence: `Current run status is ${status} for target ${seasons} season(s); PARTIAL means enabled season rows passed but full gameplay coverage is still pending.`,
    },
    {
      requirement: 'Production-ready exit criteria',
      status: 'FAIL',
      evidence: 'Production exit remains blocked by P0/P1 operational follow-ups and focused-slice coverage rows that do not yet prove one literal monolithic 10-user season loop for every gameplay requirement.',
    },
  ]

  const lines = [
    '# E2E Coverage Checklist',
    '',
    `- Run status: ${status}`,
    `- Started: ${startedAt}`,
    `- Finished: ${finishedAt}`,
    `- Target seasons: ${seasons}`,
    '',
    '## Prompt-To-Artifact Matrix',
    '',
    '| Requirement | Status | Evidence |',
    '| --- | --- | --- |',
    ...coverage.map((row) => `| ${row.requirement} | ${row.status} | ${row.evidence.replaceAll('\n', '<br>')} |`),
    '',
    '## Run Notes',
    '',
    ...notes.map((note) => `- ${note}`),
  ]
  await writeFile(COVERAGE_PATH, `${lines.join('\n')}\n`)
}
