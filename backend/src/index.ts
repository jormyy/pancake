import 'dotenv/config'
import Fastify from 'fastify'
import cron from 'node-cron'
import { syncPlayers } from './sync/players'
import { syncSchedule } from './sync/games'
import { syncStatsByDate, syncStatsRange } from './sync/stats'
import { syncProjectionsByDate } from './sync/projections'
import { generateAllMatchups } from './sync/matchups'
import { syncScores } from './sync/scores'
import { syncDynastyRankings } from './sync/rankings'
import {
  startDraft,
  nominatePlayer,
  placeBid,
  getDraftState,
  closeExpiredNominations,
} from './sync/draft'
import { processWaiverClaims } from './sync/waivers'
import { generateSemifinals, advanceToFinal } from './sync/playoffs'
import { notifyMember } from './lib/notifications'
import { formatDate } from './lib/sportsdata'

process.on('uncaughtException', (err) => console.error('[crash] uncaughtException:', err))
process.on('unhandledRejection', (err) => console.error('[crash] unhandledRejection:', err))

// Validate required env vars
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[startup] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    process.exit(1)
}
console.log('[startup] Env vars OK — starting server')

const app = Fastify({ logger: true })

// ── Health check ──────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok' }))

// ── Manual sync routes ────────────────────────────────────────

app.post('/sync/players', async (_req, reply) => {
  try { await syncPlayers(); return { ok: true } }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/sync/schedule', async (_req, reply) => {
  try { await syncSchedule(); return { ok: true } }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/sync/stats', async (req: any, reply) => {
  try {
    const days = req.body?.days ?? 1
    if (days > 1) {
      await syncStatsRange(days)
    } else {
      await syncStatsByDate(new Date())
    }
    return { ok: true }
  }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/sync/projections', async (_req, reply) => {
  try { await syncProjectionsByDate(new Date()); return { ok: true } }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/sync/matchups', async (req: any, reply) => {
  try {
    const force = req.body?.force === true
    await generateAllMatchups(force)
    return { ok: true }
  }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/sync/scores', async (_req, reply) => {
  try { await syncScores(); return { ok: true } }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/sync/rankings', async (_req, reply) => {
  try { await syncDynastyRankings(); return { ok: true } }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/waivers/process', async (_req, reply) => {
  try { await processWaiverClaims(); return { ok: true } }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/playoffs/generate', async (req: any, reply) => {
  try {
    const { leagueId } = req.body as { leagueId: string }
    if (!leagueId) { reply.status(400); return { ok: false, error: 'leagueId required' } }
    await generateSemifinals(leagueId)
    return { ok: true }
  }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

// Client-triggered trade notifications
app.post('/notify/trade', async (req: any, reply) => {
  try {
    const { memberId, title, body } = req.body as { memberId: string; title: string; body: string }
    if (!memberId || !title || !body) { reply.status(400); return { ok: false, error: 'memberId, title, body required' } }
    await notifyMember(memberId, title, body)
    return { ok: true }
  }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

app.post('/playoffs/advance', async (req: any, reply) => {
  try {
    const { leagueId } = req.body as { leagueId: string }
    if (!leagueId) { reply.status(400); return { ok: false, error: 'leagueId required' } }
    await advanceToFinal(leagueId)
    return { ok: true }
  }
  catch (e: any) { reply.status(500); return { ok: false, error: e.message } }
})

// ── Draft routes ──────────────────────────────────────────────

function errMsg(e: any): string {
  return e?.message || e?.details || JSON.stringify(e) || 'Unknown error'
}

app.post('/draft/start', async (req: any, reply) => {
  try {
    const { leagueId } = req.body as { leagueId: string }
    if (!leagueId) { reply.status(400); return { ok: false, error: 'leagueId required' } }
    const draft = await startDraft(leagueId)
    return { ok: true, draft }
  } catch (e: any) {
    console.error('[draft/start]', e)
    reply.status(500)
    return { ok: false, error: errMsg(e) }
  }
})

app.get('/draft/:draftId', async (req: any, reply) => {
  try {
    const { draftId } = req.params as { draftId: string }
    const state = await getDraftState(draftId)
    return { ok: true, ...state }
  } catch (e: any) {
    reply.status(500); return { ok: false, error: errMsg(e) }
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
    reply.status(400); return { ok: false, error: errMsg(e) }
  }
})

app.post('/draft/:draftId/bid', async (req: any, reply) => {
  try {
    const { draftId } = req.params as { draftId: string }
    const { memberId, nominationId, amount } = req.body as { memberId: string; nominationId: string; amount: number }
    if (!memberId || !nominationId || amount == null) { reply.status(400); return { ok: false, error: 'memberId, nominationId, and amount required' } }
    return await placeBid(draftId, memberId, nominationId, amount)
  } catch (e: any) {
    reply.status(400); return { ok: false, error: errMsg(e) }
  }
})

// ── Cron jobs ─────────────────────────────────────────────────

cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Running daily player sync...')
  await syncPlayers().catch(console.error)
}, { timezone: 'America/New_York' })

cron.schedule('0 6 * * *', async () => {
  console.log('[cron] Running daily schedule sync...')
  await syncSchedule().catch(console.error)
}, { timezone: 'America/New_York' })

cron.schedule('0 12-23,0 * * *', async () => {
  console.log('[cron] Running stats sync...')
  await syncStatsByDate(new Date()).catch(console.error)
}, { timezone: 'America/New_York' })

cron.schedule('0 8 * * *', async () => {
  console.log('[cron] Running projections sync...')
  await syncProjectionsByDate(new Date()).catch(console.error)
}, { timezone: 'America/New_York' })

cron.schedule('*/15 12-23,0 * * *', async () => {
  console.log('[cron] Running score sync...')
  await syncScores().catch(console.error)
}, { timezone: 'America/New_York' })

cron.schedule('0 7 * * 1', async () => {
  console.log('[cron] Running dynasty rankings sync...')
  await syncDynastyRankings().catch(console.error)
}, { timezone: 'America/New_York' })

cron.schedule('0 3 * * *', async () => {
  console.log('[cron] Processing waiver claims...')
  await processWaiverClaims().catch(console.error)
}, { timezone: 'America/New_York' })

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
