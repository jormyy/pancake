import {
  ARTIFACT_ROOT,
  REALTIME_CLIENTS,
  REALTIME_LATENCY_LIMIT_MS,
  REALTIME_SETTLE_MS,
  REALTIME_SUBSCRIBE_TIMEOUT_MS,
  REALTIME_WARMUP_ATTEMPTS,
  ROOT,
  createClient,
  errorMessage,
  execFileAsync,
  fetchAll,
  fetchAllIn,
  fetchSingle,
  indexById,
  mkdir,
  nowMs,
  path,
  resolvedEnv,
  roundedMs,
  sleep,
  sortedLeagueMembers,
  timestamp,
  writeFile,
} from './soak-support.mjs'
import {
  findAvailablePlayer,
  signInForAccessToken,
} from './soak-backend-support.mjs'

const withTimeout = (promise, timeoutMs, message) => {
  let timeout
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout))
}

const waitForRealtimeSubscribe = (channel, label) => withTimeout(
  /** @type {Promise<void>} */
  new Promise((resolve, reject) => {
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolve(undefined)
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(`D.X.2: realtime ${label} subscribe status ${status}${error?.message ? `: ${error.message}` : ''}`))
      }
    })
  }),
  REALTIME_SUBSCRIBE_TIMEOUT_MS,
  `D.X.2: realtime ${label} did not subscribe within ${REALTIME_SUBSCRIBE_TIMEOUT_MS}ms`,
)

const insertRealtimeTargetMatchup = async (supabase, leagueId, season, runSeason) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const members = await sortedLeagueMembers(supabase, leagueId)
  const [home, away] = members
  const baseWeekNumber = 9000 + runSeason * 100 + Math.floor(Date.now() % 100)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await supabase
      .from('matchups')
      .insert({
        league_id: leagueId,
        league_season_id: currentSeason.id,
        week_number: baseWeekNumber + attempt,
        matchup_type: 'regular_season',
        home_member_id: home.id,
        away_member_id: away.id,
        home_points: 0,
        away_points: 0,
        is_finalized: false,
      })
      .select('id, home_member_id, away_member_id')
      .single()
    if (!error) return data
    if (error.code !== '23505') {
      throw new Error(`D.X.2 realtime target matchup insert: ${error.message}`)
    }
  }
  throw new Error('D.X.2 realtime target matchup insert: exhausted unique week_number attempts')
}

const insertRealtimeAuctionTarget = async (supabase, leagueId, season) => {
  const currentSeason = await fetchSingle(
    supabase,
    'league_seasons',
    'id',
    { league_id: leagueId, is_current: true },
  )
  const members = await sortedLeagueMembers(supabase, leagueId)
  if (members.length < 2) throw new Error('D.X.2: realtime bid scenario requires at least two league members')
  const player = await findAvailablePlayer(supabase, leagueId, currentSeason.id)
  const now = new Date().toISOString()

  const { error: cleanupDraftError } = await supabase
    .from('drafts')
    .update({ status: 'completed', completed_at: now })
    .eq('league_id', leagueId)
    .eq('league_season_id', currentSeason.id)
    .eq('draft_type', 'auction')
    .in('status', ['pending', 'in_progress'])
  if (cleanupDraftError) throw new Error(`D.X.2 realtime auction draft cleanup: ${cleanupDraftError.message}`)

  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .insert({
      league_id: leagueId,
      league_season_id: currentSeason.id,
      draft_type: 'auction',
      status: 'in_progress',
      budget_per_team: 10,
      started_at: now,
      current_nomination_order: 1,
    })
    .select('id')
    .single()
  if (draftError) throw new Error(`D.X.2 realtime auction draft insert: ${draftError.message}`)

  const [{ error: orderError }, { error: budgetError }] = await Promise.all([
    supabase.from('draft_orders').insert(members.map((member, index) => ({
      draft_id: draft.id,
      member_id: member.id,
      position: index + 1,
    }))),
    supabase.from('draft_budgets').insert(members.map((member) => ({
      draft_id: draft.id,
      member_id: member.id,
      initial_budget: 10,
      remaining: 10,
    }))),
  ])
  if (orderError) throw new Error(`D.X.2 realtime auction order insert: ${orderError.message}`)
  if (budgetError) throw new Error(`D.X.2 realtime auction budget insert: ${budgetError.message}`)

  const { data: nomination, error: nominationError } = await supabase
    .from('nominations')
    .insert({
      draft_id: draft.id,
      nominating_member_id: members[0].id,
      player_id: player.id,
      nomination_order: 1,
      status: 'open',
      current_bid_amount: 1,
      current_bidder_id: null,
      countdown_expires_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
  if (nominationError) throw new Error(`D.X.2 realtime auction nomination insert: ${nominationError.message}`)

  return {
    draftId: draft.id,
    nominationId: nomination.id,
    bidderOne: members[0].id,
    bidderTwo: members[1].id,
    bidderTwoUserId: members[1].user_id,
    playerId: player.id,
  }
}

export const assertRealtimeDelivery = async ({ supabase, env, state, leagueId, season }) => {
  if (!state?.password || !Array.isArray(state.users) || state.users.length === 0) {
    throw new Error('D.X.2: realtime scenario requires tests/e2e-state.json from npm run e2e:seed')
  }
  if (!env.anonKey) {
    throw new Error(
      'D.X.2: realtime scenario requires E2E_SUPABASE_PUBLISHABLE_KEY or EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    )
  }
  if (!Number.isFinite(REALTIME_CLIENTS) || REALTIME_CLIENTS < 1) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_CLIENTS ${process.env.E2E_REALTIME_CLIENTS}`)
  }
  if (!Number.isFinite(REALTIME_LATENCY_LIMIT_MS) || REALTIME_LATENCY_LIMIT_MS < 100) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_LATENCY_LIMIT_MS ${process.env.E2E_REALTIME_LATENCY_LIMIT_MS}`)
  }
  if (!Number.isFinite(REALTIME_SUBSCRIBE_TIMEOUT_MS) || REALTIME_SUBSCRIBE_TIMEOUT_MS < REALTIME_LATENCY_LIMIT_MS) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS ${process.env.E2E_REALTIME_SUBSCRIBE_TIMEOUT_MS}`)
  }
  if (!Number.isInteger(REALTIME_WARMUP_ATTEMPTS) || REALTIME_WARMUP_ATTEMPTS < 1) {
    throw new Error(`D.X.2: invalid E2E_REALTIME_WARMUP_ATTEMPTS ${process.env.E2E_REALTIME_WARMUP_ATTEMPTS}`)
  }

  const target = await insertRealtimeTargetMatchup(supabase, leagueId, season, season)
  const bidTarget = await insertRealtimeAuctionTarget(supabase, leagueId, season)
  const clients = []
  const channels = []
  const warmupDeliveries = []
  const deliveries = []
  const bidDeliveries = []
  const warmupHomePoints = 500 + season * 10
  const warmupAwayPoints = 400 + season * 10
  const expectedHomePoints = 1000 + season
  const expectedAwayPoints = 900 + season
  const expectedBidAmount = 2
  const warmupSeen = new Set()
  let bidSucceeded = false
  const realtimeAccessToken = await signInForAccessToken(
    env,
    state.users[0].email,
    state.password,
    'D.X.2 realtime sign-in',
  )

  try {
    const setups = Array.from({ length: REALTIME_CLIENTS }, (_, index) => {
      const client = createClient(env.supabaseUrl, env.anonKey, {
        auth: { persistSession: false },
        realtime: { transport: WebSocket, timeout: REALTIME_SUBSCRIBE_TIMEOUT_MS },
      })
      client.realtime.setAuth(realtimeAccessToken)

      let resolveWarmup
      const warmupDelivery = new Promise((resolve) => {
        resolveWarmup = resolve
      })
      const channel = client.channel(`e2e_realtime_${season}_${index}`)
      const delivery = new Promise((resolve) => {
        channel.on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'matchups',
            filter: `id=eq.${target.id}`,
          }, (payload) => {
            const homePoints = Number(payload.new?.home_points)
            const awayPoints = Number(payload.new?.away_points)
            const warmupAttempt = homePoints - warmupHomePoints
            if (
              warmupAttempt >= 0 &&
              warmupAttempt < REALTIME_WARMUP_ATTEMPTS &&
              awayPoints === warmupAwayPoints + warmupAttempt
            ) {
              warmupSeen.add(index)
              resolveWarmup({ clientIndex: index, receivedAtMs: nowMs() })
            }
            if (
              homePoints === expectedHomePoints &&
              awayPoints === expectedAwayPoints
            ) {
              resolve({ clientIndex: index, receivedAtMs: nowMs() })
            }
          })
      })
      const bidDelivery = new Promise((resolve) => {
        channel.on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'nominations',
          filter: `id=eq.${bidTarget.nominationId}`,
        }, (payload) => {
          if (
            Number(payload.new?.current_bid_amount) === expectedBidAmount &&
            payload.new?.current_bidder_id === bidTarget.bidderTwo
          ) {
            resolve({ clientIndex: index, receivedAtMs: nowMs() })
          }
        })
      })
      return { client, channel, warmupDelivery, delivery, bidDelivery }
    })
    clients.push(...setups.map(({ client }) => client))
    channels.push(...setups.map(({ client, channel }) => ({ client, channel })))
    warmupDeliveries.push(...setups.map(({ warmupDelivery }) => warmupDelivery))
    deliveries.push(...setups.map(({ delivery }) => delivery))
    bidDeliveries.push(...setups.map(({ bidDelivery }) => bidDelivery))

    await Promise.all(channels.map(({ channel }, index) => waitForRealtimeSubscribe(channel, `client ${index + 1}`)))
    await sleep(REALTIME_SETTLE_MS)
    for (let attempt = 0; attempt < REALTIME_WARMUP_ATTEMPTS && warmupSeen.size < REALTIME_CLIENTS; attempt += 1) {
      const { error: warmupError } = await supabase
        .from('matchups')
        .update({
          home_points: warmupHomePoints + attempt,
          away_points: warmupAwayPoints + attempt,
        })
        .eq('id', target.id)
      if (warmupError) throw new Error(`D.X.2 realtime warmup update ${attempt + 1}: ${warmupError.message}`)
      await sleep(Math.min(REALTIME_LATENCY_LIMIT_MS, 2000))
    }
    await withTimeout(
      Promise.all(warmupDeliveries),
      1000,
      `D.X.2: realtime warmup update reached ${warmupSeen.size}/${REALTIME_CLIENTS} clients after ${REALTIME_WARMUP_ATTEMPTS} attempts`,
    )

    const updateStartedMs = nowMs()
    const { error: updateError } = await supabase
      .from('matchups')
      .update({
        home_points: expectedHomePoints,
        away_points: expectedAwayPoints,
      })
      .eq('id', target.id)
    if (updateError) throw new Error(`D.X.2 realtime matchup update: ${updateError.message}`)
    const updateCommittedMs = nowMs()

    const results = await withTimeout(
      Promise.all(deliveries),
      REALTIME_LATENCY_LIMIT_MS,
      `D.X.2: realtime update did not reach all ${REALTIME_CLIENTS} clients within ${REALTIME_LATENCY_LIMIT_MS}ms`,
    )
    const latenciesMs = results.map((result) => Math.max(0, result.receivedAtMs - updateCommittedMs))
    const maxLatencyMs = Math.max(...latenciesMs)
    if (maxLatencyMs > REALTIME_LATENCY_LIMIT_MS) {
      throw new Error(`D.X.2: realtime max latency ${roundedMs(maxLatencyMs)}ms exceeded ${REALTIME_LATENCY_LIMIT_MS}ms`)
    }

    const bidStartedMs = nowMs()
    const { error: bidError } = await supabase.rpc('place_auction_bid_atomic', {
      p_draft_id: bidTarget.draftId,
      p_member_id: bidTarget.bidderTwo,
      p_nomination_id: bidTarget.nominationId,
      p_amount: expectedBidAmount,
      p_user_id: bidTarget.bidderTwoUserId,
    })
    if (bidError) throw new Error(`D.X.2 realtime auction bid RPC: ${bidError.message}`)
    bidSucceeded = true
    const bidCommittedMs = nowMs()

    const bidResults = await withTimeout(
      Promise.all(bidDeliveries),
      REALTIME_LATENCY_LIMIT_MS,
      `D.X.2: realtime bid update did not reach all ${REALTIME_CLIENTS} clients within ${REALTIME_LATENCY_LIMIT_MS}ms`,
    )
    const bidLatenciesMs = bidResults.map((result) => Math.max(0, result.receivedAtMs - bidCommittedMs))
    const maxBidLatencyMs = Math.max(...bidLatenciesMs)
    if (maxBidLatencyMs > REALTIME_LATENCY_LIMIT_MS) {
      throw new Error(`D.X.2: realtime bid max latency ${roundedMs(maxBidLatencyMs)}ms exceeded ${REALTIME_LATENCY_LIMIT_MS}ms`)
    }

    await writeFile(
      path.join(ARTIFACT_ROOT, `season-${season}`, 'realtime-latency.json'),
      `${JSON.stringify({
        season,
        matchupId: target.id,
        draftId: bidTarget.draftId,
        nominationId: bidTarget.nominationId,
        clients: REALTIME_CLIENTS,
        updateRoundTripMs: roundedMs(updateCommittedMs - updateStartedMs),
        maxLatencyMs: roundedMs(maxLatencyMs),
        latenciesMs: latenciesMs.map((latency) => roundedMs(latency)),
        bidRoundTripMs: roundedMs(bidCommittedMs - bidStartedMs),
        maxBidLatencyMs: roundedMs(maxBidLatencyMs),
        bidLatenciesMs: bidLatenciesMs.map((latency) => roundedMs(latency)),
      }, null, 2)}\n`,
    )
  } finally {
    const closedAt = new Date().toISOString()
    await supabase
      .from('nominations')
      .update(bidSucceeded
        ? {
            status: 'sold',
            winning_member_id: bidTarget.bidderTwo,
            final_price: expectedBidAmount,
            countdown_expires_at: null,
            closed_at: closedAt,
          }
        : {
            status: 'no_bid',
            countdown_expires_at: null,
            closed_at: closedAt,
          })
      .eq('id', bidTarget.nominationId)
      .eq('status', 'open')
    await supabase
      .from('drafts')
      .update({ status: 'completed', completed_at: closedAt })
      .eq('id', bidTarget.draftId)
    await Promise.allSettled(channels.map(({ client, channel }) => client.removeChannel(channel)))
    await Promise.allSettled(clients.map(async (client) => {
      if (typeof client.removeAllChannels === 'function') {
        await client.removeAllChannels()
      }
      await client.auth.signOut()
      if (typeof client.realtime?.disconnect === 'function') {
        client.realtime.disconnect()
      }
    }))
    await sleep(100)
  }
}

export const applyMidlifeMigration = async (season) => {
  const artifactDir = path.join(ARTIFACT_ROOT, `season-${season}`)
  await mkdir(artifactDir, { recursive: true })
  const startedAt = timestamp()
  const target = (process.env.E2E_MIDLIFE_MIGRATION_TARGET ?? '').trim().toLowerCase()
  const env = resolvedEnv()
  const dbUrl = process.env.E2E_MIDLIFE_MIGRATION_DB_URL ?? env.dbUrl
  const expectedVersion = process.env.E2E_MIDLIFE_EXPECTED_VERSION
  if (!dbUrl) throw new Error('D.LONG.5 requires E2E_MIDLIFE_MIGRATION_DB_URL or SUPABASE_DB_URL for migration evidence')
  if (!expectedVersion) throw new Error('D.LONG.5 requires E2E_MIDLIFE_EXPECTED_VERSION')
  const isLocalSupabase = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(env.supabaseUrl ?? '')
  const command = process.env.E2E_MIDLIFE_MIGRATION_DB_URL
    ? ['db', 'push', '--db-url', process.env.E2E_MIDLIFE_MIGRATION_DB_URL, '--yes']
    : target === 'linked'
      ? ['db', 'push', '--linked', '--yes']
      : ['db', 'push', isLocalSupabase || target === 'local' ? '--local' : '--linked', '--yes']
  const readVersions = async () => {
    const { stdout } = await execFileAsync('psql', [
      dbUrl,
      '--tuples-only',
      '--no-align',
      '--command',
      'select version from supabase_migrations.schema_migrations order by version',
    ], { cwd: ROOT, timeout: 30_000, maxBuffer: 1024 * 1024 })
    return stdout.split(/\r?\n/).map((version) => version.trim()).filter(Boolean)
  }
  const beforeVersions = await readVersions()
  const report = {
    command: `supabase ${command.join(' ')}`,
    target: process.env.E2E_MIDLIFE_MIGRATION_DB_URL ? 'db-url' : target || (isLocalSupabase ? 'local' : 'linked'),
    expectedVersion,
    beforeVersions,
    afterVersions: /** @type {string[]} */ ([]),
    appliedVersions: /** @type {string[]} */ ([]),
    startedAt,
    finishedAt: /** @type {string | null} */ (null),
    status: 'ERROR',
    stdout: '',
    stderr: '',
  }

  try {
    if (beforeVersions.includes(expectedVersion)) {
      throw new Error(`expected migration ${expectedVersion} was already applied before the mid-life boundary`)
    }
    const { stdout, stderr } = await execFileAsync('supabase', command, {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 4,
    })
    report.stdout = stdout
    report.stderr = stderr
    report.afterVersions = await readVersions()
    report.appliedVersions = report.afterVersions.filter((version) => !beforeVersions.includes(version))
    if (report.appliedVersions.length === 0) throw new Error('database applied no migrations at the mid-life boundary')
    if (!report.appliedVersions.includes(expectedVersion)) {
      throw new Error(`mid-life migration delta did not include expected version ${expectedVersion}`)
    }
    const beforeHead = beforeVersions.at(-1)
    if (beforeHead && report.appliedVersions.some((version) => version <= beforeHead)) {
      throw new Error('mid-life migration delta did not strictly advance the database head')
    }
    report.status = 'APPLIED'
    return report
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error) report.stdout = String(error.stdout ?? '')
    if (error && typeof error === 'object' && 'stderr' in error) report.stderr = String(error.stderr ?? '')
    throw new Error(`D.LONG.5 mid-life migration failed: ${errorMessage(error)}`)
  } finally {
    report.finishedAt = timestamp()
    await writeFile(
      path.join(artifactDir, 'midlife-migration.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    )
  }
}

export const runInvariants = async (supabase, leagueId, scenarios = {}) => {
  const leagueFilter = leagueId ? { league_id: leagueId } : {}
  const [
    leagues,
    leagueSeasons,
    leagueMembers,
    rosterPlayers,
    weeklyLineups,
    waiverClaims,
    trades,
    draftPicks,
    drafts,
  ] = await Promise.all([
    leagueId ? fetchAll(supabase, 'leagues', 'id', { id: leagueId }) : fetchAll(supabase, 'leagues', 'id'),
    fetchAll(supabase, 'league_seasons', 'id, league_id, is_current', leagueFilter),
    fetchAll(supabase, 'league_members', 'id, league_id', leagueFilter),
    fetchAll(supabase, 'roster_players', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'weekly_lineups', 'id, league_id, league_season_id, member_id, player_id', leagueFilter),
    fetchAll(supabase, 'waiver_claims', 'id, league_id, league_season_id, member_id, player_id, drop_player_id, status, process_date', leagueFilter),
    fetchAll(supabase, 'trades', 'id, league_id, league_season_id, proposer_member_id, recipient_member_id, status, veto_window_expires_at', leagueFilter),
    fetchAll(supabase, 'draft_picks', 'id, league_id, season_year, round, current_owner_id, original_owner_id', leagueFilter),
    fetchAll(supabase, 'drafts', 'id, league_id', leagueFilter),
  ])

  const failures = []
  const leagueIds = new Set(leagues.map((row) => row.id))
  const seasonIds = indexById(leagueSeasons)
  const membersById = indexById(leagueMembers)
  const draftIds = new Set(drafts.map((draft) => draft.id))
  const tradeIds = new Set(trades.map((trade) => trade.id))
  const scopedTradeItems = leagueId
    ? await fetchAllIn(supabase, 'trade_items', 'id, trade_id, player_id, pick_id', 'trade_id', [...tradeIds])
    : await fetchAll(supabase, 'trade_items', 'id, trade_id, player_id, pick_id')
  const scopedNominations = leagueId
    ? await fetchAllIn(supabase, 'nominations', 'id, draft_id, status, countdown_expires_at', 'draft_id', [...draftIds])
    : await fetchAll(supabase, 'nominations', 'id, draft_id, status, countdown_expires_at')

  if (leagues.length === 0) {
    failures.push(leagueId ? `D.SET.2: target league ${leagueId} does not exist` : 'D.SET.2: no leagues exist in the test project')
  }

  for (const league of leagues) {
    const current = leagueSeasons.filter((season) => season.league_id === league.id && season.is_current)
    if (current.length !== 1) {
      failures.push(`I0: league ${league.id} has ${current.length} current seasons`)
      continue
    }

    const [currentSeason] = current
    const members = leagueMembers.filter((member) => member.league_id === league.id)
    const memberIds = new Set(members.map((member) => member.id))
    const pickKeys = new Set(
      draftPicks
        .filter((pick) => pick.league_id === league.id)
        .map((pick) => `${pick.season_year}:${pick.round}:${pick.original_owner_id}`),
    )
    const currentYear = currentSeason.season_year
    for (let seasonYear = currentYear + 1; seasonYear <= currentYear + 5; seasonYear += 1) {
      for (let round = 1; round <= 3; round += 1) {
        for (const memberId of memberIds) {
          if (!pickKeys.has(`${seasonYear}:${round}:${memberId}`)) {
            failures.push(`D.SEA.6: league ${league.id} missing future pick ${seasonYear} round ${round} for member ${memberId}`)
          }
        }
      }
    }
  }

  for (const pick of draftPicks) {
    const owner = membersById.get(pick.current_owner_id)
    const originalOwner = membersById.get(pick.original_owner_id)
    if (!owner || owner.league_id !== pick.league_id) {
      failures.push(`I2: draft_pick ${pick.id} current_owner_id does not resolve within league`)
    }
    if (!originalOwner || originalOwner.league_id !== pick.league_id) {
      failures.push(`I2: draft_pick ${pick.id} original_owner_id does not resolve within league`)
    }
  }

  if (scenarios.futurePickChain) {
    const targetPick = draftPicks.find((pick) => pick.id === scenarios.futurePickChain.targetPickId)
    if (!targetPick) {
      failures.push(`D.LONG.2: target multi-hop pick ${scenarios.futurePickChain.targetPickId} is missing`)
    } else if (targetPick.current_owner_id !== scenarios.futurePickChain.finalOwnerId) {
      failures.push(
        `D.LONG.2: target multi-hop pick ${targetPick.id} owner drifted to ${targetPick.current_owner_id}; expected ${scenarios.futurePickChain.finalOwnerId}`,
      )
    }
  }

  const rosterKeys = new Set()
  for (const rosterPlayer of rosterPlayers) {
    const key = `${rosterPlayer.league_id}:${rosterPlayer.league_season_id}:${rosterPlayer.player_id}`
    if (rosterKeys.has(key)) {
      failures.push(`I3: duplicate roster player ownership for ${key}`)
    }
    rosterKeys.add(key)
  }

  const assertLeagueSeasonMember = (label, row, memberKeys) => {
    if (!leagueIds.has(row.league_id)) failures.push(`I6: ${label} ${row.id} has orphan league_id`)
    if (!seasonIds.has(row.league_season_id)) failures.push(`I6: ${label} ${row.id} has orphan league_season_id`)
    for (const key of memberKeys) {
      const member = membersById.get(row[key])
      if (!member || member.league_id !== row.league_id) {
        failures.push(`I6: ${label} ${row.id} has invalid ${key}`)
      }
    }
  }

  for (const row of rosterPlayers) assertLeagueSeasonMember('roster_players', row, ['member_id'])
  for (const row of weeklyLineups) assertLeagueSeasonMember('weekly_lineups', row, ['member_id'])
  for (const row of waiverClaims) assertLeagueSeasonMember('waiver_claims', row, ['member_id'])
  for (const row of trades) assertLeagueSeasonMember('trades', row, ['proposer_member_id', 'recipient_member_id'])

  const pickIds = new Set(draftPicks.map((pick) => pick.id))
  for (const item of scopedTradeItems) {
    if (!tradeIds.has(item.trade_id)) failures.push(`I6: trade_items ${item.id} has orphan trade_id`)
    if (item.pick_id && !pickIds.has(item.pick_id)) failures.push(`I6: trade_items ${item.id} has orphan pick_id`)
  }

  const now = new Date()
  for (const nomination of scopedNominations) {
    if (
      nomination.status === 'open' &&
      nomination.countdown_expires_at &&
      new Date(nomination.countdown_expires_at) < now
    ) {
      failures.push(`I7: nomination ${nomination.id} is open past countdown_expires_at`)
    }
  }

  for (const trade of trades) {
    if (
      trade.status === 'accepted' &&
      trade.veto_window_expires_at &&
      new Date(trade.veto_window_expires_at) < now
    ) {
      failures.push(`I7: trade ${trade.id} is pending completion past veto_window_expires_at`)
    }
  }

  const today = now.toISOString().slice(0, 10)
  for (const claim of waiverClaims) {
    if (claim.status === 'pending' && claim.process_date < today) {
      failures.push(`I7: waiver_claim ${claim.id} is pending past process_date`)
    }
  }

  return failures
}
