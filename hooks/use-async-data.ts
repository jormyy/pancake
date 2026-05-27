import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Generic async data fetcher — eliminates the
 * useState(true) + useCallback + try/catch/finally + useEffect pattern.
 *
 * Re-fetches whenever `deps` change.
 *
 * Race-condition safe: each fetch is tagged with a monotonically increasing
 * request id. If `deps` change (or `refresh` is called) while an earlier
 * fetch is still in-flight, the stale resolve is dropped silently so it
 * cannot overwrite the fresh result. Real errors from the latest request
 * are still surfaced; only stale successes/failures are ignored. State
 * updates are also skipped after unmount.
 */
export function useAsyncData<T>(
    fetcher: () => Promise<T>,
    deps: React.DependencyList = [],
) {
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)
    const requestIdRef = useRef(0)
    const mountedRef = useRef(true)

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
        }
    }, [])

    const load = useCallback(async () => {
        const requestId = ++requestIdRef.current
        const isLatest = () => mountedRef.current && requestIdRef.current === requestId

        if (isLatest()) {
            setLoading(true)
            setError(null)
        }
        try {
            const result = await fetcher()
            if (!isLatest()) return
            setData(result)
        } catch (e) {
            if (!isLatest()) return
            setError(e instanceof Error ? e : new Error(String(e)))
            console.error(e)
        } finally {
            if (isLatest()) setLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    useEffect(() => {
        load()
    }, [load])

    return { data, loading, error, refresh: load }
}
