import { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'
import { verifyOwnMember } from '../lib/authz'
import { TradeActionBody, TradeParams } from '../schemas'

export default async function tradeRoutes(app: FastifyInstance) {
    app.post(
        '/:tradeId/accept',
        { schema: { params: TradeParams, body: TradeActionBody } },
        async (req) => {
            const { tradeId } = req.params as { tradeId: string }
            const { memberId } = req.body as { memberId: string }

            await verifyOwnMember(req.userId, memberId)

            const { error } = await supabase.rpc('accept_trade_atomic', {
                p_trade_id: tradeId,
                p_accepting_member_id: memberId,
            })

            if (error) throw error

            return { ok: true }
        },
    )
}
