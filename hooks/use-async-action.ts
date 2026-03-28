import { useState, useCallback } from 'react'

/**
 * Wraps an async mutation (add/drop/toggle/cancel) so the caller
 * gets a stable `run` function and a reactive `loading` flag.
 */
export function useAsyncAction<Args extends any[], R = void>(
    action: (...args: Args) => Promise<R>,
) {
    const [loading, setLoading] = useState(false)

    const run = useCallback(
        async (...args: Args): Promise<R | undefined> => {
            setLoading(true)
            try {
                return await action(...args)
            } catch (e: any) {
                throw e
            } finally {
                setLoading(false)
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [action],
    )

    return { run, loading }
}
