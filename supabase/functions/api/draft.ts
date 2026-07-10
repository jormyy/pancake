import { notifyMember } from '../_shared/notifications.ts'
import type { Json } from '../_shared/database.ts'
import { supabase } from '../_shared/supabase.ts'
import {
  assertUuid,
  integerField,
  json,
  optionalBooleanField,
  optionalIntegerField,
  optionalStringField,
  readJsonObject,
  NotFoundError,
  requireCommissioner,
  requireCommissionerForDraft,
  requireUser,
  throwDb,
  uuidField,
  ValidationError,
  verifyOwnMember,
} from '../_shared/apiRuntime.ts'

const MIN_BID = 1
const ROOKIE_DRAFT_ROUNDS = 3
const MAX_ROOKIE_DRAFT_ROUNDS = 3
const DEFAULT_ROSTER_SIZE = 20
const DEFAULT_TAXI_SLOTS = 2
const DEFAULT_DRAFT_TIMER_SECONDS = 30
const PRESENCE_CLAIM_TTL_SECONDS = 10 * 60
const NOMINATION_ORDER_MODES = ['user_nominated', 'by_projection', 'alphabetical'] as const
const ROOKIE_TIMER_EXPIRY_BEHAVIORS = ['auto_pick', 'skip_pick', 'pause_draft', 'commissioner_pick'] as const
type NominationOrderMode = (typeof NOMINATION_ORDER_MODES)[number]
type RookieTimerExpiryBehavior = (typeof ROOKIE_TIMER_EXPIRY_BEHAVIORS)[number]
type SnakePickResult = {
  pick: {
    id: string
    overall_pick: number
    round: number
    pick_in_round: number
    member_id: string
    draft_pick_id: string | null
  }
  remaining: number
  league_id: string
  league_season_id: string
  is_mock: boolean
}
type AuctionDraftStartOptions = {
  isMock: boolean
  timerSeconds: number
  budgetPerTeam: number | null
}
type RookieDraftStartOptions = {
  isMock: boolean
  timerSeconds: number
  rounds: number
  timerExpiryBehavior: RookieTimerExpiryBehavior
}
type MockDraftRoomOptions = {
  draftType: 'auction' | 'snake'
  roomName: string | null
  scheduledAt: string | null
  nominationOrderMode: NominationOrderMode
  timerSeconds: number
  budgetPerTeam: number | null
  rounds: number
  timerExpiryBehavior: RookieTimerExpiryBehavior
}

function jsonObject(value: Json | undefined, label: string): { [key: string]: Json | undefined } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
  return value
}

function jsonString(value: Json | undefined, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  return value
}

function jsonNumber(value: Json | undefined, label: string): number {
  if (typeof value !== 'number') throw new Error(`${label} must be a number.`)
  return value
}

function jsonBoolean(value: Json | undefined, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`)
  return value
}

function jsonNullableString(value: Json | undefined, label: string): string | null {
  if (value === null) return null
  return jsonString(value, label)
}

function parseSnakePickResult(value: Json | null): SnakePickResult {
  const root = jsonObject(value ?? undefined, 'Snake-pick result')
  const pick = jsonObject(root.pick, 'Snake-pick result pick')

  return {
    pick: {
      id: jsonString(pick.id, 'pick.id'),
      overall_pick: jsonNumber(pick.overall_pick, 'pick.overall_pick'),
      round: jsonNumber(pick.round, 'pick.round'),
      pick_in_round: jsonNumber(pick.pick_in_round, 'pick.pick_in_round'),
      member_id: jsonString(pick.member_id, 'pick.member_id'),
      draft_pick_id: jsonNullableString(pick.draft_pick_id, 'pick.draft_pick_id'),
    },
    remaining: jsonNumber(root.remaining, 'remaining'),
    league_id: jsonString(root.league_id, 'league_id'),
    league_season_id: jsonString(root.league_season_id, 'league_season_id'),
    is_mock: jsonBoolean(root.is_mock, 'is_mock'),
  }
}

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

function rookieTimerExpiryBehavior(body: Record<string, unknown>): RookieTimerExpiryBehavior {
  const value = optionalStringField(body, 'timerExpiryBehavior') ?? 'auto_pick'
  if (!ROOKIE_TIMER_EXPIRY_BEHAVIORS.includes(value as RookieTimerExpiryBehavior)) {
    throw new ValidationError(`Invalid rookie draft timeout behavior: ${value}`)
  }
  return value as RookieTimerExpiryBehavior
}

function auctionDraftStartOptions(body: Record<string, unknown>): AuctionDraftStartOptions {
  return {
    isMock: optionalBooleanField(body, 'isMock') ?? false,
    timerSeconds: optionalIntegerField(body, 'timerSeconds', { min: 5, max: 3600 }) ?? DEFAULT_DRAFT_TIMER_SECONDS,
    budgetPerTeam: optionalIntegerField(body, 'budgetPerTeam', { min: 1, max: 1_000_000 }),
  }
}

function rookieDraftRounds(body: Record<string, unknown>): number {
  return optionalIntegerField(body, 'rounds', { min: 1, max: MAX_ROOKIE_DRAFT_ROUNDS }) ?? ROOKIE_DRAFT_ROUNDS
}

function rookieDraftStartOptions(body: Record<string, unknown>): RookieDraftStartOptions {
  return {
    isMock: optionalBooleanField(body, 'isMock') ?? false,
    timerSeconds: optionalIntegerField(body, 'timerSeconds', { min: 5, max: 3600 }) ?? DEFAULT_DRAFT_TIMER_SECONDS,
    rounds: rookieDraftRounds(body),
    timerExpiryBehavior: rookieTimerExpiryBehavior(body),
  }
}

function mockDraftRoomOptions(body: Record<string, unknown>): MockDraftRoomOptions {
  const draftType = optionalStringField(body, 'draftType') ?? 'auction'
  if (draftType !== 'auction' && draftType !== 'snake') {
    throw new ValidationError(`Invalid mock draft room type: ${draftType}`)
  }
  const scheduledAt = optionalStringField(body, 'scheduledAt')
  if (scheduledAt) {
    const parsed = new Date(scheduledAt)
    if (Number.isNaN(parsed.getTime())) throw new ValidationError('scheduledAt must be an ISO date string')
  }

  return {
    draftType,
    roomName: optionalStringField(body, 'roomName'),
    scheduledAt,
    nominationOrderMode: nominationOrderMode(body),
    timerSeconds: optionalIntegerField(body, 'timerSeconds', { min: 5, max: 3600 }) ?? DEFAULT_DRAFT_TIMER_SECONDS,
    budgetPerTeam: optionalIntegerField(body, 'budgetPerTeam', { min: 1, max: 1_000_000 }),
    rounds: rookieDraftRounds(body),
    timerExpiryBehavior: rookieTimerExpiryBehavior(body),
  }
}

async function startDraft(leagueId: string, mode: NominationOrderMode, options: AuctionDraftStartOptions): Promise<unknown> {
  if (options.isMock) {
    throw new ValidationError('Mock drafts must be created and started from a mock draft room')
  }

  const { data, error } = await supabase.rpc('start_auction_draft_atomic', {
    p_league_id: leagueId,
    p_nomination_order_mode: mode,
    p_is_mock: false,
    p_pick_timer_seconds: options.timerSeconds,
    p_budget_per_team: options.budgetPerTeam ?? undefined,
    p_timer_expiry_behavior: 'auction_no_bid',
  })
  if (error) throwDb(error)
  return data
}

async function createMockDraftRoom(
  leagueId: string,
  memberId: string,
  userId: string,
  options: MockDraftRoomOptions,
): Promise<unknown> {
  const { data, error } = await supabase.rpc('create_mock_draft_room_atomic', {
    p_league_id: leagueId,
    p_member_id: memberId,
    p_user_id: userId,
    p_room_name: options.roomName ?? undefined,
    p_draft_type: options.draftType,
    p_scheduled_at: options.scheduledAt ?? undefined,
    p_nomination_order_mode: options.nominationOrderMode,
    p_rounds: options.rounds,
    p_pick_timer_seconds: options.timerSeconds,
    p_budget_per_team: options.budgetPerTeam ?? undefined,
    p_timer_expiry_behavior: options.timerExpiryBehavior,
  })
  if (error) throwDb(error)
  return data
}

async function joinMockDraftRoom(draftId: string, memberId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('join_mock_draft_room_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

async function leaveMockDraftRoom(draftId: string, memberId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('leave_mock_draft_room_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

async function startMockDraftRoom(draftId: string, memberId: string, userId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('start_mock_draft_room_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
  return data
}

async function stopDraft(draftId: string, actorUserId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_draft_atomic', { p_draft_id: draftId, p_actor_user_id: actorUserId })
  if (error) throwDb(error)
}

async function resetDraft(draftId: string, actorUserId: string): Promise<void> {
  const { error } = await supabase.rpc('reset_draft_atomic', { p_draft_id: draftId, p_actor_user_id: actorUserId })
  if (error) throwDb(error)
}

async function pauseDraft(draftId: string, actorUserId: string): Promise<void> {
  const { error } = await supabase.rpc('pause_draft_atomic', { p_draft_id: draftId, p_actor_user_id: actorUserId })
  if (error) throwDb(error)
}

async function resumeDraft(draftId: string, actorUserId: string): Promise<void> {
  const { error } = await supabase.rpc('resume_draft_atomic', { p_draft_id: draftId, p_actor_user_id: actorUserId })
  if (error) throwDb(error)
}

async function nominatePlayer(draftId: string, memberId: string, playerId: string, userId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('create_auction_nomination_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_player_id: playerId,
    p_user_id: userId,
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

export async function startRookieDraft(
  leagueId: string,
  options: RookieDraftStartOptions = {
    isMock: false,
    timerSeconds: DEFAULT_DRAFT_TIMER_SECONDS,
    rounds: ROOKIE_DRAFT_ROUNDS,
    timerExpiryBehavior: 'auto_pick',
  },
): Promise<unknown> {
  if (options.isMock) {
    throw new ValidationError('Mock drafts must be created and started from a mock draft room')
  }

  const { data, error } = await supabase.rpc('start_rookie_draft_atomic', {
    p_league_id: leagueId,
    p_rounds: options.rounds,
    p_is_mock: false,
    p_pick_timer_seconds: options.timerSeconds,
    p_timer_expiry_behavior: options.timerExpiryBehavior,
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

  return snakePickResponse(draftId, memberId, playerId, rpcData)
}

async function commissionerSnakePick(
  draftId: string,
  memberId: string,
  playerId: string,
  actorUserId: string,
): Promise<Record<string, unknown>> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('commissioner_snake_pick_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_player_id: playerId,
    p_actor_user_id: actorUserId,
  })
  if (rpcError) throwDb(rpcError)

  return snakePickResponse(draftId, memberId, playerId, rpcData)
}

async function snakePickResponse(
  draftId: string,
  memberId: string,
  playerId: string,
  rpcData: Json | null,
): Promise<Record<string, unknown>> {
  const result = parseSnakePickResult(rpcData)

  if (result.is_mock) {
    return {
      pick: result.pick,
      remaining: result.remaining,
      rosterOverflow: false,
      taxiSlotsAvailable: false,
      newPlayerId: playerId,
      isMock: true,
    }
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
    'draft',
  ).catch(console.error)

  return {
    pick: result.pick,
    remaining: result.remaining,
    rosterOverflow: (activeCount ?? 0) > (leagueRow?.roster_size ?? DEFAULT_ROSTER_SIZE),
    taxiSlotsAvailable: (taxiCount ?? 0) < (leagueRow?.taxi_slots ?? DEFAULT_TAXI_SLOTS),
    newPlayerId: playerId,
    isMock: false,
  }
}

export async function autoPickBest(draftId: string, memberId: string): Promise<Record<string, unknown>> {
  const { data: rpcData, error: rpcError } = await supabase.rpc('auto_pick_snake_pick_atomic', {
    p_draft_id: draftId,
    p_member_id: memberId,
    p_reason: 'manual',
  })
  if (rpcError) throwDb(rpcError)

  const playerId = jsonString(jsonObject(rpcData ?? undefined, 'Auto-pick result').player_id, 'player_id')
  return snakePickResponse(draftId, memberId, playerId, rpcData)
}

async function processExpiredSnakePick(draftId: string, memberId: string): Promise<Record<string, unknown>> {
  const { data: nextPick, error: nextPickError } = await supabase
    .from('snake_draft_picks')
    .select('id, member_id')
    .eq('draft_id', draftId)
    .is('player_id', null)
    .is('skipped_at', null)
    .order('overall_pick', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (nextPickError) throwDb(nextPickError)
  if (!nextPick) return { processed: false, picked: false }
  if (nextPick.member_id !== memberId) {
    throw new ValidationError("It's not your pick")
  }

  const { data, error } = await supabase.rpc('process_expired_snake_pick_atomic', {
    p_draft_id: draftId,
  })
  if (error) throwDb(error)

  const row = (data ?? [])[0]
  if (!row) return { processed: false, picked: false }
  if (row.error_code || row.error_message) {
    throw new ValidationError(row.error_message ?? row.error_code ?? 'Expired pick processing failed')
  }

  return {
    processed: true,
    pickId: row.pick_id,
    memberId: row.member_id,
    playerId: row.player_id,
    picked: row.picked,
  }
}

async function requireDraftLeagueMember(userId: string, draftId: string): Promise<string> {
  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .select('league_id')
    .eq('id', draftId)
    .maybeSingle()
  if (draftError) throwDb(draftError)
  if (!draft) throw new NotFoundError('Draft not found')

  const { data: membership, error: membershipError } = await supabase
    .from('league_members')
    .select('id')
    .eq('league_id', draft.league_id)
    .eq('user_id', userId)
    .maybeSingle()
  if (membershipError) throwDb(membershipError)
  if (!membership) throw new NotFoundError('Draft not found')
  return membership.id
}

type PresenceClaim = { v: 1; draftId: string; memberId: string; expiresAt: number }

function presenceSigningSecret(): string {
  const secret = Deno.env.get('PANCAKE_SUPABASE_SECRET_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!secret) throw new Error('Presence claim signing is not configured.')
  return secret
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

async function presenceSignature(payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(presenceSigningSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)))
}

async function issuePresenceClaim(userId: string, draftId: string): Promise<string> {
  const memberId = await requireDraftLeagueMember(userId, draftId)
  const claim: PresenceClaim = {
    v: 1,
    draftId,
    memberId,
    expiresAt: Math.floor(Date.now() / 1000) + PRESENCE_CLAIM_TTL_SECONDS,
  }
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claim)))
  return `${payload}.${base64Url(await presenceSignature(payload))}`
}

async function verifyPresenceClaim(value: string, draftId: string): Promise<string | null> {
  try {
    const [payload, signature, extra] = value.split('.')
    if (!payload || !signature || extra) return null
    const expected = await presenceSignature(payload)
    const actual = decodeBase64Url(signature)
    if (actual.length !== expected.length) return null
    let mismatch = 0
    for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index] ^ expected[index]
    if (mismatch !== 0) return null
    const claim = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as Partial<PresenceClaim>
    if (claim.v !== 1 || claim.draftId !== draftId || typeof claim.memberId !== 'string' ||
        typeof claim.expiresAt !== 'number' || claim.expiresAt <= Math.floor(Date.now() / 1000)) return null
    return claim.memberId
  } catch {
    return null
  }
}

async function resolvePresenceClaims(draftId: string, claims: unknown): Promise<string[]> {
  if (!Array.isArray(claims) || claims.length > 50 || claims.some((claim) => typeof claim !== 'string')) {
    throw new ValidationError('claims must be an array of at most 50 strings')
  }
  const resolved = await Promise.all(claims.map((claim) => verifyPresenceClaim(claim, draftId)))
  return [...new Set(resolved.filter((memberId): memberId is string => memberId !== null))]
}

async function activateRookieDraftLeague(draftId: string, userId: string): Promise<{ activated: boolean }> {
  await requireDraftLeagueMember(userId, draftId)
  const { data, error } = await supabase.rpc('activate_rookie_draft_league_atomic', {
    p_draft_id: draftId,
  })
  if (error) throwDb(error)
  return { activated: Boolean(data) }
}

async function reseedRookieDraftPicks(draftId: string): Promise<{ reseeded: number }> {
  const { data: draft, error: draftError } = await supabase
    .from('drafts')
    .select('rounds')
    .eq('id', draftId)
    .maybeSingle()
  if (draftError) throwDb(draftError)
  if (!draft) throw new NotFoundError('Draft not found')

  const draftRounds = Number(draft.rounds ?? ROOKIE_DRAFT_ROUNDS)
  const { data, error } = await supabase.rpc('reseed_rookie_draft_picks_atomic', {
    p_draft_id: draftId,
    p_rounds: draftRounds,
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
    return json({ ok: true, draft: await startDraft(leagueId, nominationOrderMode(body), auctionDraftStartOptions(body)) })
  }

  if (path === '/draft/start-rookie') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const leagueId = uuidField(body, 'leagueId')
    await requireCommissioner(userId, leagueId)
    return json({ ok: true, draft: await startRookieDraft(leagueId, rookieDraftStartOptions(body)) })
  }

  if (path === '/draft/mock-room/create') {
    const body = await readJsonObject(req)
    const userId = await requireUser(req)
    const leagueId = uuidField(body, 'leagueId')
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, draft: await createMockDraftRoom(leagueId, memberId, userId, mockDraftRoomOptions(body)) })
  }

  const action = splitDraftAction(path)
  if (!action) return null

  const { draftId } = action
  const body = await readJsonObject(req)
  const userId = await requireUser(req)

  if (action.action === 'presence-claim') {
    return json({ ok: true, claim: await issuePresenceClaim(userId, draftId) })
  }

  if (action.action === 'resolve-presence') {
    await requireDraftLeagueMember(userId, draftId)
    return json({ ok: true, memberIds: await resolvePresenceClaims(draftId, body.claims) })
  }

  if (action.action === 'stop') {
    await requireCommissionerForDraft(userId, draftId)
    await stopDraft(draftId, userId)
    return json({ ok: true })
  }

  if (action.action === 'reset') {
    await requireCommissionerForDraft(userId, draftId)
    await resetDraft(draftId, userId)
    return json({ ok: true })
  }

  if (action.action === 'pause') {
    await requireCommissionerForDraft(userId, draftId)
    await pauseDraft(draftId, userId)
    return json({ ok: true })
  }

  if (action.action === 'resume') {
    await requireCommissionerForDraft(userId, draftId)
    await resumeDraft(draftId, userId)
    return json({ ok: true })
  }

  if (action.action === 'join-mock-room') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    await joinMockDraftRoom(draftId, memberId, userId)
    return json({ ok: true })
  }

  if (action.action === 'leave-mock-room') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    await leaveMockDraftRoom(draftId, memberId, userId)
    return json({ ok: true })
  }

  if (action.action === 'start-mock-room') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, draft: await startMockDraftRoom(draftId, memberId, userId) })
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

  if (action.action === 'commissioner-pick') {
    await requireCommissionerForDraft(userId, draftId)
    return json({
      ok: true,
      ...await commissionerSnakePick(draftId, uuidField(body, 'memberId'), uuidField(body, 'playerId'), userId),
    })
  }

  if (action.action === 'auto-pick') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, ...await autoPickBest(draftId, memberId) })
  }

  if (action.action === 'process-expired-pick') {
    const memberId = uuidField(body, 'memberId')
    await verifyOwnMember(userId, memberId)
    return json({ ok: true, ...await processExpiredSnakePick(draftId, memberId) })
  }

  if (action.action === 'activate-rookie-league') {
    return json({ ok: true, ...await activateRookieDraftLeague(draftId, userId) })
  }

  if (action.action === 'reseed-picks') {
    await requireCommissionerForDraft(userId, draftId)
    return json({ ok: true, ...await reseedRookieDraftPicks(draftId) })
  }

  if (action.action === 'close-expired') {
    await requireDraftLeagueMember(userId, draftId)
    const { data, error } = await supabase.rpc('close_expired_auction_nominations_atomic', { p_limit: 10 })
    if (error) throwDb(error)
    const closed = (data ?? []).filter((r: { closed: boolean }) => r.closed).length
    return json({ ok: true, closed })
  }

  if (action.action === 'pause-for-absence') {
    await requireDraftLeagueMember(userId, draftId)
    const { error } = await supabase.rpc('pause_draft_for_absence_atomic', {
      p_draft_id: draftId,
      p_actor_user_id: userId,
    })
    if (error) throwDb(error)
    return json({ ok: true })
  }

  if (action.action === 'resume-if-absent') {
    await requireDraftLeagueMember(userId, draftId)
    const { error } = await supabase.rpc('resume_draft_if_absent_atomic', {
      p_draft_id: draftId,
      p_actor_user_id: userId,
    })
    if (error) throwDb(error)
    return json({ ok: true })
  }

  return null
}
