import { FastifyInstance } from 'fastify'
function isIREligible(injuryStatus: string | null): boolean {
    if (!injuryStatus) return false
    const s = injuryStatus.toLowerCase()
    return s === 'out' || s.startsWith('ir')
}
import { processWaiverClaims } from '../sync/waivers'
import { requireAdmin, verifyOwnMember } from '../lib/authz'
import { supabase } from '../lib/supabase'
import { AppError, NotFoundError, ValidationError } from '../plugins/errorHandler'
import { WaiverCancelBody, WaiverClaimBody, WaiverClaimParams } from '../schemas'

export default async function waiverRoutes(app: FastifyInstance) {
    app.post(
        '/claims',
        { schema: { body: WaiverClaimBody } },
        async (req) => {
            const { memberId, leagueId, playerId, dropPlayerId } = req.body as {
                memberId: string
                leagueId: string
                playerId: string
                dropPlayerId?: string | null
            }

            await verifyOwnMember(req.userId, memberId)

            // Phase 1: independent reads (member, season) — parallelize.
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

            // Validate Phase 1 in original source order.
            const { data: member, error: memberErr } = memberRes
            if (memberErr || !member) throw new NotFoundError('Member not found')
            if (member.league_id !== leagueId) throw new AppError('Access denied', 403)

            const { data: season, error: seasonErr } = seasonRes
            if (seasonErr || !season) throw new ValidationError('No active season found.')

            // Phase 2: reads that depend on season.id — parallelize.
            // All are independent reads (none writes what another reads).
            const [rosterRes, dropRes] = await Promise.all([
                supabase
                    .from('roster_players')
                    .select('is_on_ir, players ( display_name, injury_status )')
                    .eq('member_id', memberId)
                    .eq('league_id', leagueId)
                    .eq('league_season_id', season.id)
                    .eq('is_on_ir', true),
                dropPlayerId
                    ? supabase
                          .from('roster_players')
                          .select('id, is_on_ir, is_on_taxi')
                          .eq('member_id', memberId)
                          .eq('league_id', leagueId)
                          .eq('league_season_id', season.id)
                          .eq('player_id', dropPlayerId)
                          .maybeSingle()
                    : Promise.resolve(null),
            ])

            // Validate Phase 2 in original source order.
            const { data: rosterPlayers, error: rosterErr } = rosterRes
            if (rosterErr) throw rosterErr

            const ineligible = (rosterPlayers ?? []).filter(
                (rp) => !isIREligible(rp.players?.injury_status ?? null),
            )
            if (ineligible.length > 0) {
                const names = ineligible
                    .map((rp) => rp.players?.display_name)
                    .filter(Boolean)
                    .join(', ')
                throw new ValidationError(
                    `You have ineligible players on IR (${names}). Activate or drop them before placing waiver claims.`,
                )
            }

            if (dropPlayerId) {
                const { data: dropRow, error: dropErr } = dropRes!
                if (dropErr) throw dropErr
                if (!dropRow) throw new ValidationError('Drop player is no longer on your roster.')
                if (dropRow.is_on_ir || dropRow.is_on_taxi) {
                    throw new ValidationError('Drop player must be on your active roster.')
                }
            }

            const { error: claimErr } = await supabase.rpc('create_waiver_claim_atomic', {
                p_league_id: leagueId,
                p_member_id: memberId,
                p_player_id: playerId,
                p_drop_player_id: dropPlayerId ?? null,
                p_user_id: req.userId,
            })
            if (claimErr) throw claimErr

            return { ok: true }
        },
    )

    app.post(
        '/claims/:claimId/cancel',
        { schema: { params: WaiverClaimParams, body: WaiverCancelBody } },
        async (req) => {
            const { claimId } = req.params as { claimId: string }
            const { memberId } = req.body as { memberId: string }

            const { error } = await supabase
                .rpc('cancel_waiver_claim_atomic', {
                    p_claim_id: claimId,
                    p_member_id: memberId,
                    p_user_id: req.userId,
                })
            if (error) throw error

            return { ok: true }
        },
    )

    app.post('/process', async (req) => {
        requireAdmin(req.userId)
        await processWaiverClaims()
        return { ok: true }
    })
}
