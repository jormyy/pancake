import type { LeagueScheduleView } from '@/lib/cache/view-types'
import type { Draft } from '@/lib/draft'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { browserReadsAllowed } from '@/hooks/use-browser-read-activity'
import { useIsFocused } from '@react-navigation/native'
import { useScreenView } from '@/hooks/use-screen-view'
import { readScreenView , invalidateScreenViews } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { sessionOwner } from '@/lib/session-cache-registry'
import { mergeAnnouncementActivity, type LeagueAnnouncement } from '@/lib/league-announcements'
import type { StandingRow } from '@/lib/scoring'
import type { WaiverPriorityRow } from '@/lib/waivers'
import type { TransactionRow } from '@/lib/transactions'
import type { LeaguePickItem } from '@/lib/rookieDraft'
import type { MockDraftRoom } from '@/lib/mockDraftRooms'
import type { LeagueTab } from '@/lib/league/tabs'

const ACTIVITY_PAGE = 20

type LeagueView = Partial<LeagueScheduleView> & { activeDraft?: Draft | null; standings?: StandingRow[]; rows?: TransactionRow[]; announcements?: LeagueAnnouncement[]; waiverOrder?: WaiverPriorityRow[]; picks?: LeaguePickItem[]; rooms?: MockDraftRoom[]; hasMore?: boolean; offset?: number }

export function useLeagueTabResources(leagueId: string | undefined, memberId: string | undefined, activeTab: LeagueTab, authorized = true) {
    const owner = sessionOwner()
    const focused = useIsFocused()
    const tab = activeTab === 'picks' ? 'draftBoard' : activeTab === 'draft' ? 'mockRooms' : activeTab
    const scope = owner && leagueId && memberId ? screenScope(tab === 'schedule' ? 'league-schedule' : 'league', leagueId, memberId, tab === 'schedule' ? {} : { tab, limit: ACTIVITY_PAGE }, owner) : null
    const view = useScreenView<LeagueView>(scope, authorized && focused)
    const refreshView = view.refresh
    const [pages, setPages] = useState<{ base?: LeagueView; rows: TransactionRow[]; offset: number; hasMore: boolean }>({ rows: [], offset: 0, hasMore: false })
    const selected = useMemo(() => pages.base === view.data ? pages : { base: view.data, rows: view.data?.rows ?? [], offset: view.data?.offset ?? 0, hasMore: view.data?.hasMore ?? false }, [pages, view.data])
    const snapshot = useRef(selected)
    snapshot.current = selected
    const [activityLoadingMore, setActivityLoadingMore] = useState(false)
    const [activityLoadMoreError, setActivityLoadMoreError] = useState<string | null>(null)
    const request = useRef(0)
    const pending = useRef(false)
    useEffect(() => { request.current += 1; pending.current = false; setActivityLoadingMore(false); setActivityLoadMoreError(null) }, [view.data, leagueId, memberId])
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const refreshTab = useCallback(async (_tab: LeagueTab) => { request.current += 1; pending.current = false; const selectedScope = scopeRef.current; await refreshView(true, true, selectedScope?.params?.tab === 'history' ? { ...selectedScope.params, limit: Math.min(100, Math.max(ACTIVITY_PAGE, Math.ceil(snapshot.current.offset / ACTIVITY_PAGE) * ACTIVITY_PAGE)) } : undefined) }, [refreshView])
    const ensureTab = useCallback((_tab: LeagueTab) => { void refreshView() }, [refreshView])
    const invalidateTab = useCallback((_tab: LeagueTab) => { if (leagueId) invalidateScreenViews(leagueId) }, [leagueId])
    const refreshMockRooms = useCallback(() => refreshTab('mockRooms'), [refreshTab])
    const loadMoreActivity = useCallback(async () => {
        if (!scope || !authorized || !focused || !browserReadsAllowed() || view.refreshing || !selected.hasMore || pending.current || tab !== 'history') return
        pending.current = true
        const sequence = ++request.current
        const previous = snapshot.current
        setActivityLoadingMore(true)
        try {
            const next = await readScreenView<LeagueView>({ ...scope, params: { ...scope.params, offset: previous.offset } }, { force: true })
            if (request.current !== sequence || snapshot.current !== previous) return
            const known = new Set(previous.rows.map(row => row.id))
            setPages({ ...previous, rows: [...previous.rows, ...(next.rows ?? []).filter(row => !known.has(row.id))], offset: next.offset ?? previous.offset, hasMore: next.hasMore ?? false })
            setActivityLoadMoreError(null)
        } catch (cause) { if (request.current === sequence) setActivityLoadMoreError(cause instanceof Error ? cause.message : 'Could not load more activity.') }
        finally { if (request.current === sequence) { pending.current = false; setActivityLoadingMore(false) } }
    }, [scope, authorized, focused, selected.hasMore, tab, view.refreshing])
    const transactions = useMemo(() => mergeAnnouncementActivity(selected.rows, view.data?.announcements ?? [], selected.hasMore), [selected.rows, selected.hasMore, view.data])
    return { schedule: view.data?.schedule ?? [], activeDraft: view.data?.activeDraft ?? null, activeDraftLoaded: view.loaded, activeDraftError: view.error?.message ?? null, activityHasMore: selected.hasMore, activityLoadMoreError, activityLoadingMore, currentLeaguePicks: view.data?.picks ?? [], ensureTab, invalidateTab, isTabLoading: view.loading, isTabLoaded: view.loaded, isTabRefreshing: view.refreshing, isOnline: !view.offline, loadMoreActivity, mockRooms: view.data?.rooms ?? [], refreshTab, refreshMockRooms, standings: view.data?.standings ?? [], tabError: view.error?.message, transactions, waiverOrder: view.data?.waiverOrder ?? [] }
}
