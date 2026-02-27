import 'dotenv/config'
import Fastify from 'fastify'
import cron from 'node-cron'
import { syncPlayers } from './sync/players'
import { syncSchedule } from './sync/games'
import { syncStatsByDate } from './sync/stats'
import { syncProjectionsByDate } from './sync/projections'
import { generateAllMatchups } from './sync/matchups'
import { syncScores } from './sync/scores'
import { formatDate } from './lib/sportsdata'

const app = Fastify({ logger: true })

// ── Health check ──────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok' }))

// ── Manual sync routes (also called by cron) ─────────────────

app.post('/sync/players', async (_req, reply) => {
  try {
    await syncPlayers()
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.post('/sync/schedule', async (_req, reply) => {
  try {
    await syncSchedule()
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.post('/sync/stats', async (_req, reply) => {
  try {
    await syncStatsByDate(new Date())
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.post('/sync/projections', async (_req, reply) => {
  try {
    await syncProjectionsByDate(new Date())
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.post('/sync/matchups', async (_req, reply) => {
  try {
    await generateAllMatchups()
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.post('/sync/scores', async (_req, reply) => {
  try {
    await syncScores()
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

// ── Cron jobs ─────────────────────────────────────────────────

// Players: once daily at 6 AM ET
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Running daily player sync...')
  await syncPlayers().catch(console.error)
}, { timezone: 'America/New_York' })

// Schedule: once daily at 6 AM ET
cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Running daily schedule sync...')
  await syncSchedule().catch(console.error)
}, { timezone: 'America/New_York' })

// Stats: every hour during game hours (12 PM – 1 AM ET)
cron.schedule('0 12-23,0 * * *', async () => {
  console.log('[cron] Running stats sync...')
  await syncStatsByDate(new Date()).catch(console.error)
}, { timezone: 'America/New_York' })

// Projections: every morning at 8 AM ET
cron.schedule('0 8 * * *', async () => {
  console.log('[cron] Running projections sync...')
  await syncProjectionsByDate(new Date()).catch(console.error)
}, { timezone: 'America/New_York' })

// Scores: every 15 minutes during game hours (12 PM – 1 AM ET)
cron.schedule('*/15 12-23,0 * * *', async () => {
  console.log('[cron] Running score sync...')
  await syncScores().catch(console.error)
}, { timezone: 'America/New_York' })

// ── Start ─────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000')

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  console.log(`Backend running on port ${PORT}`)
})
