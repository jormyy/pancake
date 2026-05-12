import { FastifyInstance } from 'fastify'
import { generateSemifinals, advanceToFinal } from '../sync/playoffs'
import { LeagueIdBody } from '../schemas'
import { requireCommissioner } from '../lib/authz'

export default async function playoffRoutes(app: FastifyInstance) {
    app.post('/generate', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await requireCommissioner(req.userId, leagueId)
        await generateSemifinals(leagueId)
        return { ok: true }
    })

    app.post('/advance', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await requireCommissioner(req.userId, leagueId)
        await advanceToFinal(leagueId)
        return { ok: true }
    })
}
