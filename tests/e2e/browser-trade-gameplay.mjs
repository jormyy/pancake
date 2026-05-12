import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { resolvedEnv, requireEnv, describeEndpoint } from './env.mjs'

const execFileAsync = promisify(execFile)
const ROOT = process.cwd()
const ARTIFACT_ROOT = path.join(ROOT, 'tests/artifacts')
const REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-report.md')
const ACCEPT_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-accept-report.md')
const TERMINAL_REPORT_PATH = path.join(ROOT, 'tests/e2e-browser-trade-terminal-report.md')

const browser = async (session, args, options = {}) => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['--session', session, ...args], {
    cwd: ROOT,
    timeout: options.timeout ?? 30_000,
    maxBuffer: options.maxBuffer ?? 1024 * 1024 * 4,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const listSessions = async () => {
  const { stdout, stderr } = await execFileAsync('agent-browser', ['session', 'list'], {
    cwd: ROOT,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  })
  return [stdout, stderr].filter(Boolean).join('\n').trim()
}

const safeName = (value) => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const joinUrl = (base, pathname) => new URL(pathname, base.endsWith('/') ? base : `${base}/`).toString()

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
  if (available.length < count) {
    throw new Error(`D.SEA.2 browser trade: only ${available.length} available players found; need ${count}`)
  }
  return available.slice(0, count)
}

const setupTradeGameplayFixture = async (env, season) => {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${process.pid}-${season}`
  const password = `Pancake-trade-${runId}!`
  const users = [1, 2].map((n) => ({
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

  const recipientClient = await signInClient(env, createdUsers[1].email, password)
  const { error: joinError } = await recipientClient.rpc('join_league_by_invite_code', {
    p_invite_code: league.invite_code,
    p_team_name: createdUsers[1].teamName,
  })
  if (joinError) throw new Error(`join_league_by_invite_code: ${joinError.message}`)

  const currentSeason = await fetchCurrentSeason(admin, league.id)
  const members = await sortedLeagueMembers(admin, league.id)
  if (members.length !== 2) throw new Error(`D.SEA.2 browser trade: expected 2 members, got ${members.length}`)
  const proposer = members.find((member) => member.user_id === createdUsers[0].id)
  const recipient = members.find((member) => member.user_id === createdUsers[1].id)
  if (!proposer || !recipient) throw new Error('D.SEA.2 browser trade: member lookup failed')

  const [proposerPlayer, recipientPlayer] = await findAvailablePlayers(admin, league.id, currentSeason.id, 2)
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

  return {
    admin,
    runId,
    password,
    users: createdUsers,
    league,
    currentSeason,
    proposer,
    recipient,
    proposerPlayer,
    recipientPlayer,
  }
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

const installBrowserHooks = async (session, env) => {
  await browser(session, [
    'eval',
    `(() => {
      window.localStorage.setItem('PANCAKE_API_URL', ${JSON.stringify(env.apiBaseUrl)});
      window.__pancakeAlerts = [];
      window.alert = (message) => window.__pancakeAlerts.push(String(message));
      window.confirm = (message) => {
        window.__pancakeAlerts.push(String(message));
        return true;
      };
      return JSON.stringify({ ok: true });
    })()`,
  ])
}

const signInBrowser = async (session, env, user, password) => {
  await browser(session, ['open', env.frontendUrl])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '1500'])
  await browser(session, ['find', 'placeholder', 'Email', 'fill', user.email])
  await browser(session, ['find', 'placeholder', 'Password', 'fill', password])
  await browser(session, ['find', 'text', 'Sign In', 'click'])
  await browser(session, ['wait', '4000'])
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

const openOffersTab = async (session, env) => {
  await browser(session, ['open', joinUrl(env.frontendUrl, '/trades')])
  await installBrowserHooks(session, env)
  await browser(session, ['wait', '2500'])
  await clickButton(session, 'Show Offers trades', 'offers tab')
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
  const session = sessionName ?? safeName(`pancake-trade-${fixture.runId}-${process.pid}`)
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
    if (errorOutput.trim()) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
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

export async function runBrowserTradeAcceptScenario({
  season = 0,
  sessionName,
} = {}) {
  const env = resolvedEnv()
  requireEnv(env, ['supabaseUrl', 'serviceRoleKey', 'anonKey'])
  const fixture = await setupTradeAcceptGameplayFixture(env, season)
  const sessionList = await listSessions().catch((error) => `session list unavailable: ${error.message}`)
  const session = sessionName ?? safeName(`pancake-trade-accept-${fixture.runId}-${process.pid}`)
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
    if (errorOutput.trim()) failures.push(`browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'errors.txt'))}`)
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
    : safeName(`pancake-trade-reject-${rejectFixture.runId}-${process.pid}`)
  const withdrawSession = sessionName
    ? `${safeName(sessionName)}-withdraw`
    : safeName(`pancake-trade-withdraw-${withdrawFixture.runId}-${process.pid}`)
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
    if (rejectErrors.trim()) failures.push(`reject browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'reject-errors.txt'))}`)
    if (withdrawErrors.trim()) failures.push(`withdraw browser errors present; see ${path.relative(ROOT, path.join(artifactDir, 'withdraw-errors.txt'))}`)
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
    : process.argv.includes('--accept')
      ? runBrowserTradeAcceptScenario
      : runBrowserTradeScenario
  runner({ season }).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
