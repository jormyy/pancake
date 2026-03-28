import Fastify from 'fastify'
import errorHandlerPlugin from './plugins/errorHandler'
import authPlugin from './plugins/auth'
import healthRoutes from './routes/health'
import syncRoutes from './routes/sync'
import draftRoutes from './routes/draft'
import waiverRoutes from './routes/waivers'
import playoffRoutes from './routes/playoffs'
import notifyRoutes from './routes/notifications'
import leagueRoutes from './routes/league'

export async function buildApp() {
    const app = Fastify({ logger: true })

    await app.register(errorHandlerPlugin)
    await app.register(authPlugin)

    await app.register(healthRoutes)
    await app.register(syncRoutes, { prefix: '/sync' })
    await app.register(draftRoutes, { prefix: '/draft' })
    await app.register(waiverRoutes, { prefix: '/waivers' })
    await app.register(playoffRoutes, { prefix: '/playoffs' })
    await app.register(notifyRoutes, { prefix: '/notify' })
    await app.register(leagueRoutes, { prefix: '/league' })

    return app
}
