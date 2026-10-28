import { useLeagueDay } from '@/hooks/use-league-day'
import { leagueTimezone } from '@/lib/league-timezones'
import { useBrowserReadActivity } from '@/hooks/use-browser-read-activity'
import { useIsFocused } from '@react-navigation/native'
import { usePanelActivity } from '@/contexts/panel-activity'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cachedScreenView, readScreenView, saveScreenView, screenCacheKey, subscribeScreenView, type ScreenScope } from '@/lib/cache/screen-cache'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { useOnlineStatus } from '@/hooks/use-online-status'

export function useScreenView<T>(scope: ScreenScope | null, enabled = true, options: { autoLoad?: boolean } = {}) {
    useLeagueDay(leagueTimezone(scope?.leagueId))
    const focused = useIsFocused()
    const panelActive = usePanelActivity()
    const activity = useBrowserReadActivity()
    const admitted = enabled && focused && panelActive && activity.active
    const autoLoad = options.autoLoad !== false
    const key = scope ? screenCacheKey(scope) : null
    const generation = sessionGeneration()
    const online = useOnlineStatus()
    const current = useRef(key)
    current.current = key
    const scopeRef = useRef(scope)
    scopeRef.current = scope
    const initial = scope ? cachedScreenView<T>(scope) : undefined
    const [state, setState] = useState({ key, generation, data: initial?.value, loading: Boolean(scope && !initial), error: null as Error | null })
    const request = useRef(0)
    const refresh = useCallback(async (force = false, checkVersion = true, params?: Record<string, unknown>) => {
        const selected = scopeRef.current
        if (!selected || !online || !admitted) return false
        const sequence = ++request.current
        const selectedKey = screenCacheKey(selected)
        setState(previous => previous.key === selectedKey ? { ...previous, loading: true, error: null } : previous)
        try {
            const requestScope = params ? { ...selected, params } : selected
            const data = await readScreenView<T>(requestScope, { force, checkVersion })
            if (sequence !== request.current || current.current !== selectedKey || sessionGeneration() !== generation) return false
            if (params) saveScreenView(selected, data, cachedScreenView(requestScope)?.version ?? '0')
            setState({ key: selectedKey, generation, data, loading: false, error: null })
            return true
        } catch (cause) {
            if (sequence === request.current && current.current === selectedKey && sessionGeneration() === generation) setState(previous => ({ key: selectedKey, generation, data: previous.key === selectedKey ? previous.data : undefined, loading: false, error: cause instanceof Error ? cause : new Error(String(cause)) }))
            return false
        }
    }, [online, generation, admitted])
    useEffect(() => {
        const selected = scopeRef.current
        if (!selected) return
        const cached = cachedScreenView<T>(selected)
        setState({ key, generation, data: cached?.value, loading: Boolean(admitted && online && autoLoad), error: null })
        const stop = admitted && online ? subscribeScreenView(selected, () => {
            const next = cachedScreenView<T>(selected)
            if (next && !next.dirty) setState({ key, generation, data: next.value, loading: false, error: null })
            else if (next?.dirty && admitted && online) void refresh(false, false)
        }) : () => {}
        let firstFrame: number | undefined
        let secondFrame: number | undefined
        let background: ReturnType<typeof setTimeout> | undefined
        if (admitted && online && autoLoad) {
            if (cached && typeof requestAnimationFrame === 'function') {
                firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => { background = setTimeout(() => { void refresh() }, 100) }) })
            } else void refresh(false, Boolean(cached))
        }
        const resume = () => { if (admitted && (typeof document === 'undefined' || document.visibilityState !== 'hidden')) void refresh() }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resume)
        return () => { clearTimeout(background); if (firstFrame !== undefined) cancelAnimationFrame(firstFrame); if (secondFrame !== undefined) cancelAnimationFrame(secondFrame); request.current += 1; stop(); if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resume) }
    }, [key, admitted, online, generation, refresh, autoLoad])
    const owns = state.key === key && state.generation === generation
    const data = owns ? state.data : initial?.value
    return { data, loading: enabled && online && (owns ? state.loading && data === undefined : !initial), refreshing: owns && state.loading && data !== undefined, error: owns && state.error ? state.error : !online && data === undefined && scope ? new Error('Offline. Open this screen online first.') : null, offline: !online, loaded: data !== undefined, refresh }
}
