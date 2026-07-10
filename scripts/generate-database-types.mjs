import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const target = 'types/database.ts'
const aliases = `
export type LeagueStatus = Database["public"]["Enums"]["league_status"]
export type LeagueMemberRole = Database["public"]["Enums"]["league_member_role"]
export type DraftType = Database["public"]["Enums"]["draft_type"]
export type DraftStatus = Database["public"]["Enums"]["draft_status"]
export type NominationStatus = Database["public"]["Enums"]["nomination_status"]
export type RosterSlotType = Database["public"]["Enums"]["roster_slot_type"]
export type NBAPosition = Database["public"]["Enums"]["nba_position"]
export type WaiverClaimStatus = Database["public"]["Enums"]["waiver_claim_status"]
export type TradeStatus = Database["public"]["Enums"]["trade_status"]
export type TradeSide = Database["public"]["Enums"]["trade_side"]
export type VetoType = Database["public"]["Enums"]["veto_type"]
export type MatchupType = Database["public"]["Enums"]["matchup_type"]
export type RpsChoice = Database["public"]["Enums"]["rps_choice"]
export type RpsStatus = Database["public"]["Enums"]["rps_status"]

export type Profile = Database["public"]["Tables"]["profiles"]["Row"]
export type League = Database["public"]["Tables"]["leagues"]["Row"]
export type LeagueMember = Database["public"]["Tables"]["league_members"]["Row"]
export type LeagueSeason = Database["public"]["Tables"]["league_seasons"]["Row"]
export type Player = Database["public"]["Tables"]["players"]["Row"]
export type RosterPlayer = Database["public"]["Tables"]["roster_players"]["Row"]
export type WeeklyLineup = Database["public"]["Tables"]["weekly_lineups"]["Row"]
export type PlayerGameStats = Database["public"]["Tables"]["player_game_stats"]["Row"]
export type Matchup = Database["public"]["Tables"]["matchups"]["Row"]
export type Draft = Database["public"]["Tables"]["drafts"]["Row"]
export type DraftPick = Database["public"]["Tables"]["draft_picks"]["Row"]
`

const generated = execFileSync('supabase', ['gen', 'types', 'typescript', '--local'], { encoding: 'utf8' })
const contents = generated
  .replaceAll('p_free_action: string\n', 'p_free_action: string | null\n')
  .replaceAll('p_free_roster_player_id: string\n', 'p_free_roster_player_id: string | null\n')
  .replaceAll(
    'p_slot_type?: Database["public"]["Enums"]["roster_slot_type"]\n',
    'p_slot_type?: Database["public"]["Enums"]["roster_slot_type"] | null\n',
  )
  .trimEnd() + `\n\n${aliases.trim()}\n`

if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== contents) {
    console.error(`${target} is stale; run npm run generate:database-types`)
    process.exitCode = 1
  }
} else {
  writeFileSync(target, contents)
}
