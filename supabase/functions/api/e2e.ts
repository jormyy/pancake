import {
  assertUuid,
  invokeInternalFunction,
  json,
  optionalStringField,
  readJsonObject,
  requireE2eSecret,
  uuidField,
} from '../_shared/apiRuntime.ts'
import { autoPickBest, startRookieDraft } from './draft.ts'
import { advanceSeason } from './league.ts'
import { generateAllMatchups } from './matchups.ts'

function parseDateBody(body: Record<string, unknown>): Record<string, unknown> {
  const date = optionalStringField(body, 'date')
  const leagueId = optionalStringField(body, 'leagueId')
  return {
    ...(date ? { date } : {}),
    ...(leagueId ? { leagueId } : {}),
  }
}

export async function handleE2eRoute(req: Request, path: string): Promise<Response | null> {
  if (!path.startsWith('/e2e')) return null
  requireE2eSecret(req)

  if (req.method === 'GET' && path === '/e2e/status') {
    return json({
      ok: true,
      nbaCdnBaseUrl: Deno.env.get('NBA_CDN_BASE_URL') ?? null,
      sleeperBaseUrl: Deno.env.get('SLEEPER_BASE_URL') ?? null,
      expoPushUrl: Deno.env.get('EXPO_PUSH_URL') ?? null,
      runtime: 'supabase-edge',
    })
  }

  if (req.method !== 'POST') return null
  const body = await readJsonObject(req)

  if (path === '/e2e/sync-schedule') return json(await invokeInternalFunction('sync-schedule'))
  if (path === '/e2e/sync-players') return json(await invokeInternalFunction('sync-players'))
  if (path === '/e2e/sync-stats') return json(await invokeInternalFunction('sync-stats', parseDateBody(body)))
  if (path === '/e2e/sync-scores') return json(await invokeInternalFunction('sync-scores', parseDateBody(body)))
  if (path === '/e2e/live-poll') {
    const target = parseDateBody(body)
    if (target.date) await invokeInternalFunction('sync-stats', target)
    return json(await invokeInternalFunction('sync-scores', target))
  }
  if (path === '/e2e/process-waivers') return json(await invokeInternalFunction('process-waivers'))
  if (path === '/e2e/process-trades') return json(await invokeInternalFunction('process-trades'))
  if (path === '/e2e/close-expired-nominations') {
    return json(await invokeInternalFunction('close-expired-nominations'))
  }
  if (path === '/e2e/generate-matchups') {
    const leagueId = typeof body.leagueId === 'string' ? uuidField(body, 'leagueId') : undefined
    await generateAllMatchups(Boolean(body.force), leagueId)
    return json({ ok: true })
  }
  if (path === '/e2e/advance-season') {
    return json({ ok: true, ...await advanceSeason(uuidField(body, 'leagueId')) })
  }
  if (path === '/e2e/start-rookie-draft') {
    return json({ ok: true, draft: await startRookieDraft(uuidField(body, 'leagueId')) })
  }

  const autoPickMatch = path.match(/^\/e2e\/([^/]+)\/auto-pick$/)
  if (autoPickMatch) {
    assertUuid(autoPickMatch[1], 'draftId')
    return json({ ok: true, ...await autoPickBest(autoPickMatch[1], uuidField(body, 'memberId')) })
  }

  return null
}
