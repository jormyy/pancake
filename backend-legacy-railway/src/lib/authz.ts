import { supabase } from './supabase'
import { AppError, NotFoundError } from '../plugins/errorHandler'

/**
 * Verify the requesting user is a commissioner or co-commissioner of the league.
 */
export async function requireCommissioner(userId: string, leagueId: string): Promise<void> {
    const { data, error } = await supabase
        .from('league_members')
        .select('role')
        .eq('league_id', leagueId)
        .eq('user_id', userId)
        .single()

    if (error || !data) {
        throw new AppError('Not authorized for this league', 403)
    }
    if (data.role !== 'commissioner' && data.role !== 'co_commissioner') {
        throw new AppError('Commissioner access required', 403)
    }
}

export async function requireCommissionerForDraft(userId: string, draftId: string): Promise<void> {
    const { data: commissionerRows, error: commissionerError } = await supabase
        .from('league_members')
        .select('league_id')
        .eq('user_id', userId)
        .in('role', ['commissioner', 'co_commissioner'])

    if (commissionerError) throw commissionerError

    const commissionerLeagueIds = (commissionerRows ?? []).map((row) => row.league_id)
    if (commissionerLeagueIds.length === 0) {
        throw new NotFoundError('Draft not found')
    }

    const { data, error } = await supabase
        .from('drafts')
        .select('id')
        .eq('id', draftId)
        .in('league_id', commissionerLeagueIds)
        .maybeSingle()

    if (error || !data) {
        throw new NotFoundError('Draft not found')
    }
}

/**
 * Verify the requesting user owns the member record, or is a commissioner of that member's league.
 */
export async function verifyMemberAccess(userId: string, memberId: string): Promise<void> {
    const { data, error } = await supabase
        .from('league_members')
        .select('user_id, role, league_id')
        .eq('id', memberId)
        .single()

    if (error || !data) {
        throw new NotFoundError('Member not found')
    }

    if (data.user_id === userId) return

    const { data: commissioner } = await supabase
        .from('league_members')
        .select('role')
        .eq('league_id', data.league_id)
        .eq('user_id', userId)
        .in('role', ['commissioner', 'co_commissioner'])
        .maybeSingle()

    if (!commissioner) {
        throw new NotFoundError('Member not found')
    }
}

/**
 * Verify the requesting user owns the member record. Commissioner override is
 * intentionally not allowed for actions that represent a manager's consent.
 */
export async function requireOwnMember(userId: string, memberId: string): Promise<{ leagueId: string }> {
    const { data, error } = await supabase
        .from('league_members')
        .select('league_id')
        .eq('id', memberId)
        .eq('user_id', userId)
        .maybeSingle()

    if (error || !data) {
        throw new NotFoundError('Member not found')
    }

    return { leagueId: data.league_id }
}

export async function verifyOwnMember(userId: string, memberId: string): Promise<void> {
    await requireOwnMember(userId, memberId)
}

/**
 * Verify the requesting user's league membership is in the same league as the given member.
 */
export async function verifySameLeague(userId: string, memberId: string): Promise<string> {
    // Single round-trip: fetch the target member row plus any rows belonging to
    // the requesting user, then validate that the requester is in the same league.
    const { data: rows } = await supabase
        .from('league_members')
        .select('id, user_id, league_id')
        .or(`id.eq.${memberId},user_id.eq.${userId}`)

    const target = rows?.find((r) => r.id === memberId)
    if (!target) throw new NotFoundError('Member not found')

    const requesterInLeague = rows?.some(
        (r) => r.user_id === userId && r.league_id === target.league_id,
    )
    if (!requesterInLeague) throw new NotFoundError('Member not found')

    return target.league_id
}

/**
 * Verify the requesting user is in the ADMIN_USER_IDS allowlist (for global admin operations).
 */
export function requireAdmin(userId: string): void {
    const allowlist = (process.env.ADMIN_USER_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

    if (allowlist.length === 0) {
        throw new AppError('Admin access not configured', 503)
    }
    if (!allowlist.includes(userId)) {
        throw new AppError('Admin access required', 403)
    }
}
