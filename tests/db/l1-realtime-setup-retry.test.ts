import { AssertionError } from 'node:assert'
import { expect, it, vi } from 'vitest'
import { setupRequest } from './l1-realtime-setup-retry.mjs'

it('records bounded backoff for setup 5xx responses', async () => {
    const retries: unknown[] = []
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 504 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValue(new Response('{}', { status: 200 }))
    const pause = vi.fn()
    const record = vi.fn()
    expect((await setupRequest('http://localhost', {}, { operation: 'login', retries, fetcher, pause, record })).status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(pause.mock.calls).toEqual([[500], [1000]])
    expect(retries).toMatchObject([{ operation: 'login', status: 504, attempt: 1 }, { status: 503, attempt: 2 }])
    expect(record).toHaveBeenCalledTimes(2)
})

it('returns the fifth 5xx response without an unbounded retry', async () => {
    const retries: unknown[] = []
    const fetcher = vi.fn(async () => new Response('', { status: 504 }))
    const pause = vi.fn()
    expect((await setupRequest('http://localhost', {}, { operation: 'login', retries, fetcher, pause })).status).toBe(504)
    expect(fetcher).toHaveBeenCalledTimes(5)
    expect(retries).toHaveLength(4)
})

it('does not retry a client error or an assertion failure', async () => {
    const pause = vi.fn()
    const fetcher = vi.fn(async () => new Response('', { status: 401 }))
    expect((await setupRequest('http://localhost', {}, { operation: 'login', retries: [], fetcher, pause })).status).toBe(401)
    const failure = new AssertionError({ message: 'Incorrect fixture' })
    const asserting = vi.fn().mockRejectedValue(failure)
    await expect(setupRequest('http://localhost', {}, { operation: 'fixture', retries: [], fetcher: asserting, pause })).rejects.toBe(failure)
    expect(asserting).toHaveBeenCalledOnce()
    expect(pause).not.toHaveBeenCalled()
})
