import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/supabase', () => ({
    supabase: { from: vi.fn(), rpc: vi.fn() },
}))

vi.mock('../src/lib/authz', () => ({
    verifyOwnMember: vi.fn().mockResolvedValue(undefined),
    requireOwnMember: vi.fn().mockResolvedValue({ leagueId: 'league-1' }),
}))

vi.mock('../src/lib/notifications', () => ({
    notifyMember: vi.fn().mockResolvedValue(undefined),
}))

import errorHandlerPlugin from '../src/plugins/errorHandler'
import tradeRoutes from '../src/routes/trades'
import { supabase } from '../src/lib/supabase'
import { notifyMember } from '../src/lib/notifications'

const mockFrom = vi.mocked(supabase.from)
const mockNotifyMember = vi.mocked(notifyMember)
const TRADE_ID = 'c524c9a7-bea0-43f0-a019-86140319973a'
const PROPOSER_ID = '3825f66c-7f87-4e49-a2cc-a29a761ce3b3'
const RECIPIENT_ID = 'e8a68593-2f8f-4a39-8016-869d381db824'

function query(result: unknown) {
    const chain: any = {
        select: vi.fn(() => chain),
        update: vi.fn(() => chain),
        eq: vi.fn(() => chain),
        single: vi.fn().mockResolvedValue(result),
        maybeSingle: vi.fn().mockResolvedValue(result),
    }
    return chain
}

async function buildTradesApp() {
    const app = Fastify({ logger: false })
    await app.register(errorHandlerPlugin)
    app.addHook('onRequest', async (request) => {
        request.userId = 'u1'
    })
    await app.register(tradeRoutes)
    return app
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('trade terminal actions', () => {
    it('accept scopes trade lookup to the accepting member before calling the RPC', async () => {
        const fetchTrade = query({
            data: {
                id: TRADE_ID,
                proposer_member_id: PROPOSER_ID,
                recipient_member_id: RECIPIENT_ID,
                status: 'pending',
            },
            error: null,
        })
        mockFrom.mockReturnValueOnce(fetchTrade)
        vi.mocked(supabase.rpc).mockResolvedValueOnce({ data: null, error: null } as any)

        const app = await buildTradesApp()
        const response = await app.inject({
            method: 'POST',
            url: `/${TRADE_ID}/accept`,
            headers: { 'content-type': 'application/json' },
            payload: { memberId: RECIPIENT_ID, dropRosterPlayerIds: [] },
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        expect(fetchTrade.eq).toHaveBeenCalledWith('id', TRADE_ID)
        expect(fetchTrade.eq).toHaveBeenCalledWith('recipient_member_id', RECIPIENT_ID)
        expect(supabase.rpc).toHaveBeenCalledWith('accept_trade_atomic', {
            p_trade_id: TRADE_ID,
            p_accepting_member_id: RECIPIENT_ID,
            p_drop_roster_player_ids: [],
        })
    })

    it('reject fails without notification if the pending update loses a race', async () => {
        const fetchTrade = query({
            data: {
                id: TRADE_ID,
                proposer_member_id: PROPOSER_ID,
                recipient_member_id: RECIPIENT_ID,
                status: 'pending',
            },
            error: null,
        })
        const staleUpdate = query({ data: null, error: null })
        mockFrom
            .mockReturnValueOnce(fetchTrade)
            .mockReturnValueOnce(staleUpdate)

        const app = await buildTradesApp()
        const response = await app.inject({
            method: 'POST',
            url: `/${TRADE_ID}/reject`,
            headers: { 'content-type': 'application/json' },
            payload: { memberId: RECIPIENT_ID, dropRosterPlayerIds: [] },
        })
        await app.close()

        expect(response.statusCode).toBe(400)
        expect(response.json().message).toBe('This trade is no longer pending.')
        expect(fetchTrade.eq).toHaveBeenCalledWith('recipient_member_id', RECIPIENT_ID)
        expect(staleUpdate.select).toHaveBeenCalledWith('id')
        expect(mockNotifyMember).not.toHaveBeenCalled()
    })

    it('reject returns not found for trades not visible to the acting recipient member', async () => {
        const scopedMiss = query({ data: null, error: null })
        mockFrom.mockReturnValueOnce(scopedMiss)

        const app = await buildTradesApp()
        const response = await app.inject({
            method: 'POST',
            url: `/${TRADE_ID}/reject`,
            headers: { 'content-type': 'application/json' },
            payload: { memberId: RECIPIENT_ID, dropRosterPlayerIds: [] },
        })
        await app.close()

        expect(response.statusCode).toBe(404)
        expect(scopedMiss.eq).toHaveBeenCalledWith('id', TRADE_ID)
        expect(scopedMiss.eq).toHaveBeenCalledWith('recipient_member_id', RECIPIENT_ID)
        expect(mockNotifyMember).not.toHaveBeenCalled()
    })

    it('withdraw fails without notification if the pending update loses a race', async () => {
        const fetchTrade = query({
            data: {
                id: TRADE_ID,
                proposer_member_id: PROPOSER_ID,
                recipient_member_id: RECIPIENT_ID,
                status: 'pending',
            },
            error: null,
        })
        const staleUpdate = query({ data: null, error: null })
        mockFrom
            .mockReturnValueOnce(fetchTrade)
            .mockReturnValueOnce(staleUpdate)

        const app = await buildTradesApp()
        const response = await app.inject({
            method: 'POST',
            url: `/${TRADE_ID}/withdraw`,
            headers: { 'content-type': 'application/json' },
            payload: { memberId: PROPOSER_ID, dropRosterPlayerIds: [] },
        })
        await app.close()

        expect(response.statusCode).toBe(400)
        expect(response.json().message).toBe('This trade is no longer pending.')
        expect(fetchTrade.eq).toHaveBeenCalledWith('proposer_member_id', PROPOSER_ID)
        expect(staleUpdate.select).toHaveBeenCalledWith('id')
        expect(mockNotifyMember).not.toHaveBeenCalled()
    })

    it('withdraw returns not found for trades not visible to the acting proposer member', async () => {
        const scopedMiss = query({ data: null, error: null })
        mockFrom.mockReturnValueOnce(scopedMiss)

        const app = await buildTradesApp()
        const response = await app.inject({
            method: 'POST',
            url: `/${TRADE_ID}/withdraw`,
            headers: { 'content-type': 'application/json' },
            payload: { memberId: PROPOSER_ID, dropRosterPlayerIds: [] },
        })
        await app.close()

        expect(response.statusCode).toBe(404)
        expect(scopedMiss.eq).toHaveBeenCalledWith('id', TRADE_ID)
        expect(scopedMiss.eq).toHaveBeenCalledWith('proposer_member_id', PROPOSER_ID)
        expect(mockNotifyMember).not.toHaveBeenCalled()
    })

    it('veto scopes trade lookup to the acting member league before calling the RPC', async () => {
        const fetchTrade = query({ data: { id: TRADE_ID }, error: null })
        mockFrom.mockReturnValueOnce(fetchTrade)
        vi.mocked(supabase.rpc).mockResolvedValueOnce({
            data: {
                vetoed: false,
                vetoCount: 1,
                threshold: 3,
                proposerMemberId: PROPOSER_ID,
                recipientMemberId: RECIPIENT_ID,
            },
            error: null,
        } as any)

        const app = await buildTradesApp()
        const response = await app.inject({
            method: 'POST',
            url: `/${TRADE_ID}/veto`,
            headers: { 'content-type': 'application/json' },
            payload: { memberId: RECIPIENT_ID },
        })
        await app.close()

        expect(response.statusCode).toBe(200)
        expect(fetchTrade.eq).toHaveBeenCalledWith('id', TRADE_ID)
        expect(fetchTrade.eq).toHaveBeenCalledWith('league_id', 'league-1')
        expect(supabase.rpc).toHaveBeenCalledWith('veto_trade_atomic', {
            p_trade_id: TRADE_ID,
            p_member_id: RECIPIENT_ID,
        })
    })
})
