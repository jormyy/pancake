import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { RetainedPanel } from '@/components/ui/RetainedPanel'

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, View: 'View', StyleSheet: { create: (styles: unknown) => styles } }))
vi.mock('@react-navigation/native', () => ({ useFocusEffect: (callback: React.EffectCallback) => React.useEffect(callback, [callback]) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let screen: ReactTestRenderer, visible: boolean, online: boolean
let latest: ReturnType<typeof useFocusAsyncData<string>>
const read = vi.fn<() => Promise<string>>(), saved = vi.fn()
function Probe({ enabled = true }: { enabled?: boolean }) {
    latest = useFocusAsyncData(read, ['owner'], { enabled, initialData: 'saved', staleMs: 300_000, onLoaded: saved })
    return null
}
function Panels({ active = true, enabled = true }: { active?: boolean; enabled?: boolean }) {
    return React.createElement(RetainedPanel, { active }, React.createElement(RetainedPanel, { active: true }, React.createElement(Probe, { enabled })))
}
const render = (active = true, enabled = true) => React.createElement(Panels, { active, enabled })
const pending = () => {
    let resolve!: (value: string) => void
    const promise = new Promise<string>(done => { resolve = done })
    return { promise, resolve }
}
beforeEach(() => {
    vi.clearAllMocks()
    visible = true; online = true
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('document', Object.defineProperty(new EventTarget(), 'visibilityState', { get: () => visible ? 'visible' : 'hidden' }))
    vi.stubGlobal('navigator', Object.defineProperty({}, 'onLine', { get: () => online }))
    read.mockResolvedValue('current')
})
afterEach(async () => { await act(async () => screen?.unmount()); vi.unstubAllGlobals() })
const fire = async (target: EventTarget, type: string) => { await act(async () => { target.dispatchEvent(new Event(type)) }) }

describe('retained read activity', () => {
    it('defers the first offline read, retains saved rows, and catches up once online', async () => {
        online = false
        await act(async () => { screen = create(render()) })
        const callsWhileOffline = read.mock.calls.length
        expect(latest.data).toBe('saved')
        expect(latest.loading).toBe(false)
        online = true
        await fire(window, 'online')
        expect(callsWhileOffline).toBe(0)
        expect(read).toHaveBeenCalledOnce()
        expect(latest.data).toBe('current')
        await fire(document, 'visibilitychange')
        expect(read).toHaveBeenCalledOnce()
    })

    it('inherits the hidden outer panel and preserves forced refresh intent until visible', async () => {
        await act(async () => { screen = create(render(false)) })
        const initialReads = read.mock.calls.length
        await act(async () => { expect(await latest.refresh()).toBe(false) })
        const hiddenReads = read.mock.calls.length
        await act(async () => screen.update(render(true)))
        expect(initialReads).toBe(0)
        expect(hiddenReads).toBe(0)
        expect(read).toHaveBeenCalledOnce()
        expect(latest.data).toBe('current')
        await act(async () => screen.update(render(false)))
        await act(async () => screen.update(render(true)))
        expect(read).toHaveBeenCalledOnce()
    })

    it('defers a disabled resource even when its parent panel is visible', async () => {
        await act(async () => { screen = create(render(true, false)) })
        const disabledReads = read.mock.calls.length
        await act(async () => screen.update(render(true, true)))
        expect(disabledReads).toBe(0)
        expect(read).toHaveBeenCalledOnce()
    })

    it.each(['panel', 'visibility', 'network'])('releases a stalled read across %s inactivity and ignores its late snapshot', async kind => {
        const old = pending()
        read.mockReturnValueOnce(old.promise).mockResolvedValueOnce('after return')
        await act(async () => { screen = create(render()) })
        expect(read).toHaveBeenCalledOnce()
        if (kind === 'panel') {
            await act(async () => screen.update(render(false)))
            await act(async () => screen.update(render(true)))
        } else if (kind === 'visibility') {
            visible = false; await fire(document, 'visibilitychange')
            visible = true; await fire(document, 'visibilitychange')
        } else {
            online = false; await fire(window, 'offline')
            online = true; await fire(window, 'online')
        }
        const readsBeforeOldSettles = read.mock.calls.length
        const beforeOldSettles = latest.data
        await act(async () => { old.resolve('before return'); await old.promise })
        expect(readsBeforeOldSettles).toBe(2)
        expect(beforeOldSettles).toBe('after return')
        expect(latest.data).toBe('after return')
        expect(saved.mock.calls).toEqual([['after return']])
    })
})

it('waits for admission before capturing a revision or starting its authoritative read', async () => {
    const gate = pending()
    let revision = 'before'
    const Gated = () => {
        latest = useFocusAsyncData(read, ['gate'], { beforeRead: () => gate.promise, cacheRevision: () => revision, onLoaded: saved })
        return null
    }
    await act(async () => { screen = create(React.createElement(Gated)) })
    expect(read).not.toHaveBeenCalled()
    revision = 'after'
    await act(async () => { gate.resolve('ready') })
    expect(read).toHaveBeenCalledOnce()
    expect(saved).toHaveBeenCalledExactlyOnceWith('current', 'after')
})

it('joins one current follow-up when the source changes during a held authoritative read', async () => {
    const first = pending()
    let revision = 'before'
    read.mockReturnValueOnce(first.promise).mockResolvedValue('newer')
    const Versioned = () => {
        latest = useFocusAsyncData(read, ['source'], { cacheRevision: () => revision, onLoaded: saved, followSourceChanges: true })
        return null
    }
    await act(async () => { screen = create(React.createElement(Versioned)) })
    revision = 'after'
    await act(async () => { first.resolve('older') })
    expect(read).toHaveBeenCalledTimes(2)
    expect(latest.data).toBe('newer')
    expect(saved.mock.calls).toEqual([['older', 'before'], ['newer', 'after']])
})

it('retains a dirty raw event during a held read even when the shared stream is unavailable', async () => {
    const first = pending()
    read.mockReturnValueOnce(first.promise).mockResolvedValue('newer')
    const Unconnected = () => {
        latest = useFocusAsyncData(read, ['raw'], { cacheRevision: () => null, followSourceChanges: true })
        return null
    }
    await act(async () => { screen = create(React.createElement(Unconnected)) })
    await act(async () => { latest.markStale() })
    await act(async () => { first.resolve('older') })
    expect(read).toHaveBeenCalledTimes(2)
    expect(latest.data).toBe('newer')
    expect(latest.isSnapshot).toBe(false)
})
