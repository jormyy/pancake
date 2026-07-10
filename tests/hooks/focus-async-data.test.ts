import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'

const focusCallbacks: (() => void)[] = []
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (callback: () => void) => { focusCallbacks.push(callback) },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const deferred = <Value,>() => {
    let resolve!: (value: Value) => void
    const promise = new Promise<Value>((done) => { resolve = done })
    return { promise, resolve }
}

describe('useFocusAsyncData', () => {
    it('does not expose data from the previous dependency identity during the switch render', async () => {
        let latest!: ReturnType<typeof useFocusAsyncData<string>>
        const snapshots: { resourceKey: string; data: string | null; loading: boolean }[] = []
        const Probe = ({ resourceKey }: { resourceKey: string }) => {
            latest = useFocusAsyncData(async () => resourceKey, [resourceKey])
            snapshots.push({ resourceKey, data: latest.data, loading: latest.loading })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { resourceKey: 'owner-a' })) })
        await act(async () => { await latest.refresh() })
        expect(latest.data).toBe('owner-a')

        await act(async () => { renderer.update(React.createElement(Probe, { resourceKey: 'owner-b' })) })

        expect(snapshots.find((snapshot) => snapshot.resourceKey === 'owner-b')).toEqual({
            resourceKey: 'owner-b', data: null, loading: true,
        })
        await act(async () => { renderer.unmount() })
    })

    it('queues one forced reread behind an in-flight request and resolves refresh after it', async () => {
        const first = deferred<string>()
        const second = deferred<string>()
        const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        let latest!: ReturnType<typeof useFocusAsyncData<string>>
        const Probe = () => {
            latest = useFocusAsyncData(fetcher, ['owner'])
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })

        let initial!: Promise<void> | undefined
        let refresh!: Promise<void> | undefined
        await act(async () => {
            initial = latest.refresh()
            refresh = latest.refresh()
            first.resolve('before-realtime-event')
            await initial
        })
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(latest.data).toBe('before-realtime-event')
        let settled = false
        void refresh?.then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)

        await act(async () => { second.resolve('after-realtime-event'); await refresh })
        expect(latest.data).toBe('after-realtime-event')
        expect(fetcher).toHaveBeenCalledTimes(2)
        await act(async () => { renderer.unmount() })
    })
})
