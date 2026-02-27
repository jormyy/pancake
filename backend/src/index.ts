import 'dotenv/config'
import Fastify from 'fastify'
import cron from 'node-cron'
import { syncPlayers } from './sync/players'
import { syncSchedule } from './sync/games'
import { syncStatsByDate } from './sync/stats'
import { syncProjectionsByDate } from './sync/projections'
import { generateAllMatchups } from './sync/matchups'
import { syncScores } from './sync/scores'
import { syncDynastyRankings } from './sync/rankings'
import { startDraft, nominatePlayer, placeBid, getDraftState, closeExpiredNominations } from './sync/draft'
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

app.post('/sync/rankings', async (_req, reply) => {
  try {
    await syncDynastyRankings()
    return { ok: true }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

// ── Draft routes ───────────────────────────────────────────────

app.post('/draft/start', async (req: any, reply) => {
  try {
    const { leagueId } = req.body as { leagueId: string }
    if (!leagueId) { reply.status(400); return { ok: false, error: 'leagueId required' } }
    const draft = await startDraft(leagueId)
    return { ok: true, draft }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.get('/draft/:draftId', async (req: any, reply) => {
  try {
    const { draftId } = req.params as { draftId: string }
    const state = await getDraftState(draftId)
    return { ok: true, ...state }
  } catch (e: any) {
    reply.status(500)
    return { ok: false, error: e.message }
  }
})

app.post('/draft/:draftId/nominate', async (req: any, reply) => {
  try {
    const { draftId } = req.params as { draftId: string }
    const { memberId, playerId } = req.body as { memberId: string; playerId: string }
    if (!memberId || !playerId) { reply.status(400); return { ok: false, error: 'memberId and playerId required' } }
    const nomination = await nominatePlayer(draftId, memberId, playerId)
    return { ok: true, nomination }
  } catch (e: any) {
    reply.status(400)
    return { ok: false, error: e.message }
  }
})

app.post('/draft/:draftId/bid', async (req: any, reply) => {
  try {
    const { draftId } = req.params as { draftId: string }
    const { memberId, nominationId, amount } = req.body as { memberId: string; nominationId: string; amount: number }
    if (!memberId || !nominationId || amount == null) { reply.status(400); return { ok: false, error: 'memberId, nominationId, and amount required' } }
    const result = await placeBid(draftId, memberId, nominationId, amount)
    return result
  } catch (e: any) {
    reply.status(400)
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

// Dynasty rankings: every Monday at 7 AM ET
cron.schedule('0 7 * * 1', async () => {
  console.log('[cron] Running dynasty rankings sync...')
  await syncDynastyRankings().catch(console.error)
}, { timezone: 'America/New_York' })

// Draft: check for expired nominations every 10 seconds
setInterval(async () => {
  await closeExpiredNominations().catch(console.error)
}, 10_000)

// ── Start ─────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? '3000')

app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
  if (err) {
    app.log.error(err)
    process.exit(1)
  }
  console.log(`Backend running on port ${PORT}`)
})
