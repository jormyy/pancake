import { FastifyInstance } from 'fastify'
import { advanceSeason } from '../sync/seasonReset'
import { LeagueIdBody } from '../schemas'

export default async function leagueRoutes(app: FastifyInstance) {
    app.post('/advance-season', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        const result = await advanceSeason(leagueId)
        return { ok: true, ...result }
    })
}
