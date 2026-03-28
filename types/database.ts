// TypeScript types for the Supabase database schema.
// Generated from migrations 001–015.

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export type Database = {
    public: {
        Tables: {
            profiles: {
                Row: {
                    id: string
                    username: string
                    display_name: string | null
                    avatar_url: string | null
                    timezone: string
                    push_token: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id: string
                    username: string
                    display_name?: string | null
                    avatar_url?: string | null
                    timezone?: string
                    push_token?: string | null
                }
                Update: {
                    username?: string
                    display_name?: string | null
                    avatar_url?: string | null
                    timezone?: string
                    push_token?: string | null
                }
                Relationships: []
            }
            leagues: {
                Row: {
                    id: string
                    name: string
                    slug: string
                    invite_code: string | null
                    status: LeagueStatus
                    commissioner_id: string
                    roster_size: number
                    ir_slots: number
                    auction_budget: number
                    scoring_settings: Json
                    playoff_start_week: number
                    trade_deadline: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    name: string
                    slug: string
                    invite_code?: string | null
                    status?: LeagueStatus
                    commissioner_id: string
                    roster_size?: number
                    ir_slots?: number
                    auction_budget?: number
                    scoring_settings?: Json
                    playoff_start_week?: number
                    trade_deadline?: string | null
                }
                Update: {
                    name?: string
                    slug?: string
                    invite_code?: string | null
                    status?: LeagueStatus
                    commissioner_id?: string
                    roster_size?: number
                    ir_slots?: number
                    auction_budget?: number
                    scoring_settings?: Json
                    playoff_start_week?: number
                    trade_deadline?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'leagues_commissioner_id_fkey'
                        columns: ['commissioner_id']
                        referencedRelation: 'profiles'
                        referencedColumns: ['id']
                    },
                ]
            }
            league_seasons: {
                Row: {
                    id: string
                    league_id: string
                    season_year: number
                    is_current: boolean
                    regular_season_start: string | null
                    regular_season_end: string | null
                    nba_trade_deadline: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    season_year: number
                    is_current?: boolean
                    regular_season_start?: string | null
                    regular_season_end?: string | null
                    nba_trade_deadline?: string | null
                }
                Update: {
                    league_id?: string
                    season_year?: number
                    is_current?: boolean
                    regular_season_start?: string | null
                    regular_season_end?: string | null
                    nba_trade_deadline?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'league_seasons_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                ]
            }
            league_members: {
                Row: {
                    id: string
                    league_id: string
                    user_id: string
                    role: LeagueMemberRole
                    team_name: string | null
                    joined_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    user_id: string
                    role?: LeagueMemberRole
                    team_name?: string | null
                }
                Update: {
                    league_id?: string
                    user_id?: string
                    role?: LeagueMemberRole
                    team_name?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'league_members_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'league_members_user_id_fkey'
                        columns: ['user_id']
                        referencedRelation: 'profiles'
                        referencedColumns: ['id']
                    },
                ]
            }
            lineup_slot_templates: {
                Row: {
                    id: string
                    league_id: string
                    slot_type: RosterSlotType
                    slot_count: number
                }
                Insert: {
                    id?: string
                    league_id: string
                    slot_type: RosterSlotType
                    slot_count?: number
                }
                Update: {
                    league_id?: string
                    slot_type?: RosterSlotType
                    slot_count?: number
                }
                Relationships: [
                    {
                        foreignKeyName: 'lineup_slot_templates_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                ]
            }
            players: {
                Row: {
                    id: string
                    sportsdata_id: string
                    first_name: string
                    last_name: string
                    display_name: string
                    nba_team: string | null
                    position: NBAPosition | null
                    jersey_number: string | null
                    status: string | null
                    injury_status: string | null
                    headshot_url: string | null
                    dynasty_rank: number | null
                    sleeper_id: string | null
                    nba_id: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    sportsdata_id: string
                    first_name: string
                    last_name: string
                    nba_team?: string | null
                    position?: NBAPosition | null
                    jersey_number?: string | null
                    status?: string | null
                    injury_status?: string | null
                    headshot_url?: string | null
                    dynasty_rank?: number | null
                    sleeper_id?: string | null
                    nba_id?: string | null
                }
                Update: {
                    sportsdata_id?: string
                    first_name?: string
                    last_name?: string
                    nba_team?: string | null
                    position?: NBAPosition | null
                    jersey_number?: string | null
                    status?: string | null
                    injury_status?: string | null
                    headshot_url?: string | null
                    dynasty_rank?: number | null
                    sleeper_id?: string | null
                    nba_id?: string | null
                }
                Relationships: []
            }
            roster_players: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    is_on_ir: boolean
                    acquired_at: string
                    acquired_via: string
                    acquisition_cost: number | null
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    is_on_ir?: boolean
                    acquired_via: string
                    acquisition_cost?: number | null
                }
                Update: {
                    is_on_ir?: boolean
                    acquired_via?: string
                    acquisition_cost?: number | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'roster_players_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'roster_players_league_season_id_fkey'
                        columns: ['league_season_id']
                        referencedRelation: 'league_seasons'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'roster_players_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'roster_players_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                ]
            }
            weekly_lineups: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    week_number: number
                    game_date: string
                    slot_type: RosterSlotType
                    is_auto_set: boolean
                    set_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    week_number: number
                    game_date: string
                    slot_type: RosterSlotType
                    is_auto_set?: boolean
                    set_at?: string
                }
                Update: {
                    player_id?: string
                    week_number?: number
                    game_date?: string
                    slot_type?: RosterSlotType
                    is_auto_set?: boolean
                    set_at?: string
                }
                Relationships: [
                    {
                        foreignKeyName: 'weekly_lineups_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'weekly_lineups_league_season_id_fkey'
                        columns: ['league_season_id']
                        referencedRelation: 'league_seasons'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'weekly_lineups_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'weekly_lineups_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                ]
            }
            nba_games: {
                Row: {
                    id: string
                    sportsdata_game_id: string
                    nba_game_id: string | null
                    season_year: number
                    game_date: string
                    week_number: number
                    home_team: string
                    away_team: string
                    status: string
                    started_at: string | null
                    ended_at: string | null
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    sportsdata_game_id: string
                    nba_game_id?: string | null
                    season_year: number
                    game_date: string
                    week_number: number
                    home_team: string
                    away_team: string
                    status: string
                    started_at?: string | null
                    ended_at?: string | null
                }
                Update: {
                    sportsdata_game_id?: string
                    nba_game_id?: string | null
                    season_year?: number
                    game_date?: string
                    week_number?: number
                    home_team?: string
                    away_team?: string
                    status?: string
                    started_at?: string | null
                    ended_at?: string | null
                }
                Relationships: []
            }
            season_weeks: {
                Row: {
                    id: string
                    season_year: number
                    week_number: number
                    week_start: string
                    week_end: string
                }
                Insert: {
                    id?: string
                    season_year: number
                    week_number: number
                    week_start: string
                    week_end: string
                }
                Update: {
                    season_year?: number
                    week_number?: number
                    week_start?: string
                    week_end?: string
                }
                Relationships: []
            }
            player_game_stats: {
                Row: {
                    id: string
                    player_id: string
                    game_id: string
                    season_year: number
                    week_number: number
                    minutes_played: number | null
                    points: number | null
                    rebounds: number | null
                    offensive_rebounds: number | null
                    defensive_rebounds: number | null
                    assists: number | null
                    steals: number | null
                    blocks: number | null
                    turnovers: number | null
                    personal_fouls: number | null
                    field_goals_made: number | null
                    field_goals_attempted: number | null
                    three_pointers_made: number | null
                    three_pointers_attempted: number | null
                    free_throws_made: number | null
                    free_throws_attempted: number | null
                    plus_minus: number | null
                    double_double: boolean | null
                    triple_double: boolean | null
                    did_not_play: boolean
                    created_at: string
                    updated_at: string
                }
                Insert: {
                    id?: string
                    player_id: string
                    game_id: string
                    season_year: number
                    week_number: number
                    minutes_played?: number | null
                    points?: number | null
                    rebounds?: number | null
                    offensive_rebounds?: number | null
                    defensive_rebounds?: number | null
                    assists?: number | null
                    steals?: number | null
                    blocks?: number | null
                    turnovers?: number | null
                    personal_fouls?: number | null
                    field_goals_made?: number | null
                    field_goals_attempted?: number | null
                    three_pointers_made?: number | null
                    three_pointers_attempted?: number | null
                    free_throws_made?: number | null
                    free_throws_attempted?: number | null
                    plus_minus?: number | null
                    double_double?: boolean | null
                    triple_double?: boolean | null
                    did_not_play?: boolean
                }
                Update: {
                    minutes_played?: number | null
                    points?: number | null
                    rebounds?: number | null
                    assists?: number | null
                    steals?: number | null
                    blocks?: number | null
                    turnovers?: number | null
                    three_pointers_made?: number | null
                    double_double?: boolean | null
                    triple_double?: boolean | null
                    did_not_play?: boolean
                }
                Relationships: [
                    {
                        foreignKeyName: 'player_game_stats_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'player_game_stats_game_id_fkey'
                        columns: ['game_id']
                        referencedRelation: 'nba_games'
                        referencedColumns: ['id']
                    },
                ]
            }
            player_projections: {
                Row: {
                    id: string
                    player_id: string
                    season_year: number
                    week_number: number
                    projected_points: number | null
                    projected_minutes: number | null
                    fetched_at: string
                }
                Insert: {
                    id?: string
                    player_id: string
                    season_year: number
                    week_number: number
                    projected_points?: number | null
                    projected_minutes?: number | null
                }
                Update: {
                    projected_points?: number | null
                    projected_minutes?: number | null
                    fetched_at?: string
                }
                Relationships: [
                    {
                        foreignKeyName: 'player_projections_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                ]
            }
            matchups: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    week_number: number
                    matchup_type: MatchupType
                    home_member_id: string
                    away_member_id: string
                    home_points: number | null
                    away_points: number | null
                    home_max_possible_points: number | null
                    away_max_possible_points: number | null
                    winner_member_id: string | null
                    is_finalized: boolean
                    finalized_at: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    week_number: number
                    matchup_type?: MatchupType
                    home_member_id: string
                    away_member_id: string
                    home_points?: number | null
                    away_points?: number | null
                    winner_member_id?: string | null
                    is_finalized?: boolean
                }
                Update: {
                    home_points?: number | null
                    away_points?: number | null
                    home_max_possible_points?: number | null
                    away_max_possible_points?: number | null
                    winner_member_id?: string | null
                    is_finalized?: boolean
                    finalized_at?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'matchups_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'matchups_league_season_id_fkey'
                        columns: ['league_season_id']
                        referencedRelation: 'league_seasons'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'matchups_home_member_id_fkey'
                        columns: ['home_member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'matchups_away_member_id_fkey'
                        columns: ['away_member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            standings: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    week_number: number
                    wins: number
                    losses: number
                    ties: number
                    points_for: number
                    points_against: number
                    max_possible_points: number
                    waiver_priority: number
                    created_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    week_number: number
                    wins?: number
                    losses?: number
                    ties?: number
                    points_for?: number
                    points_against?: number
                    max_possible_points?: number
                    waiver_priority: number
                }
                Update: {
                    wins?: number
                    losses?: number
                    ties?: number
                    points_for?: number
                    points_against?: number
                    max_possible_points?: number
                    waiver_priority?: number
                }
                Relationships: [
                    {
                        foreignKeyName: 'standings_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'standings_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            rps_challenges: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_a_id: string
                    member_b_id: string
                    member_a_choice: RpsChoice | null
                    member_b_choice: RpsChoice | null
                    winner_member_id: string | null
                    status: RpsStatus
                    context: string | null
                    created_at: string
                    resolved_at: string | null
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_a_id: string
                    member_b_id: string
                    member_a_choice?: RpsChoice | null
                    member_b_choice?: RpsChoice | null
                    winner_member_id?: string | null
                    status?: RpsStatus
                    context?: string | null
                }
                Update: {
                    member_a_choice?: RpsChoice | null
                    member_b_choice?: RpsChoice | null
                    winner_member_id?: string | null
                    status?: RpsStatus
                    resolved_at?: string | null
                }
                Relationships: []
            }
            drafts: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    draft_type: DraftType
                    status: DraftStatus
                    budget_per_team: number | null
                    current_nomination_order: number
                    scheduled_at: string | null
                    started_at: string | null
                    completed_at: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    draft_type?: DraftType
                    status?: DraftStatus
                    budget_per_team?: number | null
                    current_nomination_order?: number
                    scheduled_at?: string | null
                    started_at?: string | null
                    completed_at?: string | null
                }
                Update: {
                    draft_type?: DraftType
                    status?: DraftStatus
                    budget_per_team?: number | null
                    current_nomination_order?: number
                    scheduled_at?: string | null
                    started_at?: string | null
                    completed_at?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'drafts_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'drafts_league_season_id_fkey'
                        columns: ['league_season_id']
                        referencedRelation: 'league_seasons'
                        referencedColumns: ['id']
                    },
                ]
            }
            draft_orders: {
                Row: {
                    id: string
                    draft_id: string
                    member_id: string
                    position: number
                }
                Insert: {
                    id?: string
                    draft_id: string
                    member_id: string
                    position: number
                }
                Update: {
                    draft_id?: string
                    member_id?: string
                    position?: number
                }
                Relationships: [
                    {
                        foreignKeyName: 'draft_orders_draft_id_fkey'
                        columns: ['draft_id']
                        referencedRelation: 'drafts'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'draft_orders_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            draft_budgets: {
                Row: {
                    id: string
                    draft_id: string
                    member_id: string
                    initial_budget: number
                    remaining: number
                }
                Insert: {
                    id?: string
                    draft_id: string
                    member_id: string
                    initial_budget: number
                    remaining: number
                }
                Update: {
                    initial_budget?: number
                    remaining?: number
                }
                Relationships: [
                    {
                        foreignKeyName: 'draft_budgets_draft_id_fkey'
                        columns: ['draft_id']
                        referencedRelation: 'drafts'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'draft_budgets_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            nominations: {
                Row: {
                    id: string
                    draft_id: string
                    nominating_member_id: string
                    player_id: string
                    nomination_order: number
                    status: NominationStatus
                    current_bid_amount: number
                    current_bidder_id: string | null
                    countdown_expires_at: string | null
                    winning_member_id: string | null
                    final_price: number | null
                    nominated_at: string
                    closed_at: string | null
                }
                Insert: {
                    id?: string
                    draft_id: string
                    nominating_member_id: string
                    player_id: string
                    nomination_order: number
                    status?: NominationStatus
                    current_bid_amount?: number
                    current_bidder_id?: string | null
                    countdown_expires_at?: string | null
                    winning_member_id?: string | null
                    final_price?: number | null
                }
                Update: {
                    status?: NominationStatus
                    current_bid_amount?: number
                    current_bidder_id?: string | null
                    countdown_expires_at?: string | null
                    winning_member_id?: string | null
                    final_price?: number | null
                    closed_at?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'nominations_draft_id_fkey'
                        columns: ['draft_id']
                        referencedRelation: 'drafts'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'nominations_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'nominations_nominating_member_id_fkey'
                        columns: ['nominating_member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            bids: {
                Row: {
                    id: string
                    nomination_id: string
                    member_id: string
                    amount: number
                    placed_at: string
                }
                Insert: {
                    id?: string
                    nomination_id: string
                    member_id: string
                    amount: number
                }
                Update: {
                    amount?: number
                }
                Relationships: [
                    {
                        foreignKeyName: 'bids_nomination_id_fkey'
                        columns: ['nomination_id']
                        referencedRelation: 'nominations'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'bids_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            snake_draft_picks: {
                Row: {
                    id: string
                    draft_id: string
                    overall_pick: number
                    round: number
                    pick_in_round: number
                    member_id: string
                    player_id: string | null
                    picked_at: string | null
                }
                Insert: {
                    id?: string
                    draft_id: string
                    overall_pick: number
                    round: number
                    pick_in_round: number
                    member_id: string
                    player_id?: string | null
                }
                Update: {
                    player_id?: string | null
                    picked_at?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'snake_draft_picks_draft_id_fkey'
                        columns: ['draft_id']
                        referencedRelation: 'drafts'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'snake_draft_picks_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'snake_draft_picks_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                ]
            }
            draft_picks: {
                Row: {
                    id: string
                    league_id: string
                    season_year: number
                    round: number
                    original_owner_id: string
                    current_owner_id: string
                    is_used: boolean
                    used_at: string | null
                    rookie_draft_id: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    season_year: number
                    round: number
                    original_owner_id: string
                    current_owner_id: string
                    is_used?: boolean
                    used_at?: string | null
                    rookie_draft_id?: string | null
                }
                Update: {
                    current_owner_id?: string
                    is_used?: boolean
                    used_at?: string | null
                    rookie_draft_id?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'draft_picks_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'draft_picks_original_owner_id_fkey'
                        columns: ['original_owner_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'draft_picks_current_owner_id_fkey'
                        columns: ['current_owner_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            waiver_priorities: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    priority: number
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    priority: number
                }
                Update: {
                    priority?: number
                }
                Relationships: [
                    {
                        foreignKeyName: 'waiver_priorities_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'waiver_priorities_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            waiver_claims: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    drop_player_id: string | null
                    priority_at_submission: number
                    status: WaiverClaimStatus
                    submitted_at: string
                    process_date: string
                    processed_at: string | null
                    failure_reason: string | null
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    drop_player_id?: string | null
                    priority_at_submission: number
                    status?: WaiverClaimStatus
                    process_date: string
                    failure_reason?: string | null
                }
                Update: {
                    status?: WaiverClaimStatus
                    processed_at?: string | null
                    failure_reason?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'waiver_claims_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'waiver_claims_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            waiver_wire_log: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    player_id: string
                    dropped_by_member_id: string | null
                    placed_on_waivers_at: string
                    clears_at: string
                    cleared_at: string | null
                    claimed_by_claim_id: string | null
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    player_id: string
                    dropped_by_member_id?: string | null
                    clears_at: string
                    cleared_at?: string | null
                    claimed_by_claim_id?: string | null
                }
                Update: {
                    cleared_at?: string | null
                    claimed_by_claim_id?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'waiver_wire_log_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'waiver_wire_log_claimed_by_claim_id_fkey'
                        columns: ['claimed_by_claim_id']
                        referencedRelation: 'waiver_claims'
                        referencedColumns: ['id']
                    },
                ]
            }
            trades: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    proposer_member_id: string
                    recipient_member_id: string
                    status: TradeStatus
                    notes: string | null
                    proposed_at: string
                    accepted_at: string | null
                    veto_window_expires_at: string | null
                    completed_at: string | null
                    vetoed_at: string | null
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    proposer_member_id: string
                    recipient_member_id: string
                    status?: TradeStatus
                    notes?: string | null
                }
                Update: {
                    status?: TradeStatus
                    notes?: string | null
                    accepted_at?: string | null
                    veto_window_expires_at?: string | null
                    completed_at?: string | null
                    vetoed_at?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'trades_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'trades_proposer_member_id_fkey'
                        columns: ['proposer_member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'trades_recipient_member_id_fkey'
                        columns: ['recipient_member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            trade_items: {
                Row: {
                    id: string
                    trade_id: string
                    side: TradeSide
                    player_id: string | null
                    pick_id: string | null
                    created_at: string
                }
                Insert: {
                    id?: string
                    trade_id: string
                    side: TradeSide
                    player_id?: string | null
                    pick_id?: string | null
                }
                Update: {
                    side?: TradeSide
                    player_id?: string | null
                    pick_id?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'trade_items_trade_id_fkey'
                        columns: ['trade_id']
                        referencedRelation: 'trades'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'trade_items_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'trade_items_pick_id_fkey'
                        columns: ['pick_id']
                        referencedRelation: 'draft_picks'
                        referencedColumns: ['id']
                    },
                ]
            }
            trade_vetos: {
                Row: {
                    id: string
                    trade_id: string
                    member_id: string
                    veto_type: VetoType
                    vetoed_at: string
                }
                Insert: {
                    id?: string
                    trade_id: string
                    member_id: string
                    veto_type: VetoType
                }
                Update: {
                    veto_type?: VetoType
                }
                Relationships: [
                    {
                        foreignKeyName: 'trade_vetos_trade_id_fkey'
                        columns: ['trade_id']
                        referencedRelation: 'trades'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'trade_vetos_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                ]
            }
            roster_transactions: {
                Row: {
                    id: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    transaction_type: string
                    related_trade_id: string | null
                    related_claim_id: string | null
                    related_nomination_id: string | null
                    occurred_at: string
                }
                Insert: {
                    id?: string
                    league_id: string
                    league_season_id: string
                    member_id: string
                    player_id: string
                    transaction_type: string
                    related_trade_id?: string | null
                    related_claim_id?: string | null
                    related_nomination_id?: string | null
                }
                Update: {
                    transaction_type?: string
                    related_trade_id?: string | null
                    related_claim_id?: string | null
                    related_nomination_id?: string | null
                }
                Relationships: [
                    {
                        foreignKeyName: 'roster_transactions_league_id_fkey'
                        columns: ['league_id']
                        referencedRelation: 'leagues'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'roster_transactions_member_id_fkey'
                        columns: ['member_id']
                        referencedRelation: 'league_members'
                        referencedColumns: ['id']
                    },
                    {
                        foreignKeyName: 'roster_transactions_player_id_fkey'
                        columns: ['player_id']
                        referencedRelation: 'players'
                        referencedColumns: ['id']
                    },
                ]
            }
        }
        Views: Record<string, never>
        Functions: Record<string, never>
        Enums: {
            league_status: LeagueStatus
            league_member_role: LeagueMemberRole
            draft_type: DraftType
            draft_status: DraftStatus
            nomination_status: NominationStatus
            roster_slot_type: RosterSlotType
            nba_position: NBAPosition
            waiver_claim_status: WaiverClaimStatus
            trade_status: TradeStatus
            trade_side: TradeSide
            veto_type: VetoType
            matchup_type: MatchupType
            rps_choice: RpsChoice
            rps_status: RpsStatus
        }
        CompositeTypes: Record<string, never>
    }
}

// Enum types
export type LeagueStatus = 'setup' | 'drafting' | 'active' | 'playoffs' | 'offseason' | 'archived'
export type LeagueMemberRole = 'commissioner' | 'co_commissioner' | 'manager'
export type DraftType = 'auction' | 'snake'
export type DraftStatus = 'pending' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
export type NominationStatus = 'open' | 'sold' | 'no_bid'
export type RosterSlotType = 'PG' | 'SG' | 'SF' | 'PF' | 'C' | 'G' | 'F' | 'UTIL' | 'BE' | 'IR'
export type NBAPosition = 'PG' | 'SG' | 'SF' | 'PF' | 'C' | 'G' | 'F'
export type WaiverClaimStatus = 'pending' | 'succeeded' | 'failed_priority' | 'failed_roster' | 'cancelled'
export type TradeStatus = 'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'vetoed' | 'completed' | 'expired'
export type TradeSide = 'proposer' | 'recipient'
export type VetoType = 'commissioner' | 'member'
export type MatchupType = 'regular_season' | 'playoff_quarterfinal' | 'playoff_semifinal' | 'playoff_final'
export type RpsChoice = 'rock' | 'paper' | 'scissors'
export type RpsStatus = 'pending' | 'completed'

// Convenience row types
export type Profile = Database['public']['Tables']['profiles']['Row']
export type League = Database['public']['Tables']['leagues']['Row']
export type LeagueMember = Database['public']['Tables']['league_members']['Row']
export type LeagueSeason = Database['public']['Tables']['league_seasons']['Row']
export type Player = Database['public']['Tables']['players']['Row']
export type RosterPlayer = Database['public']['Tables']['roster_players']['Row']
export type WeeklyLineup = Database['public']['Tables']['weekly_lineups']['Row']
export type NbaGame = Database['public']['Tables']['nba_games']['Row']
export type SeasonWeek = Database['public']['Tables']['season_weeks']['Row']
export type PlayerGameStats = Database['public']['Tables']['player_game_stats']['Row']
export type PlayerProjection = Database['public']['Tables']['player_projections']['Row']
export type Matchup = Database['public']['Tables']['matchups']['Row']
export type Standing = Database['public']['Tables']['standings']['Row']
export type Draft = Database['public']['Tables']['drafts']['Row']
export type DraftOrder = Database['public']['Tables']['draft_orders']['Row']
export type DraftBudget = Database['public']['Tables']['draft_budgets']['Row']
export type Nomination = Database['public']['Tables']['nominations']['Row']
export type Bid = Database['public']['Tables']['bids']['Row']
export type SnakeDraftPick = Database['public']['Tables']['snake_draft_picks']['Row']
export type DraftPick = Database['public']['Tables']['draft_picks']['Row']
export type WaiverPriority = Database['public']['Tables']['waiver_priorities']['Row']
export type WaiverClaim = Database['public']['Tables']['waiver_claims']['Row']
export type WaiverWireLog = Database['public']['Tables']['waiver_wire_log']['Row']
export type Trade = Database['public']['Tables']['trades']['Row']
export type TradeItem = Database['public']['Tables']['trade_items']['Row']
export type TradeVeto = Database['public']['Tables']['trade_vetos']['Row']
export type RosterTransaction = Database['public']['Tables']['roster_transactions']['Row']
