import { notifyMember } from '../_shared/notifications.ts'
import type { Json } from '../_shared/database.ts'
import { supabase } from '../_shared/supabase.ts'
import {
  json,
  NotFoundError,
  optionalStringField,
  optionalUuidArrayField,
  readJsonObject,
  requireOwnMember,
  requireUser,
  throwDb,
  assertUuid,
  uuidArrayField,
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

async function proposeTrade(userId: string, body: Record<string, unknown>): Promise<{ tradeId: string }> {
  const memberId = uuidField(body, 'memberId')
  await verifyOwnMember(userId, memberId)

  const { data: tradeId, error } = await supabase.rpc('propose_trade_atomic', {
    p_league_id: uuidField(body, 'leagueId'),
    p_league_season_id: uuidField(body, 'leagueSeasonId'),
    p_proposer_member_id: memberId,
    p_recipient_member_id: uuidField(body, 'recipientMemberId'),
    p_offer_player_ids: uuidArrayField(body, 'offerPlayerIds'),
    p_request_player_ids: uuidArrayField(body, 'requestPlayerIds'),
    p_offer_pick_ids: uuidArrayField(body, 'offerPickIds'),
    p_request_pick_ids: uuidArrayField(body, 'requestPickIds'),
    p_notes: optionalStringField(body, 'notes'),
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
    ),
    notifyMember(
      trade.recipient_member_id,
      'Trade Acceptance Recorded',
      'Your acceptance was recorded. The 24-hour veto window has opened - completion in <24h.',
      { tradeId },
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
  ).catch((error) => console.error('[api/trades] withdrawal notification failed', error))
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
      ),
      notifyMember(
        result.recipientMemberId,
        'Trade Vetoed',
        'An accepted trade was vetoed before completion.',
        { tradeId },
      ),
    ]).catch((error) => console.error('[api/trades] veto notification failed', error))
  }

  return {
    vetoed: result.vetoed,
    vetoCount: result.vetoCount,
    threshold: result.threshold,
  }
}

export async function handleTradeRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null

  if (path === '/trades/propose') {
    const userId = await requireUser(req)
    return json({ ok: true, ...await proposeTrade(userId, await readJsonObject(req)) })
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
  if (action.action === 'veto') {
    return json({ ok: true, ...await vetoTrade(userId, action.tradeId, body) })
  }

  return null
}
