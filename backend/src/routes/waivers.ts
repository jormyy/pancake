import { FastifyInstance } from 'fastify'
import { processWaiverClaims } from '../sync/waivers'
import { requireAdmin } from '../lib/authz'

export default async function waiverRoutes(app: FastifyInstance) {
    app.post('/process', async (req) => {
        requireAdmin(req.userId)
        await processWaiverClaims()
        return { ok: true }
    })
}
