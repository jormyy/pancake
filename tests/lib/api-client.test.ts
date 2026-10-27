import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createMutationFetch, guardedRpcNames, requestId } from '@/lib/api-client'

const rpcUrl = 'http://127.0.0.1:59201/rest/v1/rpc/reorder_waiver_claim_atomic'
const id = 'bd722e8d-5566-436e-996e-f810b536a9a0'
const reply = () => Response.json({ claimOrder: 1 })
const sentId = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get('x-request-id')

describe('mutation request identity', () => {
    it('keeps one ID after a dropped response', async () => {
        const send = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('Connection lost')).mockResolvedValueOnce(reply())
        const response = await createMutationFetch(send)(rpcUrl, { method: 'POST', body: '{}' })
        expect(await response.json()).toEqual({ claimOrder: 1 })
        expect(send).toHaveBeenCalledTimes(2)
        expect(sentId(send.mock.calls[0])).toMatch(/^[0-9a-f-]{36}$/)
        expect(sentId(send.mock.calls[1])).toBe(sentId(send.mock.calls[0]))
    })

    it('retries a response body that disconnects after the headers arrive', async () => {
        const broken = new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('Body lost')) } }))
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(broken).mockResolvedValueOnce(reply())
        await expect((await createMutationFetch(send)(rpcUrl, { method: 'POST' })).json()).resolves.toEqual({ claimOrder: 1 })
        expect(sentId(send.mock.calls[0])).toBe(sentId(send.mock.calls[1]))
    })

    it('uses a fresh ID for each concurrent action', async () => {
        const send = vi.fn<typeof fetch>().mockImplementation(async () => reply())
        const fetch = createMutationFetch(send)
        await Promise.all([fetch(rpcUrl, { method: 'POST' }), fetch(rpcUrl, { method: 'POST' })])
        expect(sentId(send.mock.calls[0])).not.toBe(sentId(send.mock.calls[1]))
    })

    it.each(['requestId', 'p_request_id'])('preserves the existing %s fence', async key => {
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(reply())
        await createMutationFetch(send)(rpcUrl, { method: 'POST', body: JSON.stringify({ [key]: id }) })
        expect(sentId(send.mock.calls[0])).toBe(id)
    })

    it('accepts an ID restored from a queued action', async () => {
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(reply())
        await createMutationFetch(send)(rpcUrl, { method: 'POST', headers: { 'x-request-id': id } })
        expect(sentId(send.mock.calls[0])).toBe(id)
    })

    it('preserves a relative API URL', async () => {
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(reply())
        await createMutationFetch(send)('/api/waivers/claims', { method: 'POST', headers: { 'x-request-id': id } })
        expect(send.mock.calls[0][0]).toBe('/api/waivers/claims')
        expect(sentId(send.mock.calls[0])).toBe(id)
    })

    it('stops after two failed transport attempts', async () => {
        const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Offline'))
        await expect(createMutationFetch(send)(rpcUrl, { method: 'POST' })).rejects.toThrow('Offline')
        expect(send).toHaveBeenCalledTimes(2)
    })

    it.each([400, 403, 409])('does not retry a rejected action (%s)', async status => {
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: 'Rejected' }, { status }))
        expect((await createMutationFetch(send)(rpcUrl, { method: 'POST' })).status).toBe(status)
        expect(send).toHaveBeenCalledOnce()
    })

    it('does not retry an aborted action', async () => {
        const controller = new AbortController()
        controller.abort()
        const send = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('Aborted', 'AbortError'))
        await expect(createMutationFetch(send)(rpcUrl, { method: 'POST', signal: controller.signal })).rejects.toThrow('Aborted')
        expect(send).toHaveBeenCalledOnce()
    })

    it('does not retry after the signed-in user changes', async () => {
        let owner = 'first'
        const send = vi.fn<typeof fetch>().mockImplementation(async () => { owner = 'second'; throw new TypeError('Lost') })
        await expect(createMutationFetch(send, () => owner)(rpcUrl, { method: 'POST' })).rejects.toThrow('Lost')
        expect(send).toHaveBeenCalledOnce()
    })

    it('leaves authentication requests unchanged', async () => {
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(reply())
        const url = 'http://127.0.0.1:59201/auth/v1/token'
        const options = { method: 'POST', body: '{}' }
        await createMutationFetch(send)(url, options)
        expect(send).toHaveBeenCalledWith(url, options)
    })

    it('does not retry a write without a receipt guard', async () => {
        const send = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Lost'))
        await expect(createMutationFetch(send)('http://127.0.0.1:59201/rest/v1/players', { method: 'POST' })).rejects.toThrow('Lost')
        expect(send).toHaveBeenCalledOnce()
    })

    it('leaves reads unchanged', async () => {
        const send = vi.fn<typeof fetch>().mockResolvedValueOnce(reply())
        await createMutationFetch(send)(rpcUrl)
        expect(send).toHaveBeenCalledWith(rpcUrl, undefined)
    })

    it('rejects an invalid saved ID', () => {
        expect(() => requestId('bad')).toThrow('UUID')
    })

    it('only retries RPCs with a database receipt guard', () => {
        for (const name of guardedRpcNames) {
            const file = name === 'drop_player_atomic' ? `${name}__uuid_uuid_uuid` : name
            const source = readFileSync(`supabase/sql/functions/by-name/public/${file}.sql`, 'utf8')
            expect(source, name).toContain(`private.request_begin('public.${name}'`)
            expect(source, name).toContain('private.request_finish(')
            expect(source, name).toContain("->>'replay'")
        }
    })
})
