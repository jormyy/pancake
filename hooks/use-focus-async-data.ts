import { useState, useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'

/**
 * Like useAsyncData but refreshes stale data when the screen gains focus.
 * Existing data stays visible while refreshes run.
 *
 * When `deps` change (e.g. consumer switches league), the freshness gate and
 * cached data are reset so the next focus triggers a fresh fetch instead of
 * short-circuiting on stale state from the previous deps.
 */
export function useFocusAsyncData<T>(
    fetcher: () => Promise<T>,
    deps: React.DependencyList = [],
    options: { staleMs?: number } = {},
) {
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<Error | null>(null)
    const lastLoadedAtRef = useRef(0)
    const inFlightRef = useRef<Promise<void> | null>(null)
    const hasDataRef = useRef(false)
    const isFirstRunRef = useRef(true)
    const staleMs = options.staleMs ?? 30_000

    // Reset freshness gate when deps change so the next focus fetches fresh
    // data for the new identity (e.g. after a league switch). Skip the first
    // run so we don't clobber the initial mount state before any fetch.
    useEffect(() => {
        if (isFirstRunRef.current) {
            isFirstRunRef.current = false
            return
        }
        hasDataRef.current = false
        lastLoadedAtRef.current = 0
        setData(null)
        setLoading(true)
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
        const task = (async () => {
            try {
                const result = await fetcher()
                setData(result)
                hasDataRef.current = true
                lastLoadedAtRef.current = Date.now()
            } catch (e) {
                setError(e instanceof Error ? e : new Error(String(e)))
                console.error(e)
            } finally {
                setLoading(false)
                setRefreshing(false)
                inFlightRef.current = null
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
