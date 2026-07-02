import { notifyMember } from '../_shared/notifications.ts'
import type { Json } from '../_shared/database.ts'
import { supabase } from '../_shared/supabase.ts'
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
  proposerMemberId: string
  recipientMemberId: string
}

type TradeActionResult = {
  proposerMemberId: string
  recipientMemberId: string
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

type ReplaceTradeAction = {
  rpc: 'counter_trade_atomic' | 'edit_trade_atomic'
  actorColumn: 'recipient_member_id' | 'proposer_member_id'
  notifyMemberColumn: 'proposer_member_id' | 'recipient_member_id'
  notificationTitle: string
  notificationMessage: string
  sourceTradeMetadataKey: 'counteredFromTradeId' | 'editedFromTradeId'
  logLabel: string
}

const REPLACE_TRADE_ACTIONS: Record<'counter' | 'edit', ReplaceTradeAction> = {
  counter: {
    rpc: 'counter_trade_atomic',
    actorColumn: 'recipient_member_id',
    notifyMemberColumn: 'proposer_member_id',
    notificationTitle: 'Trade Countered',
    notificationMessage: 'A trade offer was countered and is waiting for your review.',
    sourceTradeMetadataKey: 'counteredFromTradeId',
    logLabel: 'counter',
  },
  edit: {
    rpc: 'edit_trade_atomic',
    actorColumn: 'proposer_member_id',
    notifyMemberColumn: 'recipient_member_id',
    notificationTitle: 'Trade Edited',
    notificationMessage: 'A pending trade offer was updated.',
    sourceTradeMetadataKey: 'editedFromTradeId',
    logLabel: 'edit',
  },
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

function parseTradeActionResult(value: Json | null): TradeActionResult {
  const result = jsonObject(value ?? undefined, 'Trade action result')
  return {
    proposerMemberId: jsonString(result.proposerMemberId, 'proposerMemberId'),
    recipientMemberId: jsonString(result.recipientMemberId, 'recipientMemberId'),
  }
}

function parseTradeVetoResult(value: Json | null): TradeVetoResult {
  const result = jsonObject(value ?? undefined, 'Trade veto result')
  return {
    vetoed: jsonBoolean(result.vetoed, 'vetoed'),
    vetoCount: jsonNumber(result.vetoCount, 'vetoCount'),
    threshold: jsonNumber(result.threshold, 'threshold'),
    proposerMemberId: jsonString(result.proposerMemberId, 'proposerMemberId'),
    recipientMemberId: jsonString(result.recipientMemberId, 'recipientMemberId'),
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

function optionalTimestampField(body: Record<string, unknown>, key: string): string | null {
  const value = optionalStringField(body, key)
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${key} must be a valid timestamp.`)
  return date.toISOString()
}

function tradeAssetPayload(body: Record<string, unknown>): TradeAssetPayload {
  return {
    offerPlayerIds: optionalUuidArrayField(body, 'offerPlayerIds'),
    requestPlayerIds: optionalUuidArrayField(body, 'requestPlayerIds'),
    offerPickIds: optionalUuidArrayField(body, 'offerPickIds'),
    requestPickIds: optionalUuidArrayField(body, 'requestPickIds'),
    notes: optionalStringField(body, 'notes'),
    expiresAt: optionalTimestampField(body, 'expiresAt'),
    offerFaabAmount: optionalIntegerField(body, 'offerFaabAmount', { min: 0 }) ?? 0,
    requestFaabAmount: optionalIntegerField(body, 'requestFaabAmount', { min: 0 }) ?? 0,
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

  const recipientMemberId = uuidField(body, 'recipientMemberId')
  notifyMember(
    recipientMemberId,
    'New Trade Offer',
    'You have a new trade offer waiting for your review.',
    { tradeId },
    'trade',
  ).catch((error) => console.error('[api/trades] proposal notification failed', error))

  return { tradeId: String(tradeId) }
}

async function fetchPendingTradeForAction(
  tradeId: string,
  memberId: string,
  column: 'recipient_member_id' | 'proposer_member_id',
): Promise<{ proposer_member_id: string; recipient_member_id: string }> {
  const { data, error } = await supabase
    .from('trades')
    .select('id, proposer_member_id, recipient_member_id, status')
    .eq('id', tradeId)
    .eq(column, memberId)
    .maybeSingle()

  if (error) throwDb(error)
  if (!data) throw new NotFoundError('Trade not found.')
  if (data.status !== 'pending') throw new ValidationError('This trade is no longer pending.')
  return data
}

async function acceptTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)
  const trade = await fetchPendingTradeForAction(tradeId, memberId, 'recipient_member_id')

  const { error } = await supabase.rpc('accept_trade_atomic', {
    p_trade_id: tradeId,
    p_accepting_member_id: memberId,
    p_drop_roster_player_ids: optionalUuidArrayField(body, 'dropRosterPlayerIds'),
  })
  if (error) throwDb(error)

  Promise.all([
    notifyMember(
      trade.proposer_member_id,
      'Trade Accepted',
      'Your trade was accepted. The 24-hour veto window has opened - completion in <24h.',
      { tradeId },
      'trade',
    ),
    notifyMember(
      trade.recipient_member_id,
      'Trade Acceptance Recorded',
      'Your acceptance was recorded. The 24-hour veto window has opened - completion in <24h.',
      { tradeId },
      'trade',
    ),
  ]).catch((error) => console.error('[api/trades] acceptance notification failed', error))
}

async function rejectTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)

  const { data, error } = await supabase.rpc('reject_trade_atomic', {
    p_trade_id: tradeId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
  const trade = parseTradeActionResult(data)

  notifyMember(
    trade.proposerMemberId,
    'Trade Rejected',
    'Your trade offer was declined.',
    { tradeId },
    'trade',
  ).catch((error) => console.error('[api/trades] rejection notification failed', error))
}

async function withdrawTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)

  const { data, error } = await supabase.rpc('withdraw_trade_atomic', {
    p_trade_id: tradeId,
    p_member_id: memberId,
    p_user_id: userId,
  })
  if (error) throwDb(error)
  const trade = parseTradeActionResult(data)

  notifyMember(
    trade.recipientMemberId,
    'Trade Withdrawn',
    'A trade offer sent to you has been withdrawn.',
    { tradeId },
    'trade',
  ).catch((error) => console.error('[api/trades] withdrawal notification failed', error))
}

async function counterTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  return replaceTrade(userId, tradeId, body, REPLACE_TRADE_ACTIONS.counter)
}

async function editTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  return replaceTrade(userId, tradeId, body, REPLACE_TRADE_ACTIONS.edit)
}

async function replaceTrade(
  userId: string,
  tradeId: string,
  body: Record<string, unknown>,
  action: ReplaceTradeAction,
): Promise<{ tradeId: string }> {
  const memberId = uuidField(body, 'memberId')
  await requireOwnMember(userId, memberId)
  const originalTrade = await fetchPendingTradeForAction(tradeId, memberId, action.actorColumn)
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

  const newTradeIdString = String(newTradeId)
  notifyMember(
    originalTrade[action.notifyMemberColumn],
    action.notificationTitle,
    action.notificationMessage,
    { tradeId: newTradeIdString, [action.sourceTradeMetadataKey]: tradeId },
    'trade',
  ).catch((error) => console.error(`[api/trades] ${action.logLabel} notification failed`, error))

  return { tradeId: newTradeIdString }
}

async function vetoTrade(userId: string, tradeId: string, body: Record<string, unknown>): Promise<Omit<TradeVetoResult, 'proposerMemberId' | 'recipientMemberId'>> {
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
  if (result.vetoed) {
    Promise.all([
      notifyMember(
        result.proposerMemberId,
        'Trade Vetoed',
        'An accepted trade was vetoed before completion.',
        { tradeId },
        'trade',
      ),
      notifyMember(
        result.recipientMemberId,
        'Trade Vetoed',
        'An accepted trade was vetoed before completion.',
        { tradeId },
        'trade',
      ),
    ]).catch((error) => console.error('[api/trades] veto notification failed', error))
  }

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
    p_note: optionalStringField(body, 'note') ?? undefined,
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
  if (action.action === 'veto') {
    return json({ ok: true, ...await vetoTrade(userId, action.tradeId, body) })
  }

  return null
}
