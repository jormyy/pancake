import { notifyMember } from '../_shared/notifications.ts'
import { supabase } from '../_shared/supabase.ts'
import {
  assertUuid,
  integerField,
  json,
  optionalStringField,
  readJsonObject,
  requireCommissioner,
  requireCommissionerForDraft,
  requireUser,
  throwDb,
  uuidField,
  ValidationError,
  verifyOwnMember,
} from '../_shared/apiRuntime.ts'

const NOMINATION_COUNTDOWN_SECONDS = 30
const MIN_BID = 1
const ROOKIE_DRAFT_ROUNDS = 3
const DEFAULT_ROSTER_SIZE = 20
const DEFAULT_TAXI_SLOTS = 2
const NOMINATION_ORDER_MODES = ['user_nominated', 'by_projection', 'alphabetical'] as const
type NominationOrderMode = (typeof NOMINATION_ORDER_MODES)[number]

function splitDraftAction(path: string): { draftId: string; action: string } | null {
  const match = path.match(/^\/draft\/([^/]+)\/([^/]+)$/)
  if (!match) return null
  assertUuid(match[1], 'draftId')
  return { draftId: match[1], action: match[2] }
}

function nominationOrderMode(body: Record<string, unknown>): NominationOrderMode {
  const value = optionalStringField(body, 'nominationOrderMode') ?? 'user_nominated'
  if (!NOMINATION_ORDER_MODES.includes(value as NominationOrderMode)) {
    throw new ValidationError(`Invalid nomination order mode: ${value}`)
  }
  return value as NominationOrderMode
}

async function startDraft(leagueId: string, mode: NominationOrderMode): Promise<unknown> {
  const { data, error } = await supabase.rpc('start_auction_draft_atomic', {
    p_league_id: leagueId,
    p_nomination_order_mode: mode,
  })
  if (error) throwDb(error)
  return data
}

async function stopDraft(draftId: string): Promise<void> {
  const { error } = await (supabase as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>
  }).rpc('stop_draft_atomic', { p_draft_id: draftId })
  if (error) throwDb(error)
}

async function resetDraft(draftId: string): Promise<void> {
  const { error } = await (supabase as unknown as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>
  }).rpc('reset_draft_atomic', { p_draft_id: draftId })
  if (error) throwDb(error)
}

async function nominatePlayer(draftId: string, memberId: string, playerId: string, userId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('create_auction_nomination_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_player_id: playerId,
    p_user_id: userId,
    p_countdown_seconds: NOMINATION_COUNTDOWN_SECONDS,
  })
  if (error) {
    if (error.code === '23505') {
      if (error.message?.includes('nominations_one_open_per_draft')) {
        throw new ValidationError('A nomination is already open - wait for it to close')
      }
      throw new ValidationError('Player already nominated in this draft')
    }
    throwDb(error)
  }
  return data
}

async function placeBid(
  draftId: string,
  memberId: string,
  nominationId: string,
  amount: number,
  userId: string,
): Promise<void> {
  if (!Number.isInteger(amount) || amount < MIN_BID) {
    throw new ValidationError('Bid amount must be a positive integer')
  }

  const { error } = await supabase.rpc('place_auction_bid_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_nomination_id: nominationId,
    p_amount: amount,
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

async function withdrawNomination(
  draftId: string,
  memberId: string,
  nominationId: string,
  userId: string,
): Promise<{ withdrawn: boolean }> {
  const { data: visibleNomination, error: visibleError } = await supabase
    .from('nominations')
    .select('id')
    .eq('id', nominationId)
    .eq('draft_id', draftId)
    .eq('nominating_member_id', memberId)
    .eq('status', 'open')
    .maybeSingle()
  if (visibleError) throwDb(visibleError)
  if (!visibleNomination) return { withdrawn: false }

  const { data, error } = await supabase.rpc('withdraw_auction_nomination_atomic', {
    p_nomination_id: nominationId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
  return { withdrawn: Boolean(data) }
}

export async function startRookieDraft(leagueId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('start_rookie_draft_atomic', {
    p_league_id: leagueId,
    p_rounds: ROOKIE_DRAFT_ROUNDS,
  })
  if (error) throwDb(error)
  return data
}

async function makeSnakePick(draftId: string, memberId: string, playerId: string): Promise<Record<string, unknown>> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('make_snake_pick_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_player_id: playerId,
  })
  if (rpcError) throwDb(rpcError)

  const result = rpcData as {
    pick: { id: string; overall_pick: number; round: number; pick_in_round: number; member_id: string; draft_pick_id: string | null }
    remaining: number
    league_id: string
    league_season_id: string
  }

  const { data: leagueRow, error: leagueError } = await supabase
    .from('leagues')
    .select('roster_size, taxi_slots')
    .eq('id', result.league_id)
    .single()
  if (leagueError) throwDb(leagueError)

  const [{ count: activeCount, error: activeError }, { count: taxiCount, error: taxiError }] = await Promise.all([
    supabase
      .from('roster_players')
      .select('id', { count: 'exact', head: true })
      .eq('member_id', memberId)
      .eq('league_season_id', result.league_season_id)
      .eq('is_on_ir', false)
      .eq('is_on_taxi', false),
    supabase
      .from('roster_players')
      .select('id', { count: 'exact', head: true })
      .eq('member_id', memberId)
      .eq('league_season_id', result.league_season_id)
      .eq('is_on_taxi', true),
  ])
  if (activeError) throwDb(activeError)
  if (taxiError) throwDb(taxiError)

  const { data: pickedPlayer } = await supabase
    .from('players')
    .select('display_name')
    .eq('id', playerId)
    .single()
  await notifyMember(
    memberId,
    'Rookie Draft Pick Made',
    `${pickedPlayer?.display_name ?? 'A player'} has been added to your roster.`,
    {
      draftId,
      playerId,
      pickId: result.pick.id,
      overallPick: result.pick.overall_pick,
      round: result.pick.round,
    },
  ).catch(console.error)

  return {
    pick: result.pick,
    remaining: result.remaining,
    rosterOverflow: (activeCount ?? 0) > (leagueRow?.roster_size ?? DEFAULT_ROSTER_SIZE),
    taxiSlotsAvailable: (taxiCount ?? 0) < (leagueRow?.taxi_slots ?? DEFAULT_TAXI_SLOTS),
    newPlayerId: playerId,
  }
}

export async function autoPickBest(draftId: string, memberId: string): Promise<Record<string, unknown>> {
  const { data: pickedRows, error: pickedError } = await supabase
    .from('snake_draft_picks')
    .select('player_id')
    .eq('draft_id', draftId)
    .not('player_id', 'is', null)
  if (pickedError) throwDb(pickedError)

  const pickedIds = new Set((pickedRows ?? []).map((row) => row.player_id))
  const { data: players, error: playerError } = await supabase
    .from('players')
    .select('id')
    .not('nba_draft_number', 'is', null)
    .eq('years_exp', 0)
    .order('nba_draft_number', { ascending: true })
    .order('id', { ascending: true })
    .limit(100)
  if (playerError) throwDb(playerError)

  const best = (players ?? []).find((player) => !pickedIds.has(player.id))
  if (!best) throw new ValidationError('No available players for auto-pick')
  return makeSnakePick(draftId, memberId, best.id)
}

async function reseedRookieDraftPicks(draftId: string): Promise<{ reseeded: number }> {
  const { data, error } = await supabase.rpc('reseed_rookie_draft_picks_atomic', {
    p_draft_id: draftId,
    p_rounds: ROOKIE_DRAFT_ROUNDS,
  })
  if (error) throwDb(error)
  return { reseeded: Number(data ?? 0) }
}

export async function handleDraftRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null

  if (path === '/draft/start') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const leagueId = uuidField(body, 'leagueId')
    await requireCommissioner(userId, leagueId)
    return json({ ok: true, draft: await startDraft(leagueId, nominationOrderMode(body)) })
  }

  if (path === '/draft/start-rookie') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const leagueId = uuidField(body, 'leagueId')
    await requireCommissioner(userId, leagueId)
    return json({ ok: true, draft: await startRookieDraft(leagueId) })
  }

  const action = splitDraftAction(path)
  if (!action) return null

  const { draftId } = action
  const body = await readJsonObject(req)
  const userId = await requireUser(req)

  if (action.action === 'stop') {
    await requireCommissionerForDraft(userId, draftId)
    await stopDraft(draftId)
    return json({ ok: true })
  }

  if (action.action === 'reset') {
    await requireCommissionerForDraft(userId, draftId)
    await resetDraft(draftId)
    return json({ ok: true })
  }

  if (action.action === 'nominate') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, nomination: await nominatePlayer(draftId, memberId, uuidField(body, 'playerId'), userId) })
  }

  if (action.action === 'bid') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    await placeBid(draftId, memberId, uuidField(body, 'nominationId'), integerField(body, 'amount', { min: MIN_BID, max: 1_000_000 }), userId)
    return json({ ok: true })
  }

  if (action.action === 'withdraw-nomination') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, ...await withdrawNomination(draftId, memberId, uuidField(body, 'nominationId'), userId) })
  }

  if (action.action === 'snake-pick') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, ...await makeSnakePick(draftId, memberId, uuidField(body, 'playerId')) })
  }

  if (action.action === 'auto-pick') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, ...await autoPickBest(draftId, memberId) })
  }

  if (action.action === 'reseed-picks') {
    await requireCommissionerForDraft(userId, draftId)
    return json({ ok: true, ...await reseedRookieDraftPicks(draftId) })
  }

  return null
}
