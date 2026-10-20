import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { useKeyedResource } from '@/hooks/use-keyed-resource'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let screen: ReactTestRenderer
const initial: string[] = []
afterEach(async () => { await act(async () => screen?.unmount()) })
it('paints cached rows on the first render of a new key and retains them during refresh and failure', async () => {
    const values = new Map([['a', ['saved-a']], ['b', ['saved-b']]])
    const cache = { read: (key: string) => values.get(key), write: (key: string, rows: string[]) => values.set(key, rows) }
    const fetch = vi.fn<() => Promise<string[]>>()
    let latest!: ReturnType<typeof useKeyedResource<string[]>>
    const frames: { key: string; data: string[]; loaded: boolean }[] = []
    const Probe = ({ resourceKey }: { resourceKey: string }) => {
        latest = useKeyedResource(resourceKey, initial, fetch, cache)
        frames.push({ key: resourceKey, data: latest.data, loaded: latest.loaded })
        return null
    }
    await act(async () => { screen = create(React.createElement(Probe, { resourceKey: 'a' })) })
    await act(async () => screen.update(React.createElement(Probe, { resourceKey: 'b' })))
    expect(frames.find(frame => frame.key === 'b')).toEqual({ key: 'b', data: ['saved-b'], loaded: true })
    let fail!: (error: Error) => void
    fetch.mockReturnValue(new Promise((_, reject) => { fail = reject }))
    let request!: Promise<void>
    await act(async () => { request = latest.refresh() })
    expect(latest.loaded).toBe(true)
    expect(latest.data).toEqual(['saved-b'])
    await act(async () => { fail(new Error('offline')); await request })
    expect(latest.data).toEqual(['saved-b'])
    expect(latest.error).toBe('offline')
    fetch.mockResolvedValue([])
    await act(async () => { await latest.refresh() })
    expect(latest.data).toEqual([])
    expect(latest.loaded).toBe(true)
    expect(latest.error).toBeNull()
})
