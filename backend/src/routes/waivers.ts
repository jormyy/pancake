import { FastifyInstance } from 'fastify'
import { processWaiverClaims } from '../sync/waivers'

export default async function waiverRoutes(app: FastifyInstance) {
    app.post('/process', async () => {
        await processWaiverClaims()
        return { ok: true }
    })
}
