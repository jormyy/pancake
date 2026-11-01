import { createSnapshotSource } from './snapshot.ts'
import type { LiveSnapshot } from '../../core/src/live/overlay.ts'

const cachePolicy = 'public, max-age=0, s-maxage=30, stale-while-revalidate=15, stale-if-error=90'

function offSwitch() {
  const runtime = globalThis as typeof globalThis & { process?: { env: Record<string,string | undefined> }; Deno?: { env: { get(name: string): string | undefined } } }
  return (runtime.Deno?.env.get('LIVE_SCORES_OFF') ?? runtime.process?.env.LIVE_SCORES_OFF) === '1'
}

export function createLiveHandler(options: { now?: () => number; disabled?: () => boolean; source?: (date: string) => Promise<LiveSnapshot> } = {}) {
  const now = options.now ?? Date.now
  const disabled = options.disabled ?? offSwitch
  const source = options.source ?? createSnapshotSource(now)
  const lastGood = new Map<string, { body: string; capturedAt: number }>()
  const inFlight = new Map<string,Promise<LiveSnapshot>>()
  return async (request: Request): Promise<Response> => {
    const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' }
    if (!['GET','HEAD'].includes(request.method)) return new Response(null,{status:405,headers:{...headers,allow:'GET, HEAD','cache-control':'no-store'}})
    const url = new URL(request.url)
    const date = url.searchParams.get('date') ?? url.pathname.split('/').at(-1) ?? ''
    const day = new Date(now()).toLocaleDateString('en-CA',{timeZone:'America/New_York'})
    const previous = new Date(Date.parse(`${day}T12:00:00Z`)-86400000).toISOString().slice(0,10)
    for (const key of lastGood.keys()) if (key !== day && key !== previous) lastGood.delete(key)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || ![day,previous].includes(date)
      || [...url.searchParams.keys()].some(key => key !== 'date')) return Response.json({error:'Date is outside the live window'},{status:400,headers:{...headers,'cache-control':'no-store'}})
    try {
      let snapshot: LiveSnapshot
      if (disabled()) {
        lastGood.clear()
        snapshot = { version:1,mode:'database',date,capturedAt:now(),games:[] }
      }
      else {
        let pending = inFlight.get(date)
        if (!pending) {
          pending = source(date).finally(() => { inFlight.delete(date) })
          inFlight.set(date,pending)
        }
        snapshot = await pending
      }
      const body = JSON.stringify(snapshot)
      if (new TextEncoder().encode(body).length > 1000000) throw new Error('Live snapshot exceeds the payload budget')
      if (snapshot.mode === 'public') lastGood.set(date,{ body, capturedAt: snapshot.capturedAt })
      return new Response(request.method === 'HEAD' ? null : body,{headers:{...headers,'cache-control':cachePolicy}})
    } catch {
      const saved = lastGood.get(date)
      const remaining = saved ? 120000 - (now() - saved.capturedAt) : 0
      if (saved && remaining > 0 && remaining <= 120000) return new Response(request.method === 'HEAD' ? null : saved.body, {
        headers: { ...headers, 'cache-control': `public, max-age=0, s-maxage=${Math.min(30,Math.ceil(remaining/1000))}`, 'x-live-snapshot-fallback': '1' },
      })
      return Response.json({error:'Live scores are temporarily unavailable'},{status:503,headers:{...headers,'cache-control':'no-store'}})
    }
  }
}
