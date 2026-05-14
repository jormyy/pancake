import { FastifyInstance } from 'fastify'
import { processWaiverClaims } from '../sync/waivers'
import { requireAdmin, verifyOwnMember } from '../lib/authz'
import { supabase } from '../lib/supabase'
import { AppError, NotFoundError, ValidationError } from '../plugins/errorHandler'
function isIREligible(injuryStatus: string | null): boolean {
    if (!injuryStatus) return false
    const s = injuryStatus.toLowerCase()
    return s === 'out' || s.startsWith('ir')
}
import { WaiverCancelBody, WaiverClaimBody, WaiverClaimParams } from '../schemas'

function tomorrowET(): string {
    return new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', {
        timeZone: 'America/New_York',
    })
}

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

            const { data: member, error: memberErr } = await supabase
                .from('league_members')
                .select('league_id')
                .eq('id', memberId)
                .single()
            if (memberErr || !member) throw new NotFoundError('Member not found')
            if (member.league_id !== leagueId) throw new AppError('Access denied', 403)

            const { data: season, error: seasonErr } = await supabase
                .from('league_seasons')
                .select('id')
                .eq('league_id', leagueId)
                .eq('is_current', true)
                .single()
            if (seasonErr || !season) throw new ValidationError('No active season found.')

            const { data: rosterPlayers, error: rosterErr } = await supabase
                .from('roster_players')
                .select('is_on_ir, players ( display_name, injury_status )')
                .eq('member_id', memberId)
                .eq('league_id', leagueId)
                .eq('league_season_id', season.id)
                .eq('is_on_ir', true)
            if (rosterErr) throw rosterErr

            const ineligible = (rosterPlayers ?? []).filter(
                (rp: any) => !isIREligible(rp.players?.injury_status ?? null),
            )
            if (ineligible.length > 0) {
                const names = ineligible.map((rp: any) => rp.players?.display_name).filter(Boolean).join(', ')
                throw new ValidationError(
                    `You have ineligible players on IR (${names}). Activate or drop them before placing waiver claims.`,
                )
            }

            const { data: priorityRow, error: priorityErr } = await (supabase as any)
                .from('waiver_priorities')
                .select('priority')
                .eq('member_id', memberId)
                .eq('league_season_id', season.id)
                .single()
            if (priorityErr || !priorityRow) throw new ValidationError('No waiver priority found for your team.')

            const now = new Date().toISOString()
            const { data: waiverLog, error: waiverErr } = await (supabase as any)
                .from('waiver_wire_log')
                .select('id')
                .eq('league_id', leagueId)
                .eq('league_season_id', season.id)
                .eq('player_id', playerId)
                .is('cleared_at', null)
                .gt('clears_at', now)
                .maybeSingle()
            if (waiverErr) throw waiverErr
            if (!waiverLog) throw new ValidationError('This player is no longer on waivers.')

            const { data: existing, error: existingErr } = await (supabase as any)
                .from('waiver_claims')
                .select('id')
                .eq('member_id', memberId)
                .eq('league_season_id', season.id)
                .eq('player_id', playerId)
                .eq('status', 'pending')
                .maybeSingle()
            if (existingErr) throw existingErr
            if (existing) throw new ValidationError('You already have a pending claim for this player.')

            if (dropPlayerId) {
                const { data: dropRow, error: dropErr } = await (supabase as any)
                    .from('roster_players')
                    .select('id')
                    .eq('member_id', memberId)
                    .eq('league_id', leagueId)
                    .eq('league_season_id', season.id)
                    .eq('player_id', dropPlayerId)
                    .maybeSingle()
                if (dropErr) throw dropErr
                if (!dropRow) throw new ValidationError('Drop player is no longer on your roster.')
            }

            const { error: insertErr } = await (supabase as any).from('waiver_claims').insert({
                league_id: leagueId,
                league_season_id: season.id,
                member_id: memberId,
                player_id: playerId,
                drop_player_id: dropPlayerId ?? null,
                priority_at_submission: priorityRow.priority,
                process_date: tomorrowET(),
            })
            if (insertErr) throw insertErr

            return { ok: true }
        },
    )

    app.post(
        '/claims/:claimId/cancel',
        { schema: { params: WaiverClaimParams, body: WaiverCancelBody } },
        async (req) => {
            const { claimId } = req.params as { claimId: string }
            const { memberId } = req.body as { memberId: string }

            await verifyOwnMember(req.userId, memberId)

            const { data: claim, error: fetchErr } = await (supabase as any)
                .from('waiver_claims')
                .select('id, member_id, status')
                .eq('id', claimId)
                .single()
            if (fetchErr || !claim) throw new NotFoundError('Claim not found.')
            if (claim.member_id !== memberId) throw new AppError('Access denied', 403)
            if (claim.status !== 'pending') throw new ValidationError('Claim is no longer pending.')

            const { error } = await (supabase as any)
                .from('waiver_claims')
                .update({ status: 'cancelled', processed_at: new Date().toISOString() })
                .eq('id', claimId)
                .eq('status', 'pending')
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
