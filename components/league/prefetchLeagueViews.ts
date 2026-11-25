import { readScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { sessionOwner } from '@/lib/session-cache-registry'

const PREFETCH_TABS = ['history', 'draftBoard', 'seasons', 'mockRooms', 'settings'] as const
const ACTIVITY_PAGE = 20

export function prefetchLeagueViews(leagueId: string, memberId: string) {
    if (!sessionOwner()) return
    for (const tab of PREFETCH_TABS) {
        try {
            const scope = screenScope('league', leagueId, memberId, { tab, limit: ACTIVITY_PAGE })
            void readScreenView(scope).catch(() => {})
        } catch {
            return
        }
    }
}
