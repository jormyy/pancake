import { useState, useCallback } from 'react'
import { useFocusEffect } from '@react-navigation/native'

/**
 * Like useAsyncData but re-fetches every time the screen gains focus.
 * Ideal for tab screens that should refresh when navigated back to.
 */
export function useFocusAsyncData<T>(
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

    useFocusEffect(
        useCallback(() => {
            load()
        }, [load]),
    )

    return { data, loading, error, refresh: load }
}
