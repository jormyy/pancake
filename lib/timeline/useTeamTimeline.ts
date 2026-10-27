import { useCallback, useEffect, useRef, useState } from 'react'
import { getTeamTimeline, type TimelineCursor, type TimelineEvent } from '@/lib/timeline'
import { sessionGeneration } from '@/lib/session-cache-registry'

type TimelineState = {
    key: string | null
    events: TimelineEvent[]
    cursor: TimelineCursor | null
    hasMore: boolean
    loading: boolean
    loadingMore: boolean
    error: string | null
    errorSource: 'refresh' | 'page' | null
}
const emptyState = (key: string | null): TimelineState => ({
    key, events: [], cursor: null, hasMore: false, loading: false, loadingMore: false, error: null, errorSource: null,
})

export function useTeamTimeline({ leagueId, memberId, enabled = true }: {
    leagueId: string | null
    memberId: string | null
    enabled?: boolean
}) {
    const generation = sessionGeneration()
    const key = enabled && leagueId && memberId ? JSON.stringify([generation, leagueId, memberId]) : null
    const activeKey = useRef(key)
    activeKey.current = key
    const sequence = useRef(0)
    const pendingPage = useRef<symbol | null>(null)
    const [state, setState] = useState<TimelineState>(() => emptyState(key))
    const current = state.key === key ? state : emptyState(key)
    const stateRef = useRef(current)
    stateRef.current = current

    const refresh = useCallback(async () => {
        const request = ++sequence.current
        pendingPage.current = null
        if (!key || !leagueId || !memberId) {
            setState(emptyState(key))
            return
        }
        setState(previous => ({ ...(previous.key === key ? previous : emptyState(key)), loading: true, loadingMore: false, error: null, errorSource: null }))
        const valid = () => activeKey.current === key && sequence.current === request && sessionGeneration() === generation
        try {
            const page = await getTeamTimeline(leagueId, memberId)
            if (valid()) setState({ key, ...page, cursor: page.nextCursor, loading: false, loadingMore: false, error: null, errorSource: null })
        } catch (cause) {
            if (valid()) setState(previous => ({ ...previous, loading: false, error: message(cause), errorSource: 'refresh' }))
        }
    }, [generation, key, leagueId, memberId])

    useEffect(() => {
        void refresh()
        return () => { sequence.current += 1; pendingPage.current = null }
    }, [refresh])

    const loadMore = useCallback(async () => {
        const pageState = stateRef.current
        if (!key || !leagueId || !memberId || pageState.loading || !pageState.hasMore || !pageState.cursor || pendingPage.current) return
        const request = sequence.current
        const token = Symbol()
        pendingPage.current = token
        setState(previous => ({ ...previous, loadingMore: true, error: null, errorSource: null }))
        const valid = () => activeKey.current === key && sequence.current === request && sessionGeneration() === generation
        try {
            const page = await getTeamTimeline(leagueId, memberId, pageState.cursor)
            if (valid()) setState(previous => {
                const known = new Set(previous.events.map(event => event.id))
                return { ...previous, events: [...previous.events, ...page.events.filter(event => !known.has(event.id))],
                    cursor: page.nextCursor, hasMore: page.hasMore, loadingMore: false }
            })
        } catch (cause) {
            if (valid()) setState(previous => ({ ...previous, loadingMore: false, error: message(cause), errorSource: 'page' }))
        } finally {
            if (pendingPage.current === token) pendingPage.current = null
        }
    }, [generation, key, leagueId, memberId])

    return { events: current.events, loading: current.loading, loadingMore: current.loadingMore,
        hasMore: current.hasMore, error: current.error, refresh, loadMore, retry: current.errorSource === 'page' ? loadMore : refresh }
}

function message(cause: unknown): string {
    if (cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string') return cause.message
    return 'Could not load the timeline. Try again.'
}
