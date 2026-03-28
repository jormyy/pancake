import { FastifyInstance } from 'fastify'
import { generateSemifinals, advanceToFinal } from '../sync/playoffs'
import { LeagueIdBody } from '../schemas'

export default async function playoffRoutes(app: FastifyInstance) {
    app.post('/generate', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await generateSemifinals(leagueId)
        return { ok: true }
    })

    app.post('/advance', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await advanceToFinal(leagueId)
        return { ok: true }
    })
}
