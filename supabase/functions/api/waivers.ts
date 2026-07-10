import { assertUuid, invokeInternalFunction, json, optionalIntegerField, optionalUuidField, readJsonObject, requireAdmin, requireUser, stringField, throwDb, uuidField, verifyOwnMember } from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'

async function createClaim(
  userId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  const leagueId = uuidField(body, 'leagueId')
  const playerId = uuidField(body, 'playerId')
  const dropPlayerId = optionalUuidField(body, 'dropPlayerId')
  const bidAmount = optionalIntegerField(body, 'bidAmount', { min: 0 }) ?? 0
  const claimOrder = optionalIntegerField(body, 'claimOrder', { min: 1 })

  await verifyOwnMember(userId, memberId)

  const { error } = await supabase.rpc('create_waiver_claim_atomic', {
    p_league_id: leagueId,
    p_member_id: memberId,
    p_player_id: playerId,
    p_drop_player_id: dropPlayerId ?? undefined,
    p_user_id: userId,
    p_bid_amount: bidAmount,
    p_claim_order: claimOrder ?? undefined,
  })
  if (error) throwDb(error)
}

async function cancelClaim(userId: string, claimId: string, body: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('cancel_waiver_claim_atomic', {
    p_claim_id: claimId,
    p_member_id: uuidField(body, 'memberId'),
    p_user_id: userId,
  })
  if (error) throwDb(error)
}

async function editClaim(userId: string, claimId: string, body: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.rpc('edit_waiver_claim_atomic', {
    p_claim_id: claimId,
    p_member_id: uuidField(body, 'memberId'),
    p_user_id: userId,
    p_drop_player_id: optionalUuidField(body, 'dropPlayerId') ?? undefined,
    p_bid_amount: optionalIntegerField(body, 'bidAmount', { min: 0 }) ?? 0,
    p_claim_order: optionalIntegerField(body, 'claimOrder', { min: 1 }) ?? undefined,
  })
  if (error) throwDb(error)
}

async function reorderClaim(userId: string, claimId: string, body: Record<string, unknown>): Promise<{ claimOrder: number }> {
  const { data, error } = await supabase.rpc('reorder_waiver_claim_atomic', {
    p_claim_id: claimId,
    p_member_id: uuidField(body, 'memberId'),
    p_user_id: userId,
    p_direction: stringField(body, 'direction'),
  })
  if (error) throwDb(error)
  return { claimOrder: Number(data) }
}

export async function handleWaiverRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null

  if (path === '/waivers/claims') {
    const userId = await requireUser(req)
    await createClaim(userId, await readJsonObject(req))
    return json({ ok: true })
  }

  const cancelMatch = path.match(/^\/waivers\/claims\/([^/]+)\/cancel$/)
  if (cancelMatch) {
    const claimId = cancelMatch[1]
    assertUuid(claimId, 'claimId')
    const userId = await requireUser(req)
    await cancelClaim(userId, claimId, await readJsonObject(req))
    return json({ ok: true })
  }

  const editMatch = path.match(/^\/waivers\/claims\/([^/]+)\/edit$/)
  if (editMatch) {
    const claimId = editMatch[1]
    assertUuid(claimId, 'claimId')
    const userId = await requireUser(req)
    await editClaim(userId, claimId, await readJsonObject(req))
    return json({ ok: true })
  }

  const reorderMatch = path.match(/^\/waivers\/claims\/([^/]+)\/reorder$/)
  if (reorderMatch) {
    const claimId = reorderMatch[1]
    assertUuid(claimId, 'claimId')
    const userId = await requireUser(req)
    return json({ ok: true, ...await reorderClaim(userId, claimId, await readJsonObject(req)) })
  }

  if (path === '/waivers/process') {
    const userId = await requireUser(req)
    requireAdmin(userId)
    return json(await invokeInternalFunction('process-waivers'))
  }

  return null
}
