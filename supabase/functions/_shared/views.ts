import { createClient } from 'npm:@supabase/supabase-js@2.98.0'
import type { Database, Json } from './database.ts'
import { requiredSecretKey } from './supabase.ts'
import { workFetch } from './workContext.ts'
import { assertUuid, ValidationError } from './apiRuntime.ts'

export const screenViews = {
  home: 'view_home',
  roster: 'view_roster',
  players: 'view_players',
  player: 'view_player',
  trades: 'view_trades',
  'trade-block': 'view_trade_block',
  'trade-details': 'view_trade_details',
  'trade-analysis': 'view_trade_analysis',
  league: 'view_league',
  standings: 'view_standings',
  activity: 'view_activity',
  picks: 'view_picks',
  settings: 'view_settings',
  lineup: 'view_lineup',
  'claim-editor': 'view_claim_editor',
  'draft-rooms': 'view_draft_rooms',
  'draft-room': 'view_draft_room',
  profile: 'view_profile',
} as const

export type ScreenView = keyof typeof screenViews

export function viewRequest(url: URL, screen: ScreenView) {
  const leagueId = url.searchParams.get('leagueId')
  const memberId = url.searchParams.get('memberId')
  if (screen !== 'profile' || leagueId !== null) {
    assertUuid(leagueId ?? '', 'leagueId')
    assertUuid(memberId ?? '', 'memberId')
  }
  let params: Json
  try {
    params = JSON.parse(url.searchParams.get('params') ?? '{}')
  } catch {
    throw new ValidationError('params must be a JSON object')
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new ValidationError('params must be a JSON object')
  if (JSON.stringify(params).length > 32000) throw new ValidationError('params is too large')
  return { p_league_id: leagueId!, p_member_id: memberId!, p_params: params }
}

export function viewClient(request: Request) {
  return createClient<Database>(Deno.env.get('SUPABASE_URL')!, requiredSecretKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: request.headers.get('authorization')! }, fetch: workFetch },
  })
}
