import { assertUuid, invokeInternalFunction, json, NotFoundError, optionalUuidField, readJsonObject, requireAdmin, requireUser, throwDb, uuidField, ValidationError, verifyOwnMember } from '../_shared/apiRuntime.ts'
import { supabase } from '../_shared/supabase.ts'

function isIREligible(injuryStatus: string | null): boolean {
  if (!injuryStatus) return false
  const normalized = injuryStatus.toLowerCase()
  return normalized === 'out' || normalized.startsWith('ir')
}

async function createClaim(
  userId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const memberId = uuidField(body, 'memberId')
  const leagueId = uuidField(body, 'leagueId')
  const playerId = uuidField(body, 'playerId')
  const dropPlayerId = optionalUuidField(body, 'dropPlayerId')

  await verifyOwnMember(userId, memberId)

  const [memberRes, seasonRes] = await Promise.all([
    supabase
      .from('league_members')
      .select('league_id')
      .eq('id', memberId)
      .single(),
    supabase
      .from('league_seasons')
      .select('id')
      .eq('league_id', leagueId)
      .eq('is_current', true)
      .single(),
  ])

  if (memberRes.error || !memberRes.data) throw new NotFoundError('Member not found')
  if (memberRes.data.league_id !== leagueId) throw new ValidationError('Access denied')
  if (seasonRes.error || !seasonRes.data) throw new ValidationError('No active season found.')

  const [rosterRes, dropRes] = await Promise.all([
    supabase
      .from('roster_players')
      .select('is_on_ir, players ( display_name, injury_status )')
      .eq('member_id', memberId)
      .eq('league_id', leagueId)
      .eq('league_season_id', seasonRes.data.id)
      .eq('is_on_ir', true),
    dropPlayerId
      ? supabase
        .from('roster_players')
        .select('id, is_on_ir, is_on_taxi')
        .eq('member_id', memberId)
        .eq('league_id', leagueId)
        .eq('league_season_id', seasonRes.data.id)
        .eq('player_id', dropPlayerId)
        .maybeSingle()
      : Promise.resolve(null),
  ])

  if (rosterRes.error) throwDb(rosterRes.error)
  const ineligible = (rosterRes.data ?? []).filter((row) => {
    const player = row.players as { injury_status?: string | null } | null
    return !isIREligible(player?.injury_status ?? null)
  })
  if (ineligible.length > 0) {
    const names = ineligible
      .map((row) => (row.players as { display_name?: string | null } | null)?.display_name)
      .filter(Boolean)
      .join(', ')
    throw new ValidationError(
      `You have ineligible players on IR (${names}). Activate or drop them before placing waiver claims.`,
    )
  }

  if (dropPlayerId) {
    const { data: dropRow, error: dropError } = dropRes!
    if (dropError) throwDb(dropError)
    if (!dropRow) throw new ValidationError('Drop player is no longer on your roster.')
    if (dropRow.is_on_ir || dropRow.is_on_taxi) {
      throw new ValidationError('Drop player must be on your active roster.')
    }
  }

  const { error } = await supabase.rpc('create_waiver_claim_atomic', {
    p_league_id: leagueId,
    p_member_id: memberId,
    p_player_id: playerId,
    p_drop_player_id: dropPlayerId,
    p_user_id: userId,
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

  if (path === '/waivers/process') {
    const userId = await requireUser(req)
    requireAdmin(userId)
    return json(await invokeInternalFunction('process-waivers'))
  }

  return null
}
