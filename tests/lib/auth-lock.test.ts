import { afterEach, describe, expect, it, vi } from 'vitest'
import { authNavigatorLock } from '@/lib/auth-lock'

const lock = { name: 'session', mode: 'exclusive' } as Lock
const install = (request: ReturnType<typeof vi.fn>) => vi.stubGlobal('navigator', { locks: { request } })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('auth Web Locks', () => {
    it('preserves cancellation before the deadline without stealing or running the callback', async () => {
        vi.useFakeTimers()
        const error = new DOMException('Document is going away', 'AbortError')
        const request = vi.fn().mockRejectedValue(error)
        install(request)
        const fn = vi.fn()
        await expect(authNavigatorLock('session', 5000, fn)).rejects.toBe(error)
        expect(request).toHaveBeenCalledTimes(1)
        expect(request.mock.calls[0][1]).not.toHaveProperty('steal')
        expect(fn).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('times out a pending waiter without stealing the live owner', async () => {
        vi.useFakeTimers()
        const request = vi.fn((_name: string, options: LockOptions) => new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new DOMException('Deadline', 'AbortError')))
        }))
        install(request)
        const fn = vi.fn()
        const pending = authNavigatorLock('session', 5000, fn)
        const check = expect(pending).rejects.toMatchObject({ isAcquireTimeout: true })
        await vi.advanceTimersByTimeAsync(4999)
        expect(request.mock.calls[0][1].signal?.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await check
        expect(request).toHaveBeenCalledTimes(1)
        expect(fn).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
    })

    it('clears the acquisition deadline before a long callback completes', async () => {
        vi.useFakeTimers()
        const request = vi.fn((_name, _options, callback) => callback(lock))
        install(request)
        await expect(authNavigatorLock('session', 20, async () => {
            expect(vi.getTimerCount()).toBe(0)
            await vi.advanceTimersByTimeAsync(100)
            return 'owner result'
        })).resolves.toBe('owner result')
        expect(request.mock.calls[0][1].signal.aborted).toBe(false)
    })

    it('preserves callback AbortError instead of reacquiring and repeating work', async () => {
        install(vi.fn((_name, _options, callback) => callback(lock)))
        const error = new DOMException('Request cancelled', 'AbortError')
        const fn = vi.fn().mockRejectedValue(error)
        await expect(authNavigatorLock('session', 100, fn)).rejects.toBe(error)
        expect(fn).toHaveBeenCalledTimes(1)
    })

    it('fails an unavailable immediate request without executing auth work', async () => {
        const request = vi.fn((_name, _options, callback) => callback(null))
        install(request)
        const fn = vi.fn()
        await expect(authNavigatorLock('session', 0, fn)).rejects.toMatchObject({ isAcquireTimeout: true })
        expect(request.mock.calls[0][1]).toEqual({ mode: 'exclusive', ifAvailable: true })
        expect(fn).not.toHaveBeenCalled()
    })

    it('never treats a missing granted lock as permission to execute', async () => {
        install(vi.fn((_name, _options, callback) => callback(null)))
        const fn = vi.fn()
        await expect(authNavigatorLock('session', 10, fn)).rejects.toThrow('was not granted')
        expect(fn).not.toHaveBeenCalled()
    })

    it('waits without a deadline for negative timeout and preserves successful output', async () => {
        vi.useFakeTimers()
        install(vi.fn((_name, _options, callback) => callback(lock)))
        await expect(authNavigatorLock('session', -1, async () => {
            expect(vi.getTimerCount()).toBe(0)
            return 42
        })).resolves.toBe(42)
    })

    it('preserves non-cancellation SDK errors', async () => {
        const error = new Error('Storage denied')
        install(vi.fn().mockRejectedValue(error))
        await expect(authNavigatorLock('session', 100, async () => 1)).rejects.toBe(error)
    })
})
