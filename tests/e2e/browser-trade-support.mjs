import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { createBrowser, listBrowserSessions } from './browser-agent.mjs'
import { assertPageText, clickButton, installBrowserHooks, signInBrowser } from './trade-browser-harness.mjs'
import { setupTradeGameplayFixture } from './trade-fixture.mjs'

export { mkdir, writeFile, path, resolvedEnv, requireEnv, describeEndpoint, normalizeBrowserErrors }
export { assertPageText, clickButton, installBrowserHooks, signInBrowser }
export { setupTradeGameplayFixture }

export const ROOT = process.cwd()
export const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
export const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-report.md')
export const ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-accept-report.md')
export const TERMINAL_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-terminal-report.md')
export const FUTURE_PICK_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-future-pick-report.md')
export const FUTURE_PICK_ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-future-pick-accept-report.md')
export const OVERFLOW_ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-overflow-accept-report.md')
export const POST_DEADLINE_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-post-deadline-report.md')
export const VETO_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-veto-report.md')
export const MULTI_TEAM_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-multi-team-report.md')

export const browser = createBrowser({ cwd: ROOT })

export const listSessions = () => listBrowserSessions({ cwd: ROOT })

export const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
export const tradeSessionName = (code, runId) => safeName(`pc-${code}-${runId}-${process.pid}`)
export const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
export const parseEvalJson = (output) => {
  const line = output.split('\n').filter(Boolean).at(-1)
  const value = JSON.parse(line)
  return typeof value === 'string' ? JSON.parse(value) : value
}

export const setupTradeAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'pending',
      notes: 'Browser trade accept gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: fixture.proposerPlayer.id,
      pick_id: null,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: fixture.recipientPlayer.id,
      pick_id: null,
    },
  ])
  if (itemError) throw new Error(`trade item fixture insert: ${itemError.message}`)

  return { ...fixture, trade }
}

export const setupTradeFuturePickAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'pending',
      notes: 'Browser future-pick accept gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`future-pick trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: null,
      pick_id: fixture.proposerFuturePick.id,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: null,
      pick_id: fixture.recipientFuturePick.id,
    },
  ])
  if (itemError) throw new Error(`future-pick trade item fixture insert: ${itemError.message}`)

  return { ...fixture, trade }
}

export const setupTradeOverflowAcceptGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const { error: leagueError } = await fixture.admin
    .from('leagues')
    .update({ roster_size: 1 })
    .eq('id', fixture.league.id)
  if (leagueError) throw new Error(`overflow league roster_size update: ${leagueError.message}`)

  const { data: recipientRoster, error: rosterError } = await fixture.admin
    .from('roster_players')
    .select('id, member_id, player_id')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('member_id', fixture.recipient.id)
    .eq('player_id', fixture.recipientPlayer.id)
    .single()
  if (rosterError) throw new Error(`overflow recipient roster lookup: ${rosterError.message}`)

  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'pending',
      notes: 'Browser trade overflow accept gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`overflow trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: fixture.proposerPlayer.id,
      pick_id: null,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: null,
      pick_id: fixture.recipientFuturePick.id,
    },
  ])
  if (itemError) throw new Error(`overflow trade item fixture insert: ${itemError.message}`)

  return {
    ...fixture,
    trade,
    rosterSize: 1,
    dropCandidateRosterId: recipientRoster.id,
  }
}

export const setupTradeVetoGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 3 })
  if (!fixture.observer) throw new Error('browser trade veto fixture did not create observer member')

  const { data: trade, error: tradeError } = await fixture.admin
    .from('trades')
    .insert({
      league_id: fixture.league.id,
      league_season_id: fixture.currentSeason.id,
      proposer_member_id: fixture.proposer.id,
      recipient_member_id: fixture.recipient.id,
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      veto_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      notes: 'Browser trade veto gameplay',
    })
    .select('id')
    .single()
  if (tradeError) throw new Error(`veto trade fixture insert: ${tradeError.message}`)

  const { error: itemError } = await fixture.admin.from('trade_items').insert([
    {
      trade_id: trade.id,
      side: 'proposer',
      player_id: fixture.proposerPlayer.id,
      pick_id: null,
    },
    {
      trade_id: trade.id,
      side: 'recipient',
      player_id: fixture.recipientPlayer.id,
      pick_id: null,
    },
  ])
  if (itemError) throw new Error(`veto trade item fixture insert: ${itemError.message}`)

  return { ...fixture, trade, observer: fixture.observer }
}

export const setupTradePostDeadlineGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const tradeDeadline = '2000-01-01'
  const { error } = await fixture.admin
    .from('leagues')
    .update({ trade_deadline: tradeDeadline })
    .eq('id', fixture.league.id)
  if (error) throw new Error(`post-deadline trade fixture update: ${error.message}`)
  return { ...fixture, tradeDeadline }
}

export const clickLastButton = async (session, name, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const candidates = [...document.querySelectorAll('[role="button"], button, [tabindex]')]
        .filter((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
      const visibleCandidates = candidates.filter((element) => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const disabled = Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true';
        if (disabled || style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return false;
        if (rect.width <= 0 || rect.height <= 0) return false;
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return hit === element || element.contains(hit);
      });
      const target = visibleCandidates.at(-1);
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400), count: candidates.length, visibleCount: visibleCandidates.length });
      const rect = target.getBoundingClientRect();
      const init = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      };
      const Pointer = window.PointerEvent || window.MouseEvent;
      target.dispatchEvent(new Pointer('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mousedown', init));
      target.dispatchEvent(new Pointer('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
      target.dispatchEvent(new MouseEvent('mouseup', init));
      target.dispatchEvent(new MouseEvent('click', init));
      return JSON.stringify({
        ok: true,
        tagName: target.tagName,
        role: target.getAttribute('role'),
        ariaLabel: target.getAttribute('aria-label'),
        text: target.textContent,
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: visible enabled button not found: ${name}. Body: ${parsed.body}`)
  return parsed
}

export const readButtonState = async (session, name, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const named = [...document.querySelectorAll('[aria-label], [role="button"], button')]
        .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
      const target = named?.closest?.('[role="button"], button, [tabindex]') || named;
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
      const style = window.getComputedStyle(target);
      return JSON.stringify({
        ok: true,
        disabled: Boolean(target.disabled),
        ariaDisabled: target.getAttribute('aria-disabled'),
        pointerEvents: style.pointerEvents,
        opacity: style.opacity,
        role: target.getAttribute('role'),
        ariaLabel: target.getAttribute('aria-label'),
        text: target.textContent,
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: button not found: ${name}. Body: ${parsed.body}`)
  return parsed
}

export const verifyTradeProposal = async (fixture) => {
  const { data: trades, error: tradesError } = await fixture.admin
    .from('trades')
    .select('id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, notes')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('proposer_member_id', fixture.proposer.id)
    .eq('recipient_member_id', fixture.recipient.id)
    .eq('status', 'pending')
  if (tradesError) throw new Error(`trade verify: ${tradesError.message}`)

  const failures = []
  if ((trades ?? []).length !== 1) {
    failures.push(`pending trade rows=${(trades ?? []).length}; expected 1`)
  }
  const trade = trades?.[0] ?? null
  if (!trade) return { trade, items: [], failures }

  const { data: items, error: itemsError } = await fixture.admin
    .from('trade_items')
    .select('id, trade_id, side, player_id, pick_id')
    .eq('trade_id', trade.id)
    .order('side', { ascending: true })
  if (itemsError) throw new Error(`trade item verify: ${itemsError.message}`)

  const proposerItem = (items ?? []).find((item) => item.side === 'proposer')
  const recipientItem = (items ?? []).find((item) => item.side === 'recipient')
  if ((items ?? []).length !== 2) failures.push(`trade_items rows=${(items ?? []).length}; expected 2`)
  if (proposerItem?.player_id !== fixture.proposerPlayer.id) {
    failures.push(`proposer item player=${proposerItem?.player_id}; expected ${fixture.proposerPlayer.id}`)
  }
  if (recipientItem?.player_id !== fixture.recipientPlayer.id) {
    failures.push(`recipient item player=${recipientItem?.player_id}; expected ${fixture.recipientPlayer.id}`)
  }
  if ((items ?? []).some((item) => item.pick_id != null)) failures.push('player-for-player trade unexpectedly inserted pick items')
  return { trade, items: items ?? [], failures }
}

export const waitForTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeProposal(fixture)
  }
  return last
}

export const verifyPostDeadlineTradeRejected = async (fixture) => {
  const [tradesResult, itemsResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, notes')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('trade_items')
      .select('id, trade_id'),
  ])
  if (tradesResult.error) throw new Error(`post-deadline trade verify: ${tradesResult.error.message}`)
  if (itemsResult.error) throw new Error(`post-deadline trade item verify: ${itemsResult.error.message}`)

  const trades = tradesResult.data ?? []
  const tradeIds = new Set(trades.map((trade) => trade.id))
  const items = (itemsResult.data ?? []).filter((item) => tradeIds.has(item.trade_id))
  const failures = []
  if (trades.length !== 0) failures.push(`post-deadline proposal inserted trades rows=${trades.length}; expected 0`)
  if (items.length !== 0) failures.push(`post-deadline proposal inserted trade_items rows=${items.length}; expected 0`)
  return { trades, items, failures }
}

export const readBrowserAlerts = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => JSON.stringify(window.__pancakeAlerts || []))()`,
  ])
  return parseEvalJson(output)
}

export const waitForTradeStatus = async (fixture, status, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = null
  while (Date.now() - startedAt < timeoutMs) {
    const { data, error } = await fixture.admin
      .from('trades')
      .select('id, status, accepted_at, veto_window_expires_at, completed_at')
      .eq('id', fixture.trade.id)
      .single()
    if (error) throw new Error(`trade status verify: ${error.message}`)
    last = data
    if (data?.status === status) return data
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`trade ${fixture.trade.id} status=${last?.status ?? '<missing>'}; expected ${status}`)
}

export const expireAndCompleteAcceptedTrade = async (fixture) => {
  await waitForTradeStatus(fixture, 'accepted')
  const { error: expireError } = await fixture.admin
    .from('trades')
    .update({ veto_window_expires_at: new Date(Date.now() - 1000).toISOString() })
    .eq('id', fixture.trade.id)
  if (expireError) throw new Error(`trade veto-window expiry failed: ${expireError.message}`)

  const { error: completeError } = await fixture.admin.rpc('complete_accepted_trade_atomic', {
    p_trade_id: fixture.trade.id,
  })
  if (completeError) throw new Error(`trade completion failed: ${completeError.message}`)
}

export const verifyFuturePickTradeProposal = async (fixture) => {
  const { data: trades, error: tradesError } = await fixture.admin
    .from('trades')
    .select('id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, notes')
    .eq('league_id', fixture.league.id)
    .eq('league_season_id', fixture.currentSeason.id)
    .eq('proposer_member_id', fixture.proposer.id)
    .eq('recipient_member_id', fixture.recipient.id)
    .eq('status', 'pending')
  if (tradesError) throw new Error(`future-pick trade verify: ${tradesError.message}`)

  const failures = []
  if ((trades ?? []).length !== 1) {
    failures.push(`pending trade rows=${(trades ?? []).length}; expected 1`)
  }
  const trade = trades?.[0] ?? null
  if (!trade) return { trade, items: [], picks: [], failures }

  const { data: items, error: itemsError } = await fixture.admin
    .from('trade_items')
    .select('id, trade_id, side, player_id, pick_id')
    .eq('trade_id', trade.id)
    .order('side', { ascending: true })
  if (itemsError) throw new Error(`future-pick trade item verify: ${itemsError.message}`)

  const { data: picks, error: picksError } = await fixture.admin
    .from('draft_picks')
    .select('id, season_year, round, original_owner_id, current_owner_id')
    .in('id', [fixture.proposerFuturePick.id, fixture.recipientFuturePick.id])
  if (picksError) throw new Error(`future-pick asset verify: ${picksError.message}`)

  const proposerItem = (items ?? []).find((item) => item.side === 'proposer')
  const recipientItem = (items ?? []).find((item) => item.side === 'recipient')
  if ((items ?? []).length !== 2) failures.push(`trade_items rows=${(items ?? []).length}; expected 2`)
  if (proposerItem?.pick_id !== fixture.proposerFuturePick.id) {
    failures.push(`proposer item pick=${proposerItem?.pick_id}; expected ${fixture.proposerFuturePick.id}`)
  }
  if (recipientItem?.pick_id !== fixture.recipientFuturePick.id) {
    failures.push(`recipient item pick=${recipientItem?.pick_id}; expected ${fixture.recipientFuturePick.id}`)
  }
  if ((items ?? []).some((item) => item.player_id != null)) failures.push('future-pick proposal unexpectedly inserted player items')

  const picksById = new Map((picks ?? []).map((pick) => [pick.id, pick]))
  const proposerPick = picksById.get(fixture.proposerFuturePick.id)
  const recipientPick = picksById.get(fixture.recipientFuturePick.id)
  if (proposerPick?.current_owner_id !== fixture.proposer.id) {
    failures.push(`proposer future pick owner=${proposerPick?.current_owner_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if (recipientPick?.current_owner_id !== fixture.recipient.id) {
    failures.push(`recipient future pick owner=${recipientPick?.current_owner_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (proposerPick?.season_year !== fixture.targetFuturePickYear || recipientPick?.season_year !== fixture.targetFuturePickYear) {
    failures.push(`future pick years=${proposerPick?.season_year ?? '<missing>'}/${recipientPick?.season_year ?? '<missing>'}; expected ${fixture.targetFuturePickYear}`)
  }

  return { trade, items: items ?? [], picks: picks ?? [], failures }
}

export const waitForFuturePickTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyFuturePickTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyFuturePickTradeProposal(fixture)
  }
  return last
}

export const verifyTradeAccepted = async (fixture) => {
  const [tradeResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`accepted trade verify: ${tradeResult.error.message}`)
  if (rosterResult.error) throw new Error(`accepted roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`accepted transactions verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))

  if (trade.status !== 'completed' || !trade.accepted_at || !trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`proposer player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push(`recipient player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.acquired_via !== 'trade' || rosterByPlayer.get(fixture.recipientPlayer.id)?.acquired_via !== 'trade') {
    failures.push('accepted players did not receive acquired_via=trade')
  }
  if (transactions.length !== 4) {
    failures.push(`roster_transactions count=${transactions.length}; expected 4 trade in/out rows`)
  }

  return { trade, roster, transactions, failures }
}

export const waitForTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeAccepted(fixture)
  }
  return last
}

export const verifyFuturePickTradeAccepted = async (fixture) => {
  const [tradeResult, picksResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('draft_picks')
      .select('id, season_year, round, original_owner_id, current_owner_id, is_used')
      .in('id', [fixture.proposerFuturePick.id, fixture.recipientFuturePick.id]),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`future-pick accepted trade verify: ${tradeResult.error.message}`)
  if (picksResult.error) throw new Error(`future-pick accepted picks verify: ${picksResult.error.message}`)
  if (rosterResult.error) throw new Error(`future-pick accepted roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`future-pick accepted transactions verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const picks = picksResult.data ?? []
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const picksById = new Map(picks.map((pick) => [pick.id, pick]))
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))

  if (trade.status !== 'completed' || !trade.accepted_at || !trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (picksById.get(fixture.proposerFuturePick.id)?.current_owner_id !== fixture.recipient.id) {
    failures.push(`proposer future pick owner=${picksById.get(fixture.proposerFuturePick.id)?.current_owner_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (picksById.get(fixture.recipientFuturePick.id)?.current_owner_id !== fixture.proposer.id) {
    failures.push(`recipient future pick owner=${picksById.get(fixture.recipientFuturePick.id)?.current_owner_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if ((picks ?? []).some((pick) => pick.is_used)) failures.push('accepted future-pick trade unexpectedly marked a pick used')
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push(`proposer player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected unchanged proposer ${fixture.proposer.id}`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`recipient player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected unchanged recipient ${fixture.recipient.id}`)
  }
  if (transactions.length !== 0) {
    failures.push(`roster_transactions count=${transactions.length}; expected 0 for pick-only trade`)
  }

  return { trade, picks, roster, transactions, failures }
}

export const waitForFuturePickTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyFuturePickTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyFuturePickTradeAccepted(fixture)
  }
  return last
}

export const verifyOverflowTradeAccepted = async (fixture) => {
  const [tradeResult, rosterResult, picksResult, tradeTransactionResult, dropTransactionResult, waiverResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('draft_picks')
      .select('id, season_year, round, original_owner_id, current_owner_id, is_used')
      .eq('id', fixture.recipientFuturePick.id)
      .single(),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('member_id', fixture.recipient.id)
      .eq('player_id', fixture.recipientPlayer.id)
      .eq('transaction_type', 'fa_drop')
      .is('related_trade_id', null),
    fixture.admin
      .from('waiver_wire_log')
      .select('id, league_id, league_season_id, player_id, dropped_by_member_id, clears_at')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('player_id', fixture.recipientPlayer.id)
      .eq('dropped_by_member_id', fixture.recipient.id),
  ])
  if (tradeResult.error) throw new Error(`overflow accepted trade verify: ${tradeResult.error.message}`)
  if (rosterResult.error) throw new Error(`overflow accepted roster verify: ${rosterResult.error.message}`)
  if (picksResult.error) throw new Error(`overflow accepted pick verify: ${picksResult.error.message}`)
  if (tradeTransactionResult.error) throw new Error(`overflow accepted trade transactions verify: ${tradeTransactionResult.error.message}`)
  if (dropTransactionResult.error) throw new Error(`overflow accepted drop transactions verify: ${dropTransactionResult.error.message}`)
  if (waiverResult.error) throw new Error(`overflow accepted waiver log verify: ${waiverResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const roster = rosterResult.data ?? []
  const tradeTransactions = tradeTransactionResult.data ?? []
  const dropTransactions = dropTransactionResult.data ?? []
  const waiverLogs = waiverResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))
  const recipientActiveRoster = roster.filter((row) => row.member_id === fixture.recipient.id)

  if (trade.status !== 'completed' || !trade.accepted_at || !trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected completed timestamps`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`incoming player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.acquired_via !== 'trade') {
    failures.push(`incoming player acquired_via=${rosterByPlayer.get(fixture.proposerPlayer.id)?.acquired_via ?? '<missing>'}; expected trade`)
  }
  if (rosterByPlayer.has(fixture.recipientPlayer.id)) {
    failures.push(`drop candidate ${fixture.recipientPlayer.id} still rostered after overflow accept`)
  }
  if (recipientActiveRoster.length !== fixture.rosterSize) {
    failures.push(`recipient active roster count=${recipientActiveRoster.length}; expected roster_size ${fixture.rosterSize}`)
  }
  if (picksResult.data.current_owner_id !== fixture.proposer.id) {
    failures.push(`recipient future pick owner=${picksResult.data.current_owner_id}; expected proposer ${fixture.proposer.id}`)
  }
  if (picksResult.data.is_used) failures.push('accepted overflow trade unexpectedly marked the pick used')
  if (tradeTransactions.length !== 2) {
    failures.push(`trade roster_transactions count=${tradeTransactions.length}; expected 2 player trade rows`)
  }
  if (dropTransactions.length !== 1) {
    failures.push(`fa_drop transaction count=${dropTransactions.length}; expected 1 drop-before-accept row`)
  }
  if (waiverLogs.length !== 1) {
    failures.push(`waiver_wire_log rows=${waiverLogs.length}; expected 1 dropped player waiver row`)
  }

  return {
    trade,
    roster,
    pick: picksResult.data,
    tradeTransactions,
    dropTransactions,
    waiverLogs,
    failures,
  }
}

export const waitForOverflowTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyOverflowTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyOverflowTradeAccepted(fixture)
  }
  return last
}

export const verifyTradeTerminalStatus = async (fixture, expectedStatus) => {
  const [tradeResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, completed_at, veto_window_expires_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id, acquired_via')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, member_id, player_id, transaction_type, related_trade_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id)
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`${expectedStatus} trade verify: ${tradeResult.error.message}`)
  if (rosterResult.error) throw new Error(`${expectedStatus} roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`${expectedStatus} transactions verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))

  if (trade.status !== expectedStatus) {
    failures.push(`trade status=${trade.status}; expected ${expectedStatus}`)
  }
  if (trade.accepted_at || trade.completed_at || trade.veto_window_expires_at) {
    failures.push(`terminal ${expectedStatus} trade unexpectedly has accepted/completed/veto timestamps`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push(`proposer player owner=${rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id ?? '<missing>'}; expected proposer ${fixture.proposer.id}`)
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push(`recipient player owner=${rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id ?? '<missing>'}; expected recipient ${fixture.recipient.id}`)
  }
  if (transactions.length !== 0) {
    failures.push(`roster_transactions count=${transactions.length}; expected 0 for ${expectedStatus}`)
  }

  return { trade, roster, transactions, failures }
}

export const waitForTradeTerminalStatus = async (fixture, expectedStatus, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeTerminalStatus(fixture, expectedStatus)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeTerminalStatus(fixture, expectedStatus)
  }
  return last
}

export const verifyTradeVetoed = async (fixture) => {
  const [tradeResult, vetoResult, rosterResult, transactionResult] = await Promise.all([
    fixture.admin
      .from('trades')
      .select('id, status, accepted_at, veto_window_expires_at, vetoed_at, completed_at')
      .eq('id', fixture.trade.id)
      .single(),
    fixture.admin
      .from('trade_vetos')
      .select('id, trade_id, member_id, veto_type')
      .eq('trade_id', fixture.trade.id),
    fixture.admin
      .from('roster_players')
      .select('id, member_id, player_id')
      .eq('league_id', fixture.league.id)
      .eq('league_season_id', fixture.currentSeason.id),
    fixture.admin
      .from('roster_transactions')
      .select('id, related_trade_id')
      .eq('related_trade_id', fixture.trade.id),
  ])
  if (tradeResult.error) throw new Error(`vetoed trade verify: ${tradeResult.error.message}`)
  if (vetoResult.error) throw new Error(`veto rows verify: ${vetoResult.error.message}`)
  if (rosterResult.error) throw new Error(`veto roster verify: ${rosterResult.error.message}`)
  if (transactionResult.error) throw new Error(`veto transaction verify: ${transactionResult.error.message}`)

  const failures = []
  const trade = tradeResult.data
  const vetoRows = vetoResult.data ?? []
  const roster = rosterResult.data ?? []
  const transactions = transactionResult.data ?? []
  const rosterByPlayer = new Map(roster.map((row) => [row.player_id, row]))
  if (trade.status !== 'vetoed' || !trade.accepted_at || !trade.vetoed_at || trade.completed_at) {
    failures.push(`trade status=${trade.status}, accepted_at=${trade.accepted_at ?? '<null>'}, vetoed_at=${trade.vetoed_at ?? '<null>'}, completed_at=${trade.completed_at ?? '<null>'}; expected vetoed without completion`)
  }
  if (vetoRows.length !== 1 || vetoRows[0]?.member_id !== fixture.observer.id || vetoRows[0]?.veto_type !== 'member') {
    failures.push(`veto rows=${JSON.stringify(vetoRows)}; expected one member veto from observer ${fixture.observer.id}`)
  }
  if (rosterByPlayer.get(fixture.proposerPlayer.id)?.member_id !== fixture.proposer.id) {
    failures.push('proposer player moved despite veto')
  }
  if (rosterByPlayer.get(fixture.recipientPlayer.id)?.member_id !== fixture.recipient.id) {
    failures.push('recipient player moved despite veto')
  }
  if (transactions.length !== 0) {
    failures.push(`trade transaction rows=${transactions.length}; expected 0 for vetoed trade`)
  }
  return { trade, vetoRows, roster, transactions, failures }
}

export const waitForTradeVetoed = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeVetoed(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeVetoed(fixture)
  }
  return last
}

export const clickTab = async (session, namePrefix, label) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const norm = (value) => (value || '').trim();
      const target = [...document.querySelectorAll('[role="tab"], [role="button"], button, [tabindex]')]
        .find((element) => {
          const name = norm(element.getAttribute('aria-label')) || norm(element.textContent);
          return name === ${JSON.stringify(namePrefix)} || name.startsWith(${JSON.stringify(namePrefix + ',')}) || name.startsWith(${JSON.stringify(namePrefix)});
        });
      if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      target.click();
      return JSON.stringify({ ok: true, ariaLabel: target.getAttribute('aria-label'), role: target.getAttribute('role') });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label}: tab not found: ${namePrefix}. Body: ${parsed.body}`)
  return parsed
}

export const openOffersTab = async (session, env) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/trades')])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '2500'])
  await clickTab(session, 'Offers', 'offers tab')
  await browser(session, ['wait', '2500'])
}
