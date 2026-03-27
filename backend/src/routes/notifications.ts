import { FastifyInstance } from 'fastify'
import { notifyMember } from '../lib/notifications'
import { NotifyTradeBody } from '../schemas'

export default async function notifyRoutes(app: FastifyInstance) {
    app.post('/trade', { schema: { body: NotifyTradeBody } }, async (req) => {
        const { memberId, title, body } = req.body as {
            memberId: string
            title: string
            body: string
        }
        await notifyMember(memberId, title, body)
        return { ok: true }
    })
}
