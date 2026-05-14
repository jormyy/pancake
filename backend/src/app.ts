import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import errorHandlerPlugin from './plugins/errorHandler'
import authPlugin from './plugins/auth'
import healthRoutes from './routes/health'
import syncRoutes from './routes/sync'
import draftRoutes from './routes/draft'
import waiverRoutes from './routes/waivers'
import playoffRoutes from './routes/playoffs'
import notifyRoutes from './routes/notifications'
import leagueRoutes from './routes/league'
import gamesRoutes from './routes/games'
import tradeRoutes from './routes/trades'
import e2eRoutes from './routes/e2e'

export async function buildApp() {
    const app = Fastify({ logger: true })

    await app.register(cors, { origin: true })
    await app.register(rateLimit, {
        max: process.env.ENABLE_E2E_ROUTES === '1' ? 10000 : 100,
        timeWindow: '1 minute',
        skipOnError: true,
        allowList: (req) => (
            process.env.ENABLE_E2E_ROUTES === '1' &&
            Boolean(process.env.E2E_ADMIN_SECRET) &&
            req.url.startsWith('/e2e/')
        ),
    })
    await app.register(errorHandlerPlugin)
    await authPlugin(app)

    await app.register(healthRoutes)
    await app.register(syncRoutes, { prefix: '/sync' })
    await app.register(draftRoutes, { prefix: '/draft' })
    await app.register(waiverRoutes, { prefix: '/waivers' })
    await app.register(playoffRoutes, { prefix: '/playoffs' })
    await app.register(notifyRoutes, { prefix: '/notify' })
    await app.register(leagueRoutes, { prefix: '/league' })
    await app.register(gamesRoutes, { prefix: '/games' })
    await app.register(tradeRoutes, { prefix: '/trades' })
    if (process.env.ENABLE_E2E_ROUTES === '1' && process.env.E2E_ADMIN_SECRET) {
        await app.register(e2eRoutes, { prefix: '/e2e' })
    }

    return app
}
