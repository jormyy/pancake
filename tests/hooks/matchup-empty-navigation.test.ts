import { boundary, held } from '../helpers/screen-view-boundary'
import { homeHarness, homePayload } from '../helpers/home-view-fixture'
import { act } from 'react-test-renderer'
import { beforeEach, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const h = homeHarness()
beforeEach(() => { boundary.read.mockResolvedValue({ ...homePayload(), matchup: null }) })
it('restores the empty notice in every frame through ten back and forward remounts', async () => {
    await h.render()
    for (let index = 0; index < 10; index += 1) {
        await h.unmount(); h.frames.length = 0; await h.render()
        expect(h.frames.length).toBeGreaterThan(0)
        expect(h.frames.every(frame => frame.emptyConfirmed)).toBe(true)
    }
    expect(boundary.read).toHaveBeenCalledOnce()
})
it('restores the empty notice after changing leagues without a blank frame', async () => {
    await h.render(); await h.render({ league: 'other' }); h.frames.length = 0; await h.render()
    expect(h.frames.length).toBeGreaterThan(0)
    expect(h.frames.every(frame => frame.emptyConfirmed)).toBe(true)
    expect(boundary.read).toHaveBeenCalledTimes(2)
})
it('keeps a validated cached empty answer visible during membership revalidation', async () => {
    await h.render(); await h.unmount(); h.frames.length = 0; await h.render({ validated: false })
    expect(h.frames.length).toBeGreaterThan(0)
    expect(h.frames.every(frame => frame.emptyConfirmed)).toBe(true)
})
it('keeps a cached empty answer through a slow failed refresh', async () => {
    await h.render()
    const next = held<ReturnType<typeof homePayload>>()
    boundary.read.mockReturnValueOnce(next.promise)
    let request!: Promise<void>
    h.frames.length = 0
    await act(async () => { request = h.latest.refresh() })
    expect(h.frames.every(frame => frame.emptyConfirmed)).toBe(true)
    await act(async () => { next.reject(new Error('offline')); await request })
    expect(h.frames.every(frame => frame.emptyConfirmed)).toBe(true)
    expect(h.latest.error).toBe('offline')
})
