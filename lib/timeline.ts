import { supabase } from '@/lib/supabase'
import type { Json } from '@/types/database'

export type TimelineFilter = 'all' | 'claims' | 'trades' | 'lineups' | 'scores'
export type TimelineCursor = { createdAt: string; id: string }
export type TimelineEvent = {
    id: string
    createdAt: string
    kind: string
    summary: string
    memberId: string | null
    reason: string | null
    entityId: string | null
    threadId?: string | null
    detail: Record<string, Json | undefined>
}
export type TimelinePage = { events: TimelineEvent[]; hasMore: boolean; nextCursor: TimelineCursor | null }
export async function getTeamTimeline(leagueId: string, memberId: string, before?: TimelineCursor | null): Promise<TimelinePage> {
    const { data, error } = await supabase.rpc('view_team_timeline', {
        p_league_id: leagueId,
        p_member_id: memberId,
        p_before: before ?? undefined,
        p_limit: 30,
    })
    if (error) throw error
    const page = data as unknown as TimelinePage | null
    if (!page || !Array.isArray(page.events) || typeof page.hasMore !== 'boolean'
        || (page.hasMore && (!page.nextCursor?.id || !page.nextCursor.createdAt))) {
        throw new Error('The timeline response is incomplete. Try again.')
    }
    return page
}

export function timelineMatches(event: TimelineEvent, filter: TimelineFilter): boolean {
    const prefix = { all: '', claims: 'claim.', trades: 'trade.', lineups: 'lineup.', scores: 'scores.' }[filter]
    return event.kind.startsWith(prefix)
}

export function timelineRelativeTime(createdAt: string, now = Date.now()): string {
    const elapsed = Math.max(0, now - Date.parse(createdAt))
    if (!Number.isFinite(elapsed)) return ''
    const minutes = Math.floor(elapsed / 60_000)
    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d ago`
    return new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
