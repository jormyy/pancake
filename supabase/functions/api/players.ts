import { json, ValidationError, withCors } from '../_shared/apiRuntime.ts'

const NBA_ID_RE = /^\d{3,10}$/
const HEADSHOT_CACHE_CONTROL = 'public, max-age=604800, stale-while-revalidate=86400'

export async function handlePlayersRoute(req: Request, path: string): Promise<Response | null> {
  const match = path.match(/^\/players\/headshot\/(\d+)$/)
  if (!match) return null
  if (req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405)

  const nbaId = match[1]
  if (!NBA_ID_RE.test(nbaId)) throw new ValidationError('Invalid NBA player id')

  const upstream = await fetch(`https://cdn.nba.com/headshots/nba/latest/260x190/${nbaId}.png`, {
    headers: { 'User-Agent': 'PancakeApp/1.0' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!upstream.ok || !upstream.body) {
    return json({ ok: false, error: 'Headshot not found' }, upstream.status === 404 ? 404 : 502)
  }

  return withCors(new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'image/png',
      'Cache-Control': HEADSHOT_CACHE_CONTROL,
    },
  }))
}
