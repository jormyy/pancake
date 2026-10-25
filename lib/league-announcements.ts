import { supabase } from '@/lib/supabase'
import type { Database } from '@/types/database'
import type { TransactionRow } from '@/lib/transactions'

export type LeagueAnnouncement = Database['public']['Tables']['league_announcements']['Row']

export async function listLeagueAnnouncements(leagueId: string): Promise<LeagueAnnouncement[]> {
    const { data, error } = await supabase.rpc('notif_list_announcements', { p_league_id: leagueId })
    if (error) throw error
    return data ?? []
}

export function mergeAnnouncementActivity(transactions: TransactionRow[], announcements: LeagueAnnouncement[], hasMore = false): TransactionRow[] {
    if (!announcements.length) return transactions
    const oldest = transactions.reduce((date, row) => row.occurredAt < date ? row.occurredAt : date, transactions[0]?.occurredAt ?? '')
    const visible = hasMore ? announcements.filter(row => Date.parse(row.published_at) >= Date.parse(oldest)) : announcements
    return [...transactions, ...visible.map((announcement): TransactionRow => ({
        id: `announcement:${announcement.id}`, memberId: announcement.author_member_id,
        teamName: 'Commissioner', playerId: null, playerName: 'Commissioner', position: null,
        eligiblePositions: [], nbaId: null, transactionType: 'commissioner_announcement',
        occurredAt: announcement.published_at, isSystem: true, title: 'Commissioner', body: announcement.body,
    }))].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id))
}
