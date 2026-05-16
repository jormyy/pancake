import { useState, useCallback, useRef } from 'react'
import { useFocusEffect } from '@react-navigation/native'

/**
 * Like useAsyncData but refreshes stale data when the screen gains focus.
 * Existing data stays visible while refreshes run.
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
    const staleMs = options.staleMs ?? 30_000

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
            } catch (e: any) {
                setError(e)
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
