import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, AppState: { currentState: 'active' } }))

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
    it('does not start a queued read after unmount or publish its late result', async () => {
        const read = deferred<string>()
        const fetcher = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue('obsolete queued result')
        let latest!: ReturnType<typeof useFocusAsyncData<string>>
        const Probe = () => { latest = useFocusAsyncData(fetcher, ['owner']); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let first!: Promise<boolean>, queued!: Promise<boolean>
        await act(async () => { first = latest.refresh(); queued = latest.refresh() })
        const detachedRefresh = latest.refresh
        await act(async () => { renderer.unmount() })
        await act(async () => { read.resolve('old result'); await Promise.all([first, queued]) })
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(await first).toBe(false)
        expect(await queued).toBe(false)
        expect(await detachedRefresh()).toBe(false)
        expect(fetcher).toHaveBeenCalledTimes(1)
    })

    it('publishes only current mounted results to the saved snapshot callback', async () => {
        const old = deferred<string>()
        const save = vi.fn()
        let latest!: ReturnType<typeof useFocusAsyncData<string>>
        const Probe = ({ owner }: { owner: string }) => {
            latest = useFocusAsyncData(() => owner === 'a' ? old.promise : Promise.resolve('current'), [owner], { onLoaded: save })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe, { owner: 'a' })) })
        let oldRead!: Promise<boolean>
        await act(async () => { oldRead = latest.refresh() })
        await act(async () => { renderer.update(React.createElement(Probe, { owner: 'b' })) })
        await act(async () => { await latest.refresh() })
        expect(save.mock.calls).toEqual([['current']])
        await act(async () => { renderer.unmount(); old.resolve('old'); await oldRead })
        expect(save.mock.calls).toEqual([['current']])
    })

    it('rereads after a new change arrives during the queued refresh', async () => {
        const reads = [deferred<string>(), deferred<string>(), deferred<string>()]
        const fetcher = vi.fn().mockReturnValueOnce(reads[0].promise)
            .mockReturnValueOnce(reads[1].promise).mockReturnValueOnce(reads[2].promise)
        let latest!: ReturnType<typeof useFocusAsyncData<string>>
        const Probe = () => { latest = useFocusAsyncData(fetcher, ['owner']); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        let first!: Promise<boolean>, queued!: Promise<boolean>, newer!: Promise<boolean>
        await act(async () => {
            first = latest.refresh()
            queued = latest.refresh()
            reads[0].resolve('initial')
            await first
        })
        expect(fetcher).toHaveBeenCalledTimes(2)
        let newerSettled = false
        await act(async () => {
            newer = latest.refresh()
            void newer.then(() => { newerSettled = true })
            reads[1].resolve('before-latest-change')
            await Promise.resolve()
        })
        expect(fetcher).toHaveBeenCalledTimes(3)
        expect(newerSettled).toBe(false)
        await act(async () => { reads[2].resolve('latest'); await Promise.all([queued, newer]) })
        expect(latest.data).toBe('latest')
        expect(latest.isSnapshot).toBe(false)
        await act(async () => { renderer.unmount() })
    })

    it('keeps saved content as a snapshot through a failed refresh, then replaces it with confirmed empty', async () => {
        const fetcher = vi.fn<() => Promise<string[]>>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce([])
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        let latest!: ReturnType<typeof useFocusAsyncData<string[]>>
        const Probe = () => {
            latest = useFocusAsyncData(fetcher, ['owner-a'], { initialData: ['saved'] })
            return null
        }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        expect(latest.isSnapshot).toBe(true)
        await act(async () => { expect(await latest.refresh()).toBe(false) })
        expect(latest.data).toEqual(['saved'])
        expect(latest.error?.message).toBe('offline')
        expect(latest.isSnapshot).toBe(true)
        await act(async () => { expect(await latest.refresh()).toBe(true) })
        expect(latest.data).toEqual([])
        expect(latest.error).toBeNull()
        expect(latest.isSnapshot).toBe(false)
        await act(async () => { renderer.unmount() })
        log.mockRestore()
    })

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

        let initial!: Promise<boolean> | undefined
        let refresh!: Promise<boolean> | undefined
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

describe('useFocusAsyncData web reconnect and foreground', () => {
    const dispatch = (target: EventTarget, type: string) => target.dispatchEvent(new Event(type))

    it('reacts to online/foreground only while focused: online always refetches, foreground only when stale', async () => {
        // The suite runs in a node environment; stand in for the browser globals
        // the hook listens on, and remove them afterwards.
        const fakeWindow = new EventTarget()
        let visibility = 'visible'
        const fakeDocument = Object.defineProperty(new EventTarget(), 'visibilityState', { get: () => visibility })
        const globals = globalThis as { window?: unknown; document?: unknown }
        globals.window = fakeWindow
        globals.document = fakeDocument
        const fetcher = vi.fn(async () => 'value')
        const Probe = () => { useFocusAsyncData(fetcher, ['k'], { staleMs: 60_000 }); return null }
        let renderer!: ReactTestRenderer
        await act(async () => { renderer = create(React.createElement(Probe)) })
        // Screens stay mounted but unfocused on web: before focus, browser events must be ignored.
        await act(async () => { dispatch(fakeWindow, 'online') })
        expect(fetcher).toHaveBeenCalledTimes(0)

        let blur: (() => void) | void
        await act(async () => { blur = (focusCallbacks.at(-1) as () => (() => void) | void)() })
        expect(fetcher).toHaveBeenCalledTimes(1) // focus loads once

        await act(async () => { dispatch(fakeDocument, 'visibilitychange') })
        expect(fetcher).toHaveBeenCalledTimes(1) // fresh: gate holds

        await act(async () => { dispatch(fakeWindow, 'online') })
        expect(fetcher).toHaveBeenCalledTimes(2) // reconnect on the focused screen always refetches

        visibility = 'hidden'
        await act(async () => { dispatch(fakeDocument, 'visibilitychange') })
        expect(fetcher).toHaveBeenCalledTimes(2)

        await act(async () => { if (typeof blur === 'function') blur() })
        await act(async () => { dispatch(fakeWindow, 'online') })
        expect(fetcher).toHaveBeenCalledTimes(2) // blurred screen ignores reconnect

        await act(async () => { renderer.unmount() })
        await act(async () => { dispatch(fakeWindow, 'online') })
        expect(fetcher).toHaveBeenCalledTimes(2) // listeners removed on unmount
        delete globals.window
        delete globals.document
    })
})
