import { FastifyInstance } from 'fastify'
import { notifyMember } from '../lib/notifications'
import { ValidationError } from '../plugins/errorHandler'
import { verifySameLeague } from '../lib/authz'
import { NotifyTradeBody } from '../schemas'

export default async function notifyRoutes(app: FastifyInstance) {
    app.post('/trade', { schema: { body: NotifyTradeBody } }, async (req) => {
        const { memberId, title, body } = req.body as {
            memberId: string
            title: string
            body: string
        }

        if (!title?.trim() || !body?.trim()) {
            throw new ValidationError('Title and body are required')
        }

        await verifySameLeague(req.userId, memberId)
        await notifyMember(memberId, title, body)
        return { ok: true }
    })
}
