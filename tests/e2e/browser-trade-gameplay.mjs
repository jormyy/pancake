import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'
import { installRuntimeOverrides, normalizeBrowserErrors } from './browser-runtime-overrides.mjs'
import { createBrowser, fillSignInCredentials, listBrowserSessions } from './browser-agent.mjs'

const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-report.md')
const ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-accept-report.md')
const TERMINAL_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-terminal-report.md')
const FUTURE_PICK_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-future-pick-report.md')
const FUTURE_PICK_ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-future-pick-accept-report.md')
const OVERFLOW_ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-overflow-accept-report.md')
const POST_DEADLINE_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-post-deadline-report.md')
const VETO_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-veto-report.md')
const MULTI_TEAM_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-multi-team-report.md')

const browser = createBrowser({ cwd: ROOT })

const listSessions = () => listBrowserSessions({ cwd: ROOT })

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const tradeSessionName = (code, runId) => safeName(`pc-${code}-${runId}-${process.pid}`)
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()
let tradeFixtureSequence = 0

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

const sortedLeagueMembers = async (admin, leagueId) => {
  const { data, error } = await admin
    .from('league_members')
    .select('id, user_id, team_name')
    .eq('league_id', leagueId)
    .order('joined_at', { ascending: true })
  if (error) throw new Error(`league members lookup: ${error.message}`)
  return data ?? []
}

const findAvailablePlayers = async (admin, leagueId, leagueSeasonId, count) => {
  const [{ data: rosterRows, error: rosterError }, { data: players, error: playersError }] = await Promise.all([
    admin
      .from('roster_players')
      .select('player_id')
      .eq('league_id', leagueId)
      .eq('league_season_id', leagueSeasonId),
    admin
      .from('players')
      .select('id, display_name, position, nba_team')
      .not('display_name', 'is', null)
      .order('display_name', { ascending: true })
      .limit(300),
  ])
  if (rosterError) throw new Error(`roster lookup: ${rosterError.message}`)
  if (playersError) throw new Error(`players lookup: ${playersError.message}`)
  const rosteredIds = new Set((rosterRows ?? []).map((row) => row.player_id))
  const available = (players ?? []).filter((player) => player.display_name && !rosteredIds.has(player.id))

  if (available.length >= count) return available.slice(0, count)

  const needed = count - available.length
  const positions = ['PG', 'SG', 'SF', 'PF', 'C']
  const createdAt = Date.now()
  const fallbackRows = Array.from({ length: needed }, (_, index) => {
    const position = positions[(available.length + index) % positions.length]
    return {
      first_name: 'E2E',
      last_name: `Trade ${createdAt} ${index + 1}`,
      nba_team: 'FA',
      position,
      status: 'Active',
      eligible_positions: [position],
      years_exp: 1,
    }
  })
  const { data: fallbackPlayers, error: fallbackError } = await admin
    .from('players')
    .insert(fallbackRows)
    .select('id, display_name, position, nba_team')
  if (fallbackError) throw new Error(`fallback player seed insert: ${fallbackError.message}`)

  const combined = [...available, ...(fallbackPlayers ?? [])]
  if (combined.length < count) {
    throw new Error(`D.SEA.2 browser trade: only ${combined.length} available players found after fallback seed; need ${count}`)
  }
  return combined.slice(0, count)
}

const findFuturePickForMember = async (admin, leagueId, memberId, seasonYear, round = 1) => {
  const { data, error } = await admin
    .from('draft_picks')
    .select(`
      id,
      season_year,
      round,
      original_owner_id,
      current_owner_id,
      original_owner:league_members!draft_picks_original_owner_id_fkey ( team_name )
    `)
    .eq('league_id', leagueId)
    .eq('current_owner_id', memberId)
    .eq('season_year', seasonYear)
    .eq('round', round)
    .eq('is_used', false)
    .single()
  if (error) throw new Error(`future pick lookup ${memberId} ${seasonYear} round ${round}: ${error.message}`)
  return {
    id: data.id,
    seasonYear: data.season_year,
    round: data.round,
    originalOwnerId: data.original_owner_id,
    currentOwnerId: data.current_owner_id,
    originalTeamName: data.original_owner?.team_name ?? 'Unknown',
  }
}

const setupTradeGameplayFixture = async (env, season, { memberCount = 2, includeFuturePicks = true } = {}) => {
  tradeFixtureSequence += 1
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}-${tradeFixtureSequence}`
  const password = `Pancake-trade-${runId}!`
  const users = Array.from({ length: memberCount }, (_, index) => index + 1).map((n) => ({
    email: `pancake-trade-${runId}-${n}@example.com`,
    password,
    username: `pancake_trade_${runId}_${n}`.replace(/[^a-zA-Z0-9_]/g, '_'),
    displayName: `Pancake Trade ${runId} #${n}`,
    teamName: `Trade Team ${n}`,
  }))

  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false } })
  const createdUsers = []
  for (const user of users) {
    createdUsers.push(await createConfirmedUser(admin, user))
  }

  const { error: profileError } = await admin.from('profiles').upsert(
    createdUsers.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.displayName,
    })),
    { onConflict: 'id' },
  )
  if (profileError) throw new Error(`profiles upsert: ${profileError.message}`)

  const proposerClient = await signInClient(env, createdUsers[0].email, password)
  const { data: league, error: createError } = await proposerClient.rpc('create_league', {
    p_name: `Pancake Browser Trade ${runId}`,
    p_team_name: createdUsers[0].teamName,
    p_auction_budget: 200,
  })
  if (createError) throw new Error(`create_league: ${createError.message}`)

  for (const user of createdUsers.slice(1)) {
    const memberClient = await signInClient(env, user.email, password)
    const { error: joinError } = await memberClient.rpc('join_league_by_invite_code', {
      p_invite_code: league.invite_code,
      p_team_name: user.teamName,
    })
    if (joinError) throw new Error(`join_league_by_invite_code ${user.email}: ${joinError.message}`)
  }

  const currentSeason = await fetchCurrentSeason(admin, league.id)
  const members = await sortedLeagueMembers(admin, league.id)
  if (members.length !== memberCount) throw new Error(`D.SEA.2 browser trade: expected ${memberCount} members, got ${members.length}`)
  const proposer = members.find((member) => member.user_id === createdUsers[0].id)
  const recipient = members.find((member) => member.user_id === createdUsers[1].id)
  if (!proposer || !recipient) throw new Error('D.SEA.2 browser trade: member lookup failed')
  const observer = memberCount > 2
    ? members.find((member) => member.user_id === createdUsers[2].id)
    : null

  const [proposerPlayer, recipientPlayer] = await findAvailablePlayers(admin, league.id, currentSeason.id, 2)
  const targetFuturePickYear = currentSeason.season_year + 5
  const [proposerFuturePick, recipientFuturePick] = includeFuturePicks
    ? await Promise.all([
      findFuturePickForMember(admin, league.id, proposer.id, targetFuturePickYear, 1),
      findFuturePickForMember(admin, league.id, recipient.id, targetFuturePickYear, 1),
    ])
    : [null, null]
  const { error: rosterError } = await admin.from('roster_players').insert([
    {
      league_id: league.id,
      league_season_id: currentSeason.id,
      member_id: proposer.id,
      player_id: proposerPlayer.id,
      acquired_via: 'draft',
      acquisition_cost: 1,
    },
    {
      league_id: league.id,
      league_season_id: currentSeason.id,
      member_id: recipient.id,
      player_id: recipientPlayer.id,
      acquired_via: 'draft',
      acquisition_cost: 1,
    },
  ])
  if (rosterError) throw new Error(`roster seed insert: ${rosterError.message}`)

  const { error: statusError } = await admin
    .from('leagues')
    .update({ status: 'active' })
    .eq('id', league.id)
  if (statusError) throw new Error(`trade fixture status flip: ${statusError.message}`)

  return {
    admin,
    runId,
    password,
    users: createdUsers,
    league,
    currentSeason,
    proposer,
    recipient,
    observer,
    proposerPlayer,
    recipientPlayer,
    targetFuturePickYear,
    proposerFuturePick,
    recipientFuturePick,
  }
}

const setupMultiTeamTradeGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season, { memberCount: 3, includeFuturePicks: false })
  if (!fixture.observer) throw new Error('browser multi-team trade fixture did not create a third member')

  const [observerPlayer] = await findAvailablePlayers(fixture.admin, fixture.league.id, fixture.currentSeason.id, 1)
  const { error: rosterError } = await fixture.admin.from('roster_players').insert({
    league_id: fixture.league.id,
    league_season_id: fixture.currentSeason.id,
    member_id: fixture.observer.id,
    player_id: observerPlayer.id,
    acquired_via: 'draft',
    acquisition_cost: 1,
  })
  if (rosterError) throw new Error(`multi-team observer roster seed insert: ${rosterError.message}`)

  return { ...fixture, observer: fixture.observer, observerPlayer }
}

const setupTradeAcceptGameplayFixture = async (env, season) => {
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

const setupTradeFuturePickAcceptGameplayFixture = async (env, season) => {
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

const setupTradeOverflowAcceptGameplayFixture = async (env, season) => {
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

const setupTradeVetoGameplayFixture = async (env, season) => {
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

const setupTradePostDeadlineGameplayFixture = async (env, season) => {
  const fixture = await setupTradeGameplayFixture(env, season)
  const tradeDeadline = '2000-01-01'
  const { error } = await fixture.admin
    .from('leagues')
    .update({ trade_deadline: tradeDeadline })
    .eq('id', fixture.league.id)
  if (error) throw new Error(`post-deadline trade fixture update: ${error.message}`)
  return { ...fixture, tradeDeadline }
}

const installBrowserHooks = async (session, env, options = {}) => {
  await installRuntimeOverrides(browser, session, env, {
    alerts: true,
    confirm: true,
    openBeforeSet: options.openBeforeSet ?? false,
    reloadAfterSet: options.reloadAfterSet ?? false,
  })
}

const readAuthScreenState = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const text = document.body?.innerText || '';
      return JSON.stringify({
        url: location.href,
        isSignIn: text.includes('Sign In') && text.includes("Don't have an account?"),
        sample: text.slice(0, 400)
      });
    })()`,
  ])
  return parseEvalJson(output)
}

const clickSignInButton = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => {
      const candidates = [...document.querySelectorAll('[aria-label], [role="button"], button')];
      const named = candidates.find((element) => (
        element.getAttribute('aria-label') === 'Sign In' ||
        (element.textContent || '').trim() === 'Sign In'
      ));
      const textNode = named || [...document.querySelectorAll('*')]
        .reverse()
        .find((element) => (element.textContent || '').trim() === 'Sign In');
      const target = textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
      if (!target) return JSON.stringify({ ok: false, sample: (document.body?.innerText || '').slice(0, 400) });
      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
      target.click();
      return JSON.stringify({ ok: true });
    })()`,
  ])
  const result = parseEvalJson(output)
  if (!result.ok) throw new Error(`browser trade sign-in button not found: ${result.sample}`)
}

const signInBrowser = async (session, env, user, password) => {
  await installBrowserHooks(session, env, { openBeforeSet: true, reloadAfterSet: true })
  await browser(session, ['wait', '1500'])
  let lastState = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await fillSignInCredentials(browser, session, user.email, password)
      await clickSignInButton(session)
    } catch (error) {
      lastState = await readAuthScreenState(session).catch(() => null)
      if (lastState && !lastState.isSignIn) return
      throw error
    }
    await browser(session, ['wait', '4000'])
    lastState = await readAuthScreenState(session)
    if (!lastState.isSignIn) return
    if (attempt < 3) {
      await browser(session, ['open', env.frontendUrl])
      await installBrowserHooks(session, env)
      await browser(session, ['wait', '1500'])
    }
  }
  throw new Error(`browser trade sign-in stayed on auth screen at ${lastState?.url ?? '<unknown>'}: ${lastState?.sample ?? '<no sample>'}`)
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
        sample: text.slice(0, 1200)
      });
    })()`,
  ])
  const parsed = parseEvalJson(output)
  if (!parsed.ok) throw new Error(`${label} missing page text: ${parsed.missing.join(', ')}. Sample: ${parsed.sample}`)
  return parsed
}

const clickButton = async (session, name, label) => {
  const clickByDom = async () => {
    const output = await browser(session, [
      'eval',
      `(() => {
        const named = [...document.querySelectorAll('[aria-label], [role="button"], button')]
          .find((element) => element.getAttribute('aria-label') === ${JSON.stringify(name)} || (element.textContent || '').trim() === ${JSON.stringify(name)});
        const textNode = named || [...document.querySelectorAll('*')]
          .reverse()
          .find((element) => (element.textContent || '').trim() === ${JSON.stringify(name)});
        const target = textNode?.closest?.('[role="button"], button, [tabindex]') || textNode;
        if (!target) return JSON.stringify({ ok: false, body: (document.body?.innerText || '').slice(0, 1400) });
        target.scrollIntoView({ block: 'center', inline: 'center' });
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        target.click();
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
    if (!parsed.ok) throw new Error(`${label}: button not found: ${name}. Body: ${parsed.body}`)
    return parsed
  }

  try {
    return await clickByDom()
  } catch (domError) {
    try {
      await browser(session, ['find', 'role', 'button', 'click', '--name', name])
      return { ok: true, method: 'agent-browser-find-role-button' }
    } catch {
      throw domError
    }
  }
}

const clickLastButton = async (session, name, label) => {
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

const readButtonState = async (session, name, label) => {
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

const verifyTradeProposal = async (fixture) => {
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

const waitForTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeProposal(fixture)
  }
  return last
}

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

const verifyPostDeadlineTradeRejected = async (fixture) => {
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

const readBrowserAlerts = async (session) => {
  const output = await browser(session, [
    'eval',
    `(() => JSON.stringify(window.__pancakeAlerts || []))()`,
  ])
  return parseEvalJson(output)
}

const waitForTradeStatus = async (fixture, status, timeoutMs = 10_000) => {
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

const expireAndCompleteAcceptedTrade = async (fixture) => {
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

const verifyFuturePickTradeProposal = async (fixture) => {
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

const waitForFuturePickTradeProposal = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyFuturePickTradeProposal(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyFuturePickTradeProposal(fixture)
  }
  return last
}

const verifyTradeAccepted = async (fixture) => {
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

const waitForTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeAccepted(fixture)
  }
  return last
}

const verifyFuturePickTradeAccepted = async (fixture) => {
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

const waitForFuturePickTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyFuturePickTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyFuturePickTradeAccepted(fixture)
  }
  return last
}

const verifyOverflowTradeAccepted = async (fixture) => {
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

const waitForOverflowTradeAccepted = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyOverflowTradeAccepted(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyOverflowTradeAccepted(fixture)
  }
  return last
}

const verifyTradeTerminalStatus = async (fixture, expectedStatus) => {
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

const waitForTradeTerminalStatus = async (fixture, expectedStatus, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeTerminalStatus(fixture, expectedStatus)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeTerminalStatus(fixture, expectedStatus)
  }
  return last
}

const verifyTradeVetoed = async (fixture) => {
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

const waitForTradeVetoed = async (fixture, timeoutMs = 10_000) => {
  const startedAt = Date.now()
  let last = await verifyTradeVetoed(fixture)
  while (last.failures.length > 0 && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    last = await verifyTradeVetoed(fixture)
  }
  return last
}

const clickTab = async (session, namePrefix, label) => {
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

const openOffersTab = async (session, env) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/trades')])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '2500'])
  await clickTab(session, 'Offers', 'offers tab')
  await browser(session, ['wait', '2500'])
}

export async function runBrowserTradeScenario({
  season = 0,
  sessionName,
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
        'YOU RECEIVE',
        'YOU GIVE',
        fixture.recipientPlayer.display_name,
        fixture.proposerPlayer.display_name,
      ],
      'trade proposal before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-before-submit.png')], { timeout: 60_000 })

    const requestClick = await clickButton(
      session,
      `Select ${fixture.recipientPlayer.display_name} for trade`,
      'recipient player selection',
    )
    const offerClick = await clickButton(
      session,
      `Select ${fixture.proposerPlayer.display_name} for trade`,
      'proposer player selection',
    )
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'trade-selected.png')], { timeout: 60_000 })
    const submitClick = await clickButton(session, 'Send trade proposal', 'trade proposal submit')
    const tradeProposal = await waitForTradeProposal(fixture)
    debug = { ...debug, requestClick, offerClick, submitClick, tradeProposal }
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
  }
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
    await browser(session, ['set', 'viewport', '1180', '900']).catch(() => {})
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
        'MULTI-TEAM BUILDER',
        'YOU SENDS',
        `${fixture.recipient.team_name.toUpperCase()} SENDS`,
        `${fixture.observer.team_name.toUpperCase()} SENDS`,
        fixture.proposerPlayer.display_name,
        fixture.recipientPlayer.display_name,
        fixture.observerPlayer.display_name,
      ],
      'multi-team trade builder loaded',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'multi-team-builder.png')], { timeout: 60_000 })

    const routeClick = await clickButton(
      session,
      `${fixture.recipient.team_name} sends selected assets to ${fixture.observer.team_name}`,
      'multi-team recipient route selection',
    )
    const proposerPlayerClick = await clickButton(
      session,
      `Select ${fixture.proposerPlayer.display_name} for trade`,
      'multi-team proposer player selection',
    )
    const recipientPlayerClick = await clickButton(
      session,
      `Select ${fixture.recipientPlayer.display_name} for trade`,
      'multi-team recipient player selection',
    )
    const observerPlayerClick = await clickButton(
      session,
      `Select ${fixture.observerPlayer.display_name} for trade`,
      'multi-team observer player selection',
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

    await browser(session, ['open', joinUrl(env.frontendUrl, `/propose-trade?editTradeId=${tradeProposal.trade.id}`)])
    await installBrowserHooks(session, env)
    await browser(session, ['wait', '4500'])
    await assertPageText(
      session,
      [
        'Edit Trade',
        'MULTI-TEAM BUILDER',
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
    await browser(counterSession, ['set', 'viewport', '1180', '900']).catch(() => {})
    await browser(counterSession, ['open', joinUrl(env.frontendUrl, `/propose-trade?counterTradeId=${editReplacement.replacement.id}`)])
    await installBrowserHooks(counterSession, env)
    await browser(counterSession, ['wait', '4500'])
    await assertPageText(
      counterSession,
      [
        'Counter Trade',
        'MULTI-TEAM BUILDER',
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

export async function runBrowserTradePostDeadlineScenario({
  season = 0,
  sessionName,
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
        'YOU RECEIVE',
        'YOU GIVE',
        fixture.recipientPlayer.display_name,
        fixture.proposerPlayer.display_name,
        'Trades are locked only from the trade deadline until the champion is finalized.',
      ],
      'post-deadline trade proposal before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'post-deadline-before-submit.png')], { timeout: 60_000 })

    const requestClick = await clickButton(
      session,
      `Select ${fixture.recipientPlayer.display_name} for trade`,
      'post-deadline recipient player selection',
    )
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
    debug = { ...debug, requestClick, offerClick, submitState, alerts, rejected }
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
  }
}

export async function runBrowserTradeAcceptScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeAcceptGameplayFixture(env, season)
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
  }
}

export async function runBrowserTradeFuturePickScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeGameplayFixture(env, season)
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
        'YOU RECEIVE',
        'YOU GIVE',
        'DRAFT PICKS',
        String(fixture.targetFuturePickYear),
        fixture.recipientFuturePick.originalTeamName,
        fixture.proposerFuturePick.originalTeamName,
      ],
      'future-pick trade before submit',
    )
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-before-submit.png')], { timeout: 60_000 })

    const requestPickClick = await clickButton(session, recipientPickLabel, 'recipient future pick selection')
    const offerPickClick = await clickButton(session, proposerPickLabel, 'proposer future pick selection')
    await browser(session, ['wait', '500'])
    await browser(session, ['screenshot', path.join(artifactDir, 'future-pick-selected.png')], { timeout: 60_000 })
    const submitClick = await clickButton(session, 'Send trade proposal', 'future-pick trade proposal submit')
    const tradeProposal = await waitForFuturePickTradeProposal(fixture)
    debug = { ...debug, requestPickClick, offerPickClick, submitClick, tradeProposal }
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
  }
}

export async function runBrowserTradeFuturePickAcceptScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeFuturePickAcceptGameplayFixture(env, season)
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
  }
}

export async function runBrowserTradeOverflowAcceptScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeOverflowAcceptGameplayFixture(env, season)
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
  }
}

export async function runBrowserTradeVetoScenario({
  season = 0,
  sessionName,
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
  }
}

export async function runBrowserTradeTerminalScenario({
  season = 0,
  sessionName,
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
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seasonArg = process.argv.find((arg) => arg.startsWith('--season='))
  const season = seasonArg ? Number(seasonArg.split('=')[1]) : 0
  const runner = process.argv.includes('--terminal')
    ? runBrowserTradeTerminalScenario
    : process.argv.includes('--veto')
      ? runBrowserTradeVetoScenario
    : process.argv.includes('--multi-team')
      ? runBrowserMultiTeamTradeScenario
    : process.argv.includes('--overflow-accept')
      ? runBrowserTradeOverflowAcceptScenario
    : process.argv.includes('--post-deadline')
      ? runBrowserTradePostDeadlineScenario
    : process.argv.includes('--future-pick-accept')
      ? runBrowserTradeFuturePickAcceptScenario
    : process.argv.includes('--future-pick')
      ? runBrowserTradeFuturePickScenario
      : process.argv.includes('--accept')
        ? runBrowserTradeAcceptScenario
        : runBrowserTradeScenario
  runner({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
