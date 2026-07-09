import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../../types/database'

export type E2EEnvironment = {
    supabaseUrl: string
    serviceRoleKey: string
    anonKey: string
    apiBaseUrl?: string
    frontendUrl?: string
}

export type FixtureUser = {
    id: string
    email: string
    password: string
    username: string
    displayName: string
    teamName: string
}

export type FixtureMember = { id: string; user_id: string; team_name: string | null }
export type FixturePlayer = { id: string; display_name: string; position: string | null; nba_team: string | null }
export type FixturePick = {
    id: string
    seasonYear: number
    round: number
    originalOwnerId: string
    currentOwnerId: string
    originalTeamName: string
}

export type TradeGameplayFixture = {
    admin: SupabaseClient<Database>
    runId: string
    password: string
    users: FixtureUser[]
    league: { id: string; invite_code: string }
    currentSeason: { id: string; season_year: number }
    proposer: FixtureMember
    recipient: FixtureMember
    observer: FixtureMember | null
    proposerPlayer: FixturePlayer
    recipientPlayer: FixturePlayer
    targetFuturePickYear: number
    proposerFuturePick: FixturePick | null
    recipientFuturePick: FixturePick | null
    dispose: () => Promise<void>
}

export type FixtureResourceOwner = {
    registerLeague(id: string): void
    registerUser(id: string): void
    dispose(): Promise<void>
}

export function findAvailablePlayers(
    admin: SupabaseClient<Database>,
    leagueId: string,
    leagueSeasonId: string,
    count: number,
): Promise<FixturePlayer[]>

export function createFixtureResourceOwner(admin: SupabaseClient<Database>): FixtureResourceOwner

export function setupTradeGameplayFixture(
    env: E2EEnvironment,
    season: number,
    options?: { memberCount?: number; includeFuturePicks?: boolean },
): Promise<TradeGameplayFixture>

export function setupMultiTeamTradeGameplayFixture(env: E2EEnvironment, season: number): Promise<
    TradeGameplayFixture & { observer: FixtureMember; observerPlayer: FixturePlayer }
>
