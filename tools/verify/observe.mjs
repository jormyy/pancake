#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { requireLocal } from './run.mjs'

const dir = path.resolve(process.argv[2])
const run = JSON.parse(await readFile(path.join(dir, 'run.json'), 'utf8'))
assert.equal(run.dir, dir)
assert.ok(!run.cleanedAt, 'Observe before cleanup')
const env = JSON.parse(await readFile(path.join(dir, 'local-env.json'), 'utf8'))
const fixture = JSON.parse(await readFile(path.join(dir, 'fixture.json'), 'utf8'))
requireLocal(env.E2E_SUPABASE_URL)
const client = createClient(env.E2E_SUPABASE_URL, env.E2E_PANCAKE_SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
const selects = {
  leagues: 'id,name,status,taxi_slots',
  league_seasons: 'id,league_id,season_year,is_current',
  league_members: 'id,team_name',
  roster_players: 'id,league_season_id,member_id,player_id,is_on_ir,is_on_taxi',
  roster_transactions: 'league_season_id,member_id,player_id,transaction_type,occurred_at',
  weekly_lineups: 'league_season_id,member_id,player_id,game_date,slot_type,is_auto_set',
  lineup_player_pins: 'member_id,player_id,game_date,pin',
  lineup_optimizer_settings: 'member_id,enabled',
  matchups: 'league_season_id,week_number,matchup_type,home_member_id,away_member_id,home_points,away_points,winner_member_id,is_finalized',
  standings: 'league_season_id,member_id,week_number,wins,losses,ties,points_for,points_against',
  waiver_claims: 'id,member_id,player_id,bid_amount,status',
  trades: 'id,proposer_member_id,recipient_member_id,status,is_multi_team,accepted_at,completed_at,veto_window_expires_at,completion_failure_reason',
  trade_participants: 'trade_id,member_id,sort_order,accepted_at,drop_player_ids,taxi_player_ids,ir_player_ids,roster_moves',
  trade_items: 'trade_id,player_id,pick_id,faab_amount,from_member_id,to_member_id',
  trade_block_items: 'id,member_id,player_id',
  draft_picks: 'id,season_year,round,current_owner_id,original_owner_id',
  drafts: 'id,league_season_id,status,draft_type,is_mock,room_name,pick_timer_seconds,paused_at,timer_paused_remaining_seconds',
}
const result = { observedAt: new Date().toISOString(), fixture }
for (const [table, columns] of Object.entries(selects)) {
  const { data, error } = await client.from(table).select(columns).eq(table === 'leagues' ? 'id' : 'league_id', fixture.leagueId)
  if (error) throw new Error(`${table}: ${error.message}`)
  result[table] = data
}
for (const table of ['draft_budgets', 'draft_room_members', 'nominations']) {
  const { data, error } = await client.from(table).select('*').in('draft_id', result.drafts.map(draft => draft.id))
  if (error) throw new Error(`${table}: ${error.message}`)
  result[table] = data
}
const { data: bids, error: bidsError } = await client.from('bids').select('*').in('nomination_id', result.nominations.map(nomination => nomination.id))
if (bidsError) throw new Error(`bids: ${bidsError.message}`)
result.bids = bids
if (fixture.playerGames?.length) {
  const { data, error } = await client.from('player_game_stats').select('id,player_id,game_id,season_year,points,rebounds,assists,minutes_played').in('game_id', fixture.playerGames.map(game => game.id))
  if (error) throw new Error(`player_game_stats: ${error.message}`)
  result.player_game_stats = data
}
console.log(JSON.stringify(result, null, 2))
