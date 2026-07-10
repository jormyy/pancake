import { useCallback, useEffect, useRef, useState } from 'react'

type ResourceState<Value> = {
    key: string | null
    data: Value
    loading: boolean
    // True once a fetch for this key has succeeded. Consumers use this to
    // render nothing until first load (content appears fully formed, no
    // layout shift) and to keep content mounted during background refreshes.
    loaded: boolean
    error: string | null
}

export function useKeyedResource<Value>(
    key: string | null,
    initialValue: Value,
    fetchValue: () => Promise<Value>,
) {
    const activeKey = useRef(key)
    activeKey.current = key
    const generation = useRef(0)
    const loaded = useRef(false)
    const invalidated = useRef(false)
    const inFlight = useRef<{ key: string; promise: Promise<void> } | null>(null)
    const loadRef = useRef<(force?: boolean) => Promise<void>>(() => Promise.resolve())
    const [state, setState] = useState<ResourceState<Value>>({
        key,
        data: initialValue,
        loading: Boolean(key),
        loaded: false,
        error: null,
    })

    useEffect(() => {
        generation.current += 1
        loaded.current = false
        invalidated.current = false
        inFlight.current = null
        setState({ key, data: initialValue, loading: Boolean(key), loaded: false, error: null })
    }, [initialValue, key])

    const load = useCallback((force = false): Promise<void> => {
        if (!key) return Promise.resolve()
        if (force) loaded.current = false
        const existing = inFlight.current
        if (existing?.key === key) {
            if (force) invalidated.current = true
            return existing.promise
        }
        if (loaded.current) return Promise.resolve()
        const requestGeneration = generation.current
        const request = { key, promise: Promise.resolve() }
        setState((current) => current.key === key ? { ...current, loading: true, error: null } : current)
        request.promise = fetchValue()
            .then((data) => {
                if (activeKey.current !== key || generation.current !== requestGeneration) return
                loaded.current = true
                setState({ key, data, loading: false, loaded: true, error: null })
            })
            .catch((error: unknown) => {
                if (activeKey.current !== key || generation.current !== requestGeneration) return
                setState((current) => current.key === key ? {
                    ...current,
                    loading: false,
                    error: error instanceof Error ? error.message : 'Unknown error',
                } : current)
            })
            .finally(async () => {
                if (inFlight.current !== request) return
                inFlight.current = null
                if (!invalidated.current || activeKey.current !== key) return
                invalidated.current = false
                loaded.current = false
                await loadRef.current(true)
            })
        inFlight.current = request
        return request.promise
    }, [fetchValue, key])
    loadRef.current = load

    const invalidate = useCallback((reload: boolean) => {
        loaded.current = false
        if (inFlight.current) invalidated.current = true
        else if (reload) void load()
    }, [load])

    const ensure = useCallback(() => load(), [load])
    const refresh = useCallback(() => load(true), [load])
    const setData = useCallback((update: (current: Value) => Value) => {
        setState((current) => current.key === activeKey.current
            ? { ...current, data: update(current.data) }
            : current)
    }, [])
    const ownsKey = state.key === key
    return {
        data: ownsKey ? state.data : initialValue,
        error: ownsKey ? state.error : null,
        loading: ownsKey ? state.loading : Boolean(key),
        loaded: ownsKey ? state.loaded : false,
        ensure,
        refresh,
        invalidate,
        setData,
    }
}
