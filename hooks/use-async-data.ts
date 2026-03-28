import { useState, useEffect, useCallback } from 'react'

/**
 * Generic async data fetcher — eliminates the
 * useState(true) + useCallback + try/catch/finally + useEffect pattern.
 *
 * Re-fetches whenever `deps` change.
 */
export function useAsyncData<T>(
    fetcher: () => Promise<T>,
    deps: React.DependencyList = [],
) {
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<Error | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const result = await fetcher()
            setData(result)
        } catch (e: any) {
            setError(e)
            console.error(e)
        } finally {
            setLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    useEffect(() => {
        load()
    }, [load])

    return { data, loading, error, refresh: load }
}
