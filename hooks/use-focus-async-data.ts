import { useState, useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'

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
    const isFirstRunRef = useRef(true)
    // Bumped on every deps change so a fetch started for the previous identity
    // (e.g. the old league) can never commit its result over the new one.
    const genRef = useRef(0)
    const staleMs = options.staleMs ?? 30_000

    // Reset freshness gate when deps change so the next focus fetches fresh
    // data for the new identity (e.g. after a league switch). Skip the first
    // run so we don't clobber the initial mount state before any fetch.
    useEffect(() => {
        if (isFirstRunRef.current) {
            isFirstRunRef.current = false
            return
        }
        // Abandon any in-flight fetch for the previous deps so the new identity
        // fetches fresh (without this, load() would return the stale task and
        // commit the old league's data).
        genRef.current += 1
        inFlightRef.current = null
        const hasNextInitialData = options.initialData !== undefined
        hasDataRef.current = hasNextInitialData
        lastLoadedAtRef.current = 0
        setData(hasNextInitialData ? options.initialData as T : null)
        setLoading(!hasNextInitialData)
        setRefreshing(false)
        setError(null)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    const load = useCallback(async (loadOptions: { force?: boolean } = {}) => {
        if (inFlightRef.current) return inFlightRef.current
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

    return { data, loading, refreshing, error, refresh }
}
