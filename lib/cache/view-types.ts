import type { NBAGameRow } from '@/lib/games'
import type { ViewContext } from '@/lib/cache/screen-cache'
import type { RosterPlayer, OwnedEntry, PlayerRosterStatus, RosterOccupancy } from '@/lib/roster'
import type { RosterAverage } from '@/lib/roster-stats'
import type { TradePickItem, Trade, TradePageCursor, TradeBlockItem } from '@/lib/trades'
import type { WaiverClaim } from '@/lib/waivers'
import type { MemberTransactionState } from '@/lib/league'
import type { RosterSlotPlan, LineupSlot, LineupPlayer, WeekDay } from '@/lib/lineup'
import type { Matchup, LeagueWeekMatchup } from '@/lib/scoring'
import type { PlayerRow, PlayerDetailRow, PlayerSeasonAverages, TransactionHistoryEntry, VisiblePlayerTotals } from '@/lib/players'
import type { PlayerSeasonLine, PlayerGame } from '@/components/player/season-data'
import type { LeagueProjectionRow } from '@/lib/projections'

export type RosterView = { context: ViewContext; roster: RosterPlayer[]; picks: TradePickItem[]; claims: WaiverClaim[]; avgMap: Record<string, number>; avgStatsMap: Record<string, RosterAverage>; waiverPriority: number | null; faabBalance: number | null; slotPlan: { slots: RosterSlotPlan['slots']; assignments: Record<string, string> }; transactionState: MemberTransactionState; taxiExitPlayerIds: string[] }
export function rosterViewData(view: RosterView) {
    return { ...view, avgMap: new Map(Object.entries(view.avgMap)), avgStatsMap: new Map(Object.entries(view.avgStatsMap)) }
}
export type PlayersView = { context: ViewContext; players: PlayerRow[]; ownedMap: Record<string, OwnedEntry>; waiverClearsAt: Record<string, string>; waiverIds: string[]; pendingClaimIds: string[]; transactionState: MemberTransactionState; visibleTotals: VisiblePlayerTotals[]; hasMore: boolean; claims: WaiverClaim[] }
export function playerSupportData(view: PlayersView) {
    return { leagueId: view.context.leagueId, memberId: view.context.memberId, seasonId: view.context.seasonId, day: view.context.today, ownedMap: new Map(Object.entries(view.ownedMap)), waiverClearsAt: new Map(Object.entries(view.waiverClearsAt)), waiverIds: new Set(view.waiverIds), pendingClaimIds: new Set(view.pendingClaimIds), transactionState: view.transactionState }
}
export type LineupView = { context: ViewContext; date: string; starters: LineupSlot[]; bench: LineupPlayer[]; benchSlots: number; ir: LineupPlayer[]; taxi: LineupPlayer[]; weekDays: WeekDay[]; optimizer: { enabled?: boolean } | null; games: NBAGameRow[]; startedTeams: string[]; teamMatchups: Record<string, { opponent: string; isHome: boolean }> }
export type HomeView = { context: ViewContext; matchup: Matchup | null; myLineup: Pick<LineupView, 'starters' | 'bench' | 'benchSlots' | 'ir' | 'taxi'> | null; oppLineup: Pick<LineupView, 'starters' | 'bench' | 'benchSlots' | 'ir' | 'taxi'> | null; weekDays: WeekDay[]; leagueMatchups: LeagueWeekMatchup[]; selectedDate: string }
export type TradesView = { context: ViewContext; trades: Trade[]; hasMore: boolean; nextCursor: TradePageCursor | null; pendingIncomingCount: number }
export type TradeBlockView = RosterView & { items: TradeBlockItem[]; block: TradeBlockItem[] }
export type ClaimEditorView = { context: ViewContext; player: PlayerDetailRow; roster: RosterPlayer[]; claims: WaiverClaim[]; priority: number | null; clearsAt: string | null; transactionState: MemberTransactionState; members: { id: string; user_id: string }[]; taxiExitIds: string[] }
export type PlayerView = { pickup?: PlayerPickup; context: ViewContext; player: PlayerDetailRow; availableSeasons: number[]; selectedSeason: number; averages: PlayerSeasonAverages | null; avgFantasyPoints: number | null; lines: PlayerSeasonLine[]; gameLog: PlayerGame[]; hasMoreGames: boolean; includesLive: boolean; liveGame: PlayerGame | null; fantasyPointsMap: Record<string, number>; nextProjection: LeagueProjectionRow | null; transactions: TransactionHistoryEntry[]; scoringSettings: unknown; roster: RosterView }

type PlayerPickup = { status: PlayerRosterStatus; transactionState: MemberTransactionState | null; claimPending: boolean; roster: RosterOccupancy[] }
export type PlayerSection = 'games' | 'news' | 'history'
export type PlayerSectionView = { context: ViewContext; lines?: PlayerSeasonLine[]; transactions?: TransactionHistoryEntry[]; hasMoreGames?: boolean; news?: { id: string; title: string; summary: string; source: string; url: string | null; published_at: string }[] }
