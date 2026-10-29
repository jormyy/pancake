import assert from 'node:assert/strict'
import { appendFile } from './bounded-log.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

export function waiverDiagnostics(file, execute) {
  const snapshot = async (body, requestId) => {
    for (const value of [body.leagueId, body.memberId, body.playerId, requestId]) assert.match(value, uuid)
    return JSON.parse(await execute(`SELECT jsonb_build_object(
      'league',(SELECT jsonb_build_object('id',id,'waiverMode',waiver_mode,'startingBudget',faab_starting_budget) FROM public.leagues WHERE id='${body.leagueId}'),
      'member',(SELECT jsonb_build_object('id',id,'userId',user_id) FROM public.league_members WHERE id='${body.memberId}'),
      'balances',(SELECT coalesce(jsonb_agg(jsonb_build_object('seasonId',b.league_season_id,'balance',b.balance,'current',s.is_current)),'[]') FROM public.faab_balances b JOIN public.league_seasons s ON s.id=b.league_season_id WHERE b.league_id='${body.leagueId}' AND b.member_id='${body.memberId}'),
      'claims',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'bid',bid_amount,'status',status,'seasonId',league_season_id)),'[]') FROM public.waiver_claims WHERE league_id='${body.leagueId}' AND member_id='${body.memberId}' AND player_id='${body.playerId}'),
      'receipt',(SELECT jsonb_build_object('requestId',request_id,'actor',actor,'function',function,'inputHash',input_hash,'result',result) FROM private.request_receipts WHERE request_id='${requestId}')
    )`))
  }
  return {
    before: async request => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/functions/v1/api/waivers/claims') return null
      const input = await request.json()
      const body = Object.fromEntries(['leagueId', 'memberId', 'playerId', 'dropPlayerId', 'bidAmount', 'requestId'].filter(key => key in input).map(key => [key, input[key]]))
      const requestId = request.headers.get('x-request-id')
      return { body, requestId, before: await snapshot(body, requestId) }
    },
    after: async (_request, response, context) => {
      if (!context) return
      const row = { ...context, status: response.status, response: await response.json(), after: await snapshot(context.body, context.requestId) }
      await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    },
  }
}
