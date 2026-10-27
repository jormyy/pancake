import { afterEach, describe, expect, it, vi } from 'vitest'
import { withPwaMutation } from '@/lib/shared/pwa-mutation'
import { isPwaUpdateHeld } from '@/lib/pwa-update-guard'

const id = 'fdca148b-b232-42e3-ae52-cf408f3ad450'
afterEach(() => vi.unstubAllGlobals())

describe('queued mutation identity', () => {
    it('retains a restored ID while offline', async () => {
        const events = new EventTarget()
        vi.stubGlobal('window', events)
        vi.stubGlobal('navigator', { onLine: false })
        const write = vi.fn(async requestId => requestId)
        const queued = JSON.parse(JSON.stringify({ requestId: id, waitForOnline: true }))
        const pending = withPwaMutation('queued claim', write, queued)
        expect(isPwaUpdateHeld()).toBe(true)
        expect(write).not.toHaveBeenCalled()
        events.dispatchEvent(new Event('online'))
        expect(await pending).toBe(id)
        expect(write).toHaveBeenCalledExactlyOnceWith(id)
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('allocates the ID before the queue resumes', async () => {
        const events = new EventTarget()
        vi.stubGlobal('window', events)
        vi.stubGlobal('navigator', { onLine: false })
        const uuid = vi.spyOn(crypto, 'randomUUID')
        const pending = withPwaMutation('queued action', async requestId => requestId, { waitForOnline: true })
        expect(uuid).toHaveBeenCalledOnce()
        const generated = uuid.mock.results[0].value
        events.dispatchEvent(new Event('online'))
        expect(await pending).toBe(generated)
        uuid.mockRestore()
    })

    it('releases a cancelled queued action without sending it', async () => {
        vi.stubGlobal('window', new EventTarget())
        vi.stubGlobal('navigator', { onLine: false })
        const controller = new AbortController()
        const write = vi.fn()
        const pending = withPwaMutation('cancelled', write, { requestId: id, waitForOnline: true, signal: controller.signal })
        controller.abort(new Error('Cancelled'))
        await expect(pending).rejects.toThrow('Cancelled')
        expect(write).not.toHaveBeenCalled()
        expect(isPwaUpdateHeld()).toBe(false)
    })

    it('releases a failed action and preserves its saved identity for a retry', async () => {
        const action = { requestId: id }
        await expect(withPwaMutation('claim', async () => { throw new Error('Lost') }, action)).rejects.toThrow('Lost')
        expect(await withPwaMutation('claim retry', async requestId => requestId, action)).toBe(id)
        expect(isPwaUpdateHeld()).toBe(false)
    })
})
