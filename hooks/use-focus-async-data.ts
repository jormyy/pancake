import { useState, useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'

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
    options: { staleMs?: number; initialData?: T } = {},
) {
    const hasInitialData = options.initialData !== undefined
    const [data, setData] = useState<T | null>(hasInitialData ? options.initialData as T : null)
    const [loading, setLoading] = useState(!hasInitialData)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const lastLoadedAtRef = useRef(0)
    const inFlightRef = useRef<Promise<void> | null>(null)
    const hasDataRef = useRef(hasInitialData)
    const genRef = useRef(0)
    const renderedDepsRef = useRef(deps)
    const stateGenerationRef = useRef(0)
    const forceQueuedRef = useRef(false)
    const queuedRefreshRef = useRef<Promise<void> | null>(null)
    const staleMs = options.staleMs ?? 30_000

    // Effects run after a render. Advance ownership during render so consumers
    // never observe the previous identity's data for one committed frame.
    if (!dependenciesEqual(renderedDepsRef.current, deps)) {
        renderedDepsRef.current = deps
        genRef.current += 1
        inFlightRef.current = null
        forceQueuedRef.current = false
        queuedRefreshRef.current = null
        hasDataRef.current = hasInitialData
        lastLoadedAtRef.current = 0
    }
    const generation = genRef.current
    const ownsState = stateGenerationRef.current === generation

    // Reset freshness gate when deps change so the next focus fetches fresh
    // data for the new identity (e.g. after a league switch).
    useEffect(() => {
        const hasNextInitialData = options.initialData !== undefined
        hasDataRef.current = hasNextInitialData
        lastLoadedAtRef.current = 0
        stateGenerationRef.current = generation
        setData(hasNextInitialData ? options.initialData as T : null)
        setLoading(!hasNextInitialData)
        setRefreshing(false)
        setError(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, generation])

    const load = useCallback(async (loadOptions: { force?: boolean } = {}): Promise<void> => {
        if (inFlightRef.current) {
            if (!loadOptions.force) return inFlightRef.current
            forceQueuedRef.current = true
            if (!queuedRefreshRef.current) {
                const queuedGeneration = genRef.current
                queuedRefreshRef.current = inFlightRef.current
                    .then(async () => {
                        if (queuedGeneration !== genRef.current || !forceQueuedRef.current) return
                        forceQueuedRef.current = false
                        await load({ force: true })
                    })
                    .finally(() => {
                        if (queuedGeneration === genRef.current) queuedRefreshRef.current = null
                    })
            }
            return queuedRefreshRef.current
        }
        const hasData = hasDataRef.current
        const isFresh = Date.now() - lastLoadedAtRef.current < staleMs
        if (!loadOptions.force && hasData && isFresh) return

        if (hasData) setRefreshing(true)
        else setLoading(true)
        setError(null)
        const gen = genRef.current
        const task = (async () => {
            try {
                const result = await fetcher()
                if (gen !== genRef.current) return // deps changed mid-fetch — drop stale result
                setData(result)
                stateGenerationRef.current = gen
                hasDataRef.current = true
                lastLoadedAtRef.current = Date.now()
            } catch (e) {
                if (gen !== genRef.current) return
                setError(e instanceof Error ? e : new Error(String(e)))
                console.error(e)
            } finally {
                if (gen === genRef.current) {
                    setLoading(false)
                    setRefreshing(false)
                    inFlightRef.current = null
                }
            }
        })()
        inFlightRef.current = task
        return task
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, staleMs])

    useFocusEffect(
        useCallback(() => {
            load()
        }, [load]),
    )

    const refresh = useCallback(() => load({ force: true }), [load])

    return {
        data: ownsState ? data : hasInitialData ? options.initialData as T : null,
        loading: ownsState ? loading : !hasInitialData,
        refreshing: ownsState ? refreshing : false,
        error: ownsState ? error : null,
        refresh,
    }
}
