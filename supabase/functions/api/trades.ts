import type { Json } from '../_shared/database.ts'
import { supabase } from '../_shared/supabase.ts'
import {
  MAX_TRADE_EXPIRATION_DAYS,
  MAX_TRADE_ITEMS,
  MAX_TRADE_NOTES_BYTES,
  MAX_TRADE_PARTICIPANTS,
} from '../_shared/tradeLimits.ts'
import {
  json,
  NotFoundError,
  optionalIntegerField,
  optionalStringField,
  optionalUuidArrayField,
  optionalUuidField,
  readJsonObject,
  requireOwnMember,
  requireUser,
  throwDb,
  assertUuid,
  uuidField,
  ValidationError,
  verifyOwnMember,
} from '../_shared/apiRuntime.ts'

type TradeVetoResult = {
  vetoed: boolean
  vetoCount: number
  threshold: number
}

type MultiTeamTradeItemPayload = {
  fromMemberId: string
  toMemberId: string
  playerId?: string | null
  pickId?: string | null
  faabAmount?: number
}

type TradeAssetPayload = {
  offerPlayerIds: string[]
  requestPlayerIds: string[]
  offerPickIds: string[]
  requestPickIds: string[]
  notes: string | null
  expiresAt: string | null
  offerFaabAmount: number
  requestFaabAmount: number
}

type MultiTeamTradePayload = {
  participantMemberIds: string[]
  items: MultiTeamTradeItemPayload[]
  notes: string | null
  expiresAt: string | null
}

const MAX_TRADE_FAAB = 1_000_000
const DAY_MS = 24 * 60 * 60 * 1_000

type JsonObject = { [key: string]: Json | undefined }

type MultiTeamAcceptResult = {
  expired: boolean
}

type ReplaceTradeAction = {
  rpc: 'counter_trade_atomic' | 'edit_trade_atomic'
}

type ReplaceMultiTeamTradeAction = {
  rpc: 'counter_multi_team_trade_atomic' | 'edit_multi_team_trade_atomic'
}

const REPLACE_TRADE_ACTIONS: Record<'counter' | 'edit', ReplaceTradeAction> = {
  counter: {
    rpc: 'counter_trade_atomic',
  },
  edit: {
    rpc: 'edit_trade_atomic',
  },
}

const REPLACE_MULTI_TEAM_TRADE_ACTIONS: Record<'counter' | 'edit', ReplaceMultiTeamTradeAction> = {
  counter: {
    rpc: 'counter_multi_team_trade_atomic',
  },
  edit: {
    rpc: 'edit_multi_team_trade_atomic',
  },
}

function jsonObject(value: Json | undefined, label: string): { [key: string]: Json | undefined } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`)
  }
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

function parseMultiTeamAcceptResult(value: Json | null): MultiTeamAcceptResult {
  const result = jsonObject(value ?? undefined, 'Multi-team trade accept result')
  return {
    expired: jsonBoolean(result.expired, 'expired'),
  }
}

function parseTradeVetoResult(value: Json | null): TradeVetoResult {
  const result = jsonObject(value ?? undefined, 'Trade veto result')
  return {
    vetoed: jsonBoolean(result.vetoed, 'vetoed'),
    vetoCount: jsonNumber(result.vetoCount, 'vetoCount'),
    threshold: jsonNumber(result.threshold, 'threshold'),
  }
}

function splitTradeAction(path: string): { tradeId: string; action: string } | null {
  const match = path.match(/^\/trades\/([^/]+)\/([^/]+)$/)
  if (!match) return null
  assertUuid(match[1], 'tradeId')
  return { tradeId: match[1], action: match[2] }
}

function splitTradeBlockRemove(path: string): { itemId: string } | null {
  const match = path.match(/^\/trades\/block\/([^/]+)\/remove$/)
  if (!match) return null
  assertUuid(match[1], 'tradeBlockItemId')
  return { itemId: match[1] }
}

function optionalTradeExpirationField(body: Record<string, unknown>, key: string): string | null {
  const value = optionalStringField(body, key)
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${key} must be a valid timestamp.`)
  if (date.getTime() - Date.now() > MAX_TRADE_EXPIRATION_DAYS * DAY_MS) {
    throw new ValidationError(`${key} must be no more than ${MAX_TRADE_EXPIRATION_DAYS} days in the future.`)
  }
  return date.toISOString()
}

function tradeAssetPayload(body: Record<string, unknown>): TradeAssetPayload {
  const payload = {
    offerPlayerIds: optionalUuidArrayField(body, 'offerPlayerIds'),
    requestPlayerIds: optionalUuidArrayField(body, 'requestPlayerIds'),
    offerPickIds: optionalUuidArrayField(body, 'offerPickIds'),
    requestPickIds: optionalUuidArrayField(body, 'requestPickIds'),
    notes: optionalStringField(body, 'notes', { maxUtf8Bytes: MAX_TRADE_NOTES_BYTES }),
    expiresAt: optionalTradeExpirationField(body, 'expiresAt'),
    offerFaabAmount: optionalIntegerField(body, 'offerFaabAmount', { min: 0, max: MAX_TRADE_FAAB }) ?? 0,
    requestFaabAmount: optionalIntegerField(body, 'requestFaabAmount', { min: 0, max: MAX_TRADE_FAAB }) ?? 0,
  }
  const itemCount = payload.offerPlayerIds.length + payload.requestPlayerIds.length +
    payload.offerPickIds.length + payload.requestPickIds.length +
    (payload.offerFaabAmount > 0 ? 1 : 0) + (payload.requestFaabAmount > 0 ? 1 : 0)
  if (itemCount > MAX_TRADE_ITEMS) {
    throw new ValidationError(`A trade cannot include more than ${MAX_TRADE_ITEMS} items.`)
  }
  return payload
}

function multiTeamTradePayload(body: Record<string, unknown>, proposerMemberId: string): MultiTeamTradePayload {
  const rawItems = body.items
  if (!Array.isArray(rawItems)) throw new ValidationError('items must be an array.')
  if (rawItems.length > MAX_TRADE_ITEMS) {
    throw new ValidationError(`A trade cannot include more than ${MAX_TRADE_ITEMS} items.`)
  }

  const items = rawItems.map((raw, index): MultiTeamTradeItemPayload => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ValidationError(`items[${index}] must be an object.`)
    }
    const item = raw as Record<string, unknown>
    const fromMemberId = uuidField(item, 'fromMemberId')
    const toMemberId = uuidField(item, 'toMemberId')
    const playerId = optionalUuidField(item, 'playerId')
    const pickId = optionalUuidField(item, 'pickId')
    const faabAmount = optionalIntegerField(item, 'faabAmount', { min: 0, max: MAX_TRADE_FAAB }) ?? 0
    const assetCount = (playerId ? 1 : 0) + (pickId ? 1 : 0) + (faabAmount > 0 ? 1 : 0)
    if (assetCount !== 1) {
      throw new ValidationError(`items[${index}] must include exactly one playerId, pickId, or positive faabAmount.`)
    }
    if (fromMemberId === toMemberId) {
      throw new ValidationError(`items[${index}] must move between two different teams.`)
    }
    return { fromMemberId, toMemberId, playerId, pickId, faabAmount }
  })

  const participantMemberIds = optionalUuidArrayField(body, 'participantMemberIds')
  const participantCount = new Set([proposerMemberId, ...participantMemberIds]).size
  if (participantCount < 3) {
    throw new ValidationError('A multi-team trade requires at least 3 teams.')
  }
  if (participantCount > MAX_TRADE_PARTICIPANTS) {
    throw new ValidationError(`A trade cannot include more than ${MAX_TRADE_PARTICIPANTS} teams.`)
  }

  return {
    participantMemberIds,
    items,
    notes: optionalStringField(body, 'notes', { maxUtf8Bytes: MAX_TRADE_NOTES_BYTES }),
    expiresAt: optionalTradeExpirationField(body, 'expiresAt'),
  }
}

function rpcTradeArgs(payload: TradeAssetPayload) {
  return {
    p_offer_player_ids: payload.offerPlayerIds,
    p_request_player_ids: payload.requestPlayerIds,
    p_offer_pick_ids: payload.offerPickIds,
    p_request_pick_ids: payload.requestPickIds,
    p_notes: payload.notes ?? undefined,
    p_expires_at: payload.expiresAt ?? undefined,
    p_offer_faab_amount: payload.offerFaabAmount,
    p_request_faab_amount: payload.requestFaabAmount,
  }
}

function multiTeamTradeItemsJson(items: MultiTeamTradeItemPayload[]): Json {
  const encodedItems: Json[] = items.map((item): JsonObject => ({
    fromMemberId: item.fromMemberId,
    toMemberId: item.toMemberId,
    playerId: item.playerId ?? null,
    pickId: item.pickId ?? null,
    faabAmount: item.faabAmount ?? 0,
  }))
  return encodedItems
}

async function proposeTrade(userId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  const memberId = uuidField(body, 'memberId')
  await verifyOwnMember(userId, memberId)
  const payload = tradeAssetPayload(body)

  const { data: tradeId, error } = await supabase.rpc('propose_trade_atomic', {
    p_league_id: uuidField(body, 'leagueId'),
    p_league_season_id: uuidField(body, 'leagueSeasonId'),
    p_proposer_member_id: memberId,
    p_recipient_member_id: uuidField(body, 'recipientMemberId'),
    ...rpcTradeArgs(payload),
  })
  if (error || !tradeId) {
    if (error) throwDb(error)
    throw new Error('Could not create trade.')
  }

  return { tradeId: String(tradeId) }
}

async function proposeMultiTeamTrade(userId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  const memberId = uuidField(body, 'memberId')
  await verifyOwnMember(userId, memberId)
  const payload = multiTeamTradePayload(body, memberId)

  const { data: tradeId, error } = await supabase.rpc('propose_multi_team_trade_atomic', {
    p_league_id: uuidField(body, 'leagueId'),
    p_league_season_id: uuidField(body, 'leagueSeasonId'),
    p_proposer_member_id: memberId,
    p_participant_member_ids: payload.participantMemberIds,
    p_items: multiTeamTradeItemsJson(payload.items),
    p_notes: payload.notes ?? undefined,
    p_expires_at: payload.expiresAt ?? undefined,
  })
  if (error || !tradeId) {
    if (error) throwDb(error)
    throw new Error('Could not create multi-team trade.')
  }

  return { tradeId: String(tradeId) }
}

async function acceptTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)

  const { data, error } = await supabase.rpc('accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: memberId,
  })
  if (error) throwDb(error)
  const result = parseMultiTeamAcceptResult(data)
  if (result.expired) throw new ValidationError('This trade offer has expired.')
}

async function rejectTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)

  const { error } = await supabase.rpc('reject_trade_atomic', {
    p_trade_id: tradeId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

async function withdrawTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)

  const { error } = await supabase.rpc('withdraw_trade_atomic', {
    p_trade_id: tradeId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

async function counterTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  return replaceTrade(userId, tradeId, body, REPLACE_TRADE_ACTIONS.counter)
}

async function editTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  return replaceTrade(userId, tradeId, body, REPLACE_TRADE_ACTIONS.edit)
}

async function counterMultiTeamTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  return replaceMultiTeamTrade(userId, tradeId, body, REPLACE_MULTI_TEAM_TRADE_ACTIONS.counter)
}

async function editMultiTeamTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  return replaceMultiTeamTrade(userId, tradeId, body, REPLACE_MULTI_TEAM_TRADE_ACTIONS.edit)
}

async function replaceTrade(
  userId: string,
  tradeId: string,
  body: Record<string, unknown>,
  action: ReplaceTradeAction,
): Promise<{ tradeId: string }> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)
  const payload = tradeAssetPayload(body)

  const { data: newTradeId, error } = await supabase.rpc(action.rpc, {
    p_trade_id: tradeId,
    p_member_id: memberId,
    p_user_id: userId,
    ...rpcTradeArgs(payload),
  })
  if (error || !newTradeId) {
    if (error) throwDb(error)
    throw new ValidationError('This trade offer has expired.')
  }

  return { tradeId: String(newTradeId) }
}

async function replaceMultiTeamTrade(
  userId: string,
  tradeId: string,
  body: Record<string, unknown>,
  action: ReplaceMultiTeamTradeAction,
): Promise<{ tradeId: string }> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)
  const payload = multiTeamTradePayload(body, memberId)

  const { data: newTradeId, error } = await supabase.rpc(action.rpc, {
    p_trade_id: tradeId,
    p_member_id: memberId,
    p_user_id: userId,
    p_participant_member_ids: payload.participantMemberIds,
    p_items: multiTeamTradeItemsJson(payload.items),
    p_notes: payload.notes ?? undefined,
    p_expires_at: payload.expiresAt ?? undefined,
  })
  if (error || !newTradeId) {
    if (error) throwDb(error)
    throw new ValidationError('This trade offer has expired.')
  }

  return { tradeId: String(newTradeId) }
}

async function vetoTrade(
  userId: string,
  tradeId: string,
  body: Record<string, unknown>,
): Promise<TradeVetoResult> {
  const memberId = uuidField(body, 'memberId')
  const { leagueId } = await requireOwnMember(userId, memberId)
  const { data: trade, error: tradeError } = await supabase
    .from('trades')
    .select('id')
    .eq('id', tradeId)
    .eq('league_id', leagueId)
    .maybeSingle()
  if (tradeError) throwDb(tradeError)
  if (!trade) throw new NotFoundError('Trade not found.')

  const { data, error } = await supabase.rpc('veto_trade_atomic', {
    p_trade_id: tradeId,
    p_member_id: memberId,
  })
  if (error) throwDb(error)

  const result = parseTradeVetoResult(data)
  return {
    vetoed: result.vetoed,
    vetoCount: result.vetoCount,
    threshold: result.threshold,
  }
}

async function addTradeBlockItem(userId: string, body: Record<string, unknown>): Promise<{ tradeBlockItemId: string }> {
  const memberId = uuidField(body, 'memberId')
  const { leagueId } = await requireOwnMember(userId, memberId)
  const requestedLeagueId = uuidField(body, 'leagueId')
  if (requestedLeagueId !== leagueId) throw new ValidationError('Access denied')

  const { data: itemId, error } = await supabase.rpc('add_trade_block_item_atomic', {
    p_member_id: memberId,
    p_league_id: requestedLeagueId,
    p_player_id: optionalUuidField(body, 'playerId') ?? undefined,
    p_pick_id: optionalUuidField(body, 'pickId') ?? undefined,
    p_note: optionalStringField(body, 'note', { maxLength: 500 }) ?? undefined,
    p_user_id: userId,
  })
  if (error || !itemId) {
    if (error) throwDb(error)
    throw new Error('Could not update trade block.')
  }
  return { tradeBlockItemId: String(itemId) }
}

async function removeTradeBlockItem(userId: string, itemId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)

  const { error } = await supabase.rpc('remove_trade_block_item_atomic', {
    p_item_id: itemId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

export async function handleTradeRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null

  if (path === '/trades/propose') {
    const userId = await requireUser(req)
    return json({ ok: true, ...await proposeTrade(userId, await readJsonObject(req)) })
  }

  if (path === '/trades/propose-multi') {
    const userId = await requireUser(req)
    return json({ ok: true, ...await proposeMultiTeamTrade(userId, await readJsonObject(req)) })
  }

  if (path === '/trades/block') {
    const userId = await requireUser(req)
    return json({ ok: true, ...await addTradeBlockItem(userId, await readJsonObject(req)) })
  }

  const blockRemove = splitTradeBlockRemove(path)
  if (blockRemove) {
    const userId = await requireUser(req)
    await removeTradeBlockItem(userId, blockRemove.itemId, await readJsonObject(req))
    return json({ ok: true })
  }

  const action = splitTradeAction(path)
  if (!action) return null

  const userId = await requireUser(req)
  const body = await readJsonObject(req)

  if (action.action === 'accept') {
    await acceptTrade(userId, action.tradeId, body)
    return json({ ok: true })
  }
  if (action.action === 'reject') {
    await rejectTrade(userId, action.tradeId, body)
    return json({ ok: true })
  }
  if (action.action === 'withdraw') {
    await withdrawTrade(userId, action.tradeId, body)
    return json({ ok: true })
  }
  if (action.action === 'counter') {
    return json({ ok: true, ...await counterTrade(userId, action.tradeId, body) })
  }
  if (action.action === 'edit') {
    return json({ ok: true, ...await editTrade(userId, action.tradeId, body) })
  }
  if (action.action === 'counter-multi') {
    return json({ ok: true, ...await counterMultiTeamTrade(userId, action.tradeId, body) })
  }
  if (action.action === 'edit-multi') {
    return json({ ok: true, ...await editMultiTeamTrade(userId, action.tradeId, body) })
  }
  if (action.action === 'veto') {
    return json({ ok: true, ...await vetoTrade(userId, action.tradeId, body) })
  }

  return null
}
