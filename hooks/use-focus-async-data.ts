import { useState, useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { usePanelActivity } from '@/contexts/panel-activity'

function dependenciesEqual(previous: React.DependencyList, next: React.DependencyList) {
    return previous.length === next.length && previous.every((value, index) => Object.is(value, next[index]))
}

/**
 * Refreshes stale data when the screen gains focus.
 * Existing data stays visible while refreshes run.
 *
 * When `deps` change (e.g. consumer switches league), the freshness gate and
 * cached data are reset so the next focus triggers a fresh fetch instead of
 * short-circuiting on stale state from the previous deps.
 */
export function useFocusAsyncData<T>(
    fetcher: () => Promise<T>,
    deps: React.DependencyList = [],
    options: { enabled?: boolean; staleMs?: number; initialData?: T; initialFetchedAt?: number; cacheRevision?: () => string | null; onLoaded?: (data: T, revision?: string | null) => void; onFailed?: () => void; beforeRead?: () => Promise<unknown>; followSourceChanges?: boolean } = {},
) {
    const panelActive = usePanelActivity()
    const enabled = options.enabled ?? true
    const activeRef = useRef(panelActive && enabled)
    activeRef.current = panelActive && enabled
    const requestEpochRef = useRef(0)
    const resumeNeededRef = useRef(false)
    const hasInitialData = options.initialData !== undefined
    const [data, setData] = useState<T | null>(hasInitialData ? options.initialData as T : null)
    const [loading, setLoading] = useState(!hasInitialData)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const savedAt = options.initialFetchedAt ?? 0
    const initialFetchedAt = hasInitialData && Number.isFinite(savedAt) && savedAt > 0 && savedAt <= Date.now() ? savedAt : 0
    const lastLoadedAtRef = useRef(initialFetchedAt)
    const invalidationRevision = useRef(0)
    const [, renderInvalidation] = useState(0)
    const inFlightRef = useRef<Promise<boolean> | null>(null)
    const hasDataRef = useRef(hasInitialData)
    const genRef = useRef(0)
    const renderedDepsRef = useRef(deps)
    const stateGenerationRef = useRef(0)
    const forceQueuedRef = useRef(false)
    const queuedRefreshRef = useRef<Promise<boolean> | null>(null)
    const staleMs = options.staleMs ?? 30_000
    const mountedRef = useRef(true)
    const followSourceChangesRef = useRef(options.followSourceChanges)
    followSourceChangesRef.current = options.followSourceChanges
    const beforeReadRef = useRef(options.beforeRead)
    beforeReadRef.current = options.beforeRead
    const onLoadedRef = useRef(options.onLoaded)
    onLoadedRef.current = options.onLoaded
    const onFailedRef = useRef(options.onFailed)
    onFailedRef.current = options.onFailed
    const cacheRevisionRef = useRef(options.cacheRevision)
    cacheRevisionRef.current = options.cacheRevision
    const lastRevisionRef = useRef(options.cacheRevision?.())
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            genRef.current += 1
            forceQueuedRef.current = false
            queuedRefreshRef.current = null
            inFlightRef.current = null
        }
    }, [])

    // Effects run after a render. Advance ownership during render so consumers
    // never observe the previous identity's data for one committed frame.
    if (!dependenciesEqual(renderedDepsRef.current, deps)) {
        renderedDepsRef.current = deps
        genRef.current += 1
        inFlightRef.current = null
        forceQueuedRef.current = false
        queuedRefreshRef.current = null
        hasDataRef.current = hasInitialData
        lastLoadedAtRef.current = initialFetchedAt
    }
    const generation = genRef.current
    const ownsState = stateGenerationRef.current === generation

    // Reset freshness gate when deps change so the next focus fetches fresh
    // data for the new identity (e.g. after a league switch).
    useEffect(() => {
        const hasNextInitialData = options.initialData !== undefined
        hasDataRef.current = hasNextInitialData
        lastLoadedAtRef.current = initialFetchedAt
        stateGenerationRef.current = generation
        setData(hasNextInitialData ? options.initialData as T : null)
        setLoading(!hasNextInitialData)
        setRefreshing(false)
        setError(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, generation])

    const suspend = useCallback(() => {
        if (inFlightRef.current || forceQueuedRef.current) {
            resumeNeededRef.current = true
            lastLoadedAtRef.current = 0
        }
        requestEpochRef.current += 1
        inFlightRef.current = null
        forceQueuedRef.current = false
        queuedRefreshRef.current = null
        if (mountedRef.current) {
            setLoading(false)
            setRefreshing(false)
        }
    }, [])

    const load = useCallback(async (loadOptions: { force?: boolean } = {}): Promise<boolean> => {
        if (!mountedRef.current) return false
        const force = loadOptions.force || resumeNeededRef.current
        if (!activeRef.current || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
            || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
            if (force) resumeNeededRef.current = true
            setLoading(false)
            setRefreshing(false)
            return false
        }
        if (inFlightRef.current) {
            if (!force) return inFlightRef.current
            forceQueuedRef.current = true
            if (!queuedRefreshRef.current) {
                const queuedGeneration = genRef.current
                const queuedEpoch = requestEpochRef.current
                queuedRefreshRef.current = inFlightRef.current
                    .then(async (result) => {
                        while (queuedGeneration === genRef.current && queuedEpoch === requestEpochRef.current && forceQueuedRef.current) {
                            forceQueuedRef.current = false
                            result = await load({ force: true })
                        }
                        return queuedGeneration === genRef.current && queuedEpoch === requestEpochRef.current && result
                    })
                    .finally(() => {
                        if (queuedGeneration === genRef.current && queuedEpoch === requestEpochRef.current) queuedRefreshRef.current = null
                    })
            }
            return queuedRefreshRef.current
        }
        const hasData = hasDataRef.current
        let revision = cacheRevisionRef.current?.()
        let invalidation = invalidationRevision.current
        const isFresh = Date.now() - lastLoadedAtRef.current < staleMs && lastRevisionRef.current === revision
        if (!force && hasData && isFresh) return true
        resumeNeededRef.current = false

        if (hasData) setRefreshing(true)
        else setLoading(true)
        setError(null)
        const gen = genRef.current
        const epoch = requestEpochRef.current
        const task = (async () => {
            try {
                if (beforeReadRef.current) {
                    await beforeReadRef.current()
                    if (gen !== genRef.current || epoch !== requestEpochRef.current || !activeRef.current
                        || (typeof document !== 'undefined' && document.visibilityState === 'hidden')
                        || (typeof navigator !== 'undefined' && navigator.onLine === false)) return false
                    revision = cacheRevisionRef.current?.()
                    invalidation = invalidationRevision.current
                }
                const result = await fetcher()
                if (gen !== genRef.current || epoch !== requestEpochRef.current) return false // deps changed mid-fetch — drop stale result
                if (revision === undefined) onLoadedRef.current?.(result)
                else onLoadedRef.current?.(result, revision)
                setData(result)
                stateGenerationRef.current = gen
                hasDataRef.current = true
                lastLoadedAtRef.current = revision === cacheRevisionRef.current?.() && invalidation === invalidationRevision.current ? Date.now() : 0
                lastRevisionRef.current = revision
                if (followSourceChangesRef.current && (revision !== cacheRevisionRef.current?.() || invalidation !== invalidationRevision.current)) {
                    void Promise.resolve().then(() => {
                        if (gen === genRef.current && epoch === requestEpochRef.current && !forceQueuedRef.current) void load({ force: true })
                    })
                }
                return true
            } catch (e) {
                if (gen !== genRef.current || epoch !== requestEpochRef.current) return false
                onFailedRef.current?.()
                lastLoadedAtRef.current = 0
                setError(e instanceof Error ? e : new Error(String(e)))
                console.error(e)
                return false
            } finally {
                if (gen === genRef.current && epoch === requestEpochRef.current) {
                    setLoading(false)
                    setRefreshing(false)
                    inFlightRef.current = null
                }
            }
        })()
        inFlightRef.current = task
        return task
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, staleMs, panelActive, enabled])

    const isFocusedRef = useRef(false)
    useFocusEffect(
        useCallback(() => {
            isFocusedRef.current = true
            load()
            return () => { isFocusedRef.current = false; suspend() }
        }, [load, suspend]),
    )

    // On the web, a PWA returning to the foreground or regaining the network
    // does not re-run useFocusEffect, so the focused screen kept its
    // pre-sleep data. A reconnect always refetches; a foreground return
    // goes through the normal staleness gate. Only the focused screen reacts.
    useEffect(() => {
        if (typeof window === 'undefined' || typeof document === 'undefined') return
        const onOnline = () => { resumeNeededRef.current = true; if (isFocusedRef.current) void load({ force: true }) }
        const onOffline = () => { suspend() }
        const onVisible = () => {
            if (document.visibilityState === 'hidden') suspend()
            else if (isFocusedRef.current) void load()
        }
        window.addEventListener('online', onOnline)
        window.addEventListener('offline', onOffline)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
            window.removeEventListener('online', onOnline)
            window.removeEventListener('offline', onOffline)
            document.removeEventListener('visibilitychange', onVisible)
        }
    }, [load, suspend])

    const markStale = useCallback(() => {
        if (!mountedRef.current) return
        invalidationRevision.current += 1
        lastLoadedAtRef.current = 0
        renderInvalidation(revision => revision + 1)
    }, [])
    const refresh = useCallback(() => load({ force: true }), [load])
    const refreshIfStale = useCallback(() => load(), [load])

    return {
        data: ownsState ? data : hasInitialData ? options.initialData as T : null,
        loading: ownsState ? loading : !hasInitialData,
        refreshing: ownsState ? refreshing : false,
        error: ownsState ? error : null,
        isSnapshot: !ownsState || lastLoadedAtRef.current === 0 || refreshing || Boolean(error),
        refresh,
        refreshIfStale,
        markStale,
    }
}
