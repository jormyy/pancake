import { FastifyInstance } from 'fastify'
import { advanceSeason } from '../sync/seasonReset'
import { ValidationError } from '../plugins/errorHandler'
import { requireCommissioner } from '../lib/authz'
import { toggleIRStatus, toggleTaxiStatus } from '../services/roster'
import { IRBody, LeagueIdBody, TaxiBody } from '../schemas'

export default async function leagueRoutes(app: FastifyInstance) {
    app.post('/advance-season', { schema: { body: LeagueIdBody } }, async (req) => {
        const { leagueId } = req.body as { leagueId: string }
        await requireCommissioner(req.userId, leagueId)
        const result = await advanceSeason(leagueId)
        return { ok: true, ...result }
    })

    app.post(
        '/roster/ir',
        {
            schema: { body: IRBody },
            config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        },
        async (req) => {
            const { rosterPlayerId, isOnIR } = req.body as {
                rosterPlayerId: string
                isOnIR: boolean
            }
            if (!rosterPlayerId || typeof isOnIR !== 'boolean') {
                throw new ValidationError('rosterPlayerId and isOnIR required')
            }
            await toggleIRStatus(rosterPlayerId, isOnIR, req.userId)
            return { ok: true }
        },
    )

    app.post(
        '/roster/taxi',
        {
            schema: { body: TaxiBody },
            config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
        },
        async (req) => {
            const { rosterPlayerId, isOnTaxi } = req.body as {
                rosterPlayerId: string
                isOnTaxi: boolean
            }
            if (!rosterPlayerId || typeof isOnTaxi !== 'boolean') {
                throw new ValidationError('rosterPlayerId and isOnTaxi required')
            }
            await toggleTaxiStatus(rosterPlayerId, isOnTaxi, req.userId)
            return { ok: true }
        },
    )
}
