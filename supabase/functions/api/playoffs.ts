import { supabase } from '../_shared/supabase.ts'
import {
  json,
  readJsonObject,
  requireCommissioner,
  requireUser,
  throwDb,
  uuidField,
} from '../_shared/apiRuntime.ts'

async function generatePlayoffBracket(leagueId: string): Promise<void> {
  const { error } = await supabase.rpc('generate_playoff_bracket_atomic', {
    p_league_id: leagueId,
  })
  if (error) throwDb(error)
}

async function advancePlayoffBracket(leagueId: string): Promise<void> {
  const { error } = await supabase.rpc('advance_playoff_bracket_atomic', {
    p_league_id: leagueId,
  })
  if (error) throwDb(error)
}

export async function handlePlayoffRoute(req: Request, path: string): Promise<Response | null> {
  if (req.method !== 'POST') return null
  if (path !== '/playoffs/generate' && path !== '/playoffs/advance') return null

  const userId = await requireUser(req)
  const body = await readJsonObject(req)
  const leagueId = uuidField(body, 'leagueId')
  await requireCommissioner(userId, leagueId)

  if (path === '/playoffs/generate') await generatePlayoffBracket(leagueId)
  else await advancePlayoffBracket(leagueId)

  return json({ ok: true })
}
