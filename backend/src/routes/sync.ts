import { FastifyInstance } from 'fastify'
import { syncPlayers } from '../sync/players'
import { syncSchedule } from '../sync/games'
import { syncStatsByDate } from '../sync/stats'
import { syncProjectionsByDate } from '../sync/projections'
import { generateAllMatchups } from '../sync/matchups'
import { syncScores } from '../sync/scores'
import { syncDynastyRankings } from '../sync/rankings'
import { SyncStatsBody, SyncMatchupsBody } from '../schemas'

export default async function syncRoutes(app: FastifyInstance) {
    app.post('/players', async () => {
        await syncPlayers()
        return { ok: true }
    })

    app.post('/schedule', async () => {
        await syncSchedule()
        return { ok: true }
    })

    app.post('/stats', { schema: { body: SyncStatsBody } }, async (req) => {
        const { days = 1 } = req.body as { days?: number }
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date()
            d.setDate(d.getDate() - i)
            await syncStatsByDate(d)
        }
        return { ok: true }
    })

    app.post('/projections', async () => {
        await syncProjectionsByDate(new Date())
        return { ok: true }
    })

    app.post('/matchups', { schema: { body: SyncMatchupsBody } }, async (req) => {
        const { force = false } = req.body as { force?: boolean }
        await generateAllMatchups(force)
        return { ok: true }
    })

    app.post('/scores', async () => {
        await syncScores()
        return { ok: true }
    })

    app.post('/rankings', async () => {
        await syncDynastyRankings()
        return { ok: true }
    })
}
