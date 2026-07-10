export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      backfill_game_attempts: {
        Row: {
          attempts: number
          created_at: string
          game_db_id: string | null
          game_key: string
          id: string
          job_id: string
          last_error: string | null
          season_year: number
          source: string
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          game_db_id?: string | null
          game_key: string
          id?: string
          job_id: string
          last_error?: string | null
          season_year: number
          source: string
          status: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          game_db_id?: string | null
          game_key?: string
          id?: string
          job_id?: string
          last_error?: string | null
          season_year?: number
          source?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "backfill_game_attempts_game_db_id_fkey"
            columns: ["game_db_id"]
            isOneToOne: false
            referencedRelation: "nba_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backfill_game_attempts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "sync_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      bids: {
        Row: {
          amount: number
          id: string
          league_id: string | null
          member_id: string
          nomination_id: string
          placed_at: string
        }
        Insert: {
          amount: number
          id?: string
          league_id?: string | null
          member_id: string
          nomination_id: string
          placed_at?: string
        }
        Update: {
          amount?: number
          id?: string
          league_id?: string | null
          member_id?: string
          nomination_id?: string
          placed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bids_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bids_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "bids_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bids_nomination_id_fkey"
            columns: ["nomination_id"]
            isOneToOne: false
            referencedRelation: "nominations"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          draft_id: string
          id: string
          league_id: string
          metadata: Json
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          draft_id: string
          id?: string
          league_id: string
          metadata?: Json
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          draft_id?: string
          id?: string
          league_id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "draft_audit_logs_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_audit_logs_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_audit_logs_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
        ]
      }
      draft_budgets: {
        Row: {
          draft_id: string
          id: string
          initial_budget: number
          member_id: string
          remaining: number
        }
        Insert: {
          draft_id: string
          id?: string
          initial_budget: number
          member_id: string
          remaining: number
        }
        Update: {
          draft_id?: string
          id?: string
          initial_budget?: number
          member_id?: string
          remaining?: number
        }
        Relationships: [
          {
            foreignKeyName: "draft_budgets_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_budgets_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_orders: {
        Row: {
          draft_id: string
          id: string
          member_id: string
          position: number
        }
        Insert: {
          draft_id: string
          id?: string
          member_id: string
          position: number
        }
        Update: {
          draft_id?: string
          id?: string
          member_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "draft_orders_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_orders_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_picks: {
        Row: {
          created_at: string
          current_owner_id: string
          id: string
          is_used: boolean
          league_id: string
          original_owner_id: string
          rookie_draft_id: string | null
          round: number
          season_year: number
          used_at: string | null
        }
        Insert: {
          created_at?: string
          current_owner_id: string
          id?: string
          is_used?: boolean
          league_id: string
          original_owner_id: string
          rookie_draft_id?: string | null
          round: number
          season_year: number
          used_at?: string | null
        }
        Update: {
          created_at?: string
          current_owner_id?: string
          id?: string
          is_used?: boolean
          league_id?: string
          original_owner_id?: string
          rookie_draft_id?: string | null
          round?: number
          season_year?: number
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "draft_picks_current_owner_id_fkey"
            columns: ["current_owner_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_picks_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_picks_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "draft_picks_original_owner_id_fkey"
            columns: ["original_owner_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_picks_rookie_draft_id_fkey"
            columns: ["rookie_draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
        ]
      }
      draft_room_members: {
        Row: {
          draft_id: string
          joined_at: string
          member_id: string
        }
        Insert: {
          draft_id: string
          joined_at?: string
          member_id: string
        }
        Update: {
          draft_id?: string
          joined_at?: string
          member_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "draft_room_members_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "draft_room_members_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      drafts: {
        Row: {
          budget_per_team: number | null
          completed_at: string | null
          created_at: string
          created_by_member_id: string | null
          current_nomination_order: number
          draft_type: Database["public"]["Enums"]["draft_type"]
          id: string
          is_mock: boolean
          league_id: string
          league_season_id: string
          nomination_order_mode: string
          pause_reason: string | null
          paused_at: string | null
          pick_timer_seconds: number
          room_name: string | null
          rounds: number | null
          scheduled_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["draft_status"]
          timer_expiry_behavior: string
          timer_paused_remaining_seconds: number | null
        }
        Insert: {
          budget_per_team?: number | null
          completed_at?: string | null
          created_at?: string
          created_by_member_id?: string | null
          current_nomination_order?: number
          draft_type?: Database["public"]["Enums"]["draft_type"]
          id?: string
          is_mock?: boolean
          league_id: string
          league_season_id: string
          nomination_order_mode?: string
          pause_reason?: string | null
          paused_at?: string | null
          pick_timer_seconds?: number
          room_name?: string | null
          rounds?: number | null
          scheduled_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["draft_status"]
          timer_expiry_behavior?: string
          timer_paused_remaining_seconds?: number | null
        }
        Update: {
          budget_per_team?: number | null
          completed_at?: string | null
          created_at?: string
          created_by_member_id?: string | null
          current_nomination_order?: number
          draft_type?: Database["public"]["Enums"]["draft_type"]
          id?: string
          is_mock?: boolean
          league_id?: string
          league_season_id?: string
          nomination_order_mode?: string
          pause_reason?: string | null
          paused_at?: string | null
          pick_timer_seconds?: number
          room_name?: string | null
          rounds?: number | null
          scheduled_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["draft_status"]
          timer_expiry_behavior?: string
          timer_paused_remaining_seconds?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "drafts_created_by_member_id_fkey"
            columns: ["created_by_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "drafts_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      dynasty_news: {
        Row: {
          created_at: string
          id: string
          player_id: string | null
          published_at: string
          source: string
          summary: string
          title: string
          url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          player_id?: string | null
          published_at?: string
          source: string
          summary: string
          title: string
          url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          player_id?: string | null
          published_at?: string
          source?: string
          summary?: string
          title?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dynasty_news_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      dynasty_rankings: {
        Row: {
          age: number | null
          assists: number | null
          blocks: number | null
          comment: string | null
          created_at: string
          fetched_at: string
          field_goal_pct: number | null
          free_throw_pct: number | null
          games_played: number | null
          id: string
          player_id: string | null
          points: number | null
          rank_change: number
          rebounds: number | null
          scoring_format: string
          source: string
          source_metadata: Json
          source_player_id: string | null
          source_player_name: string
          source_positions: string[]
          source_rank: number
          source_team: string | null
          source_url: string | null
          steals: number | null
          three_pointers_made: number | null
          turnovers: number | null
          updated_at: string
        }
        Insert: {
          age?: number | null
          assists?: number | null
          blocks?: number | null
          comment?: string | null
          created_at?: string
          fetched_at?: string
          field_goal_pct?: number | null
          free_throw_pct?: number | null
          games_played?: number | null
          id?: string
          player_id?: string | null
          points?: number | null
          rank_change?: number
          rebounds?: number | null
          scoring_format?: string
          source: string
          source_metadata?: Json
          source_player_id?: string | null
          source_player_name: string
          source_positions?: string[]
          source_rank: number
          source_team?: string | null
          source_url?: string | null
          steals?: number | null
          three_pointers_made?: number | null
          turnovers?: number | null
          updated_at?: string
        }
        Update: {
          age?: number | null
          assists?: number | null
          blocks?: number | null
          comment?: string | null
          created_at?: string
          fetched_at?: string
          field_goal_pct?: number | null
          free_throw_pct?: number | null
          games_played?: number | null
          id?: string
          player_id?: string | null
          points?: number | null
          rank_change?: number
          rebounds?: number | null
          scoring_format?: string
          source?: string
          source_metadata?: Json
          source_player_id?: string | null
          source_player_name?: string
          source_positions?: string[]
          source_rank?: number
          source_team?: string | null
          source_url?: string | null
          steals?: number | null
          three_pointers_made?: number | null
          turnovers?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "dynasty_rankings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      faab_balances: {
        Row: {
          balance: number
          id: string
          league_id: string
          league_season_id: string
          member_id: string
          updated_at: string
        }
        Insert: {
          balance: number
          id?: string
          league_id: string
          league_season_id: string
          member_id: string
          updated_at?: string
        }
        Update: {
          balance?: number
          id?: string
          league_id?: string
          league_season_id?: string
          member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "faab_balances_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faab_balances_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "faab_balances_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "faab_balances_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      fantasypros_projection_rows: {
        Row: {
          assists: number | null
          blocks: number | null
          created_at: string
          fetched_at: string
          field_goal_pct: number | null
          free_throw_pct: number | null
          games_played: number | null
          id: string
          match_reason: string | null
          match_status: string
          minutes: number | null
          normalized_player_name: string
          player_id: string | null
          points: number | null
          projection_date: string | null
          projection_type: string
          raw_player_cell: string | null
          raw_stats: Json
          rebounds: number | null
          run_id: string
          season_year: number | null
          source_opponent: string | null
          source_player_name: string
          source_positions: string[]
          source_row_number: number
          source_status: string | null
          source_team: string | null
          source_url: string
          steals: number | null
          three_pointers_made: number | null
          turnovers: number | null
          week_number: number | null
        }
        Insert: {
          assists?: number | null
          blocks?: number | null
          created_at?: string
          fetched_at: string
          field_goal_pct?: number | null
          free_throw_pct?: number | null
          games_played?: number | null
          id?: string
          match_reason?: string | null
          match_status: string
          minutes?: number | null
          normalized_player_name: string
          player_id?: string | null
          points?: number | null
          projection_date?: string | null
          projection_type: string
          raw_player_cell?: string | null
          raw_stats?: Json
          rebounds?: number | null
          run_id: string
          season_year?: number | null
          source_opponent?: string | null
          source_player_name: string
          source_positions?: string[]
          source_row_number: number
          source_status?: string | null
          source_team?: string | null
          source_url: string
          steals?: number | null
          three_pointers_made?: number | null
          turnovers?: number | null
          week_number?: number | null
        }
        Update: {
          assists?: number | null
          blocks?: number | null
          created_at?: string
          fetched_at?: string
          field_goal_pct?: number | null
          free_throw_pct?: number | null
          games_played?: number | null
          id?: string
          match_reason?: string | null
          match_status?: string
          minutes?: number | null
          normalized_player_name?: string
          player_id?: string | null
          points?: number | null
          projection_date?: string | null
          projection_type?: string
          raw_player_cell?: string | null
          raw_stats?: Json
          rebounds?: number | null
          run_id?: string
          season_year?: number | null
          source_opponent?: string | null
          source_player_name?: string
          source_positions?: string[]
          source_row_number?: number
          source_status?: string | null
          source_team?: string | null
          source_url?: string
          steals?: number | null
          three_pointers_made?: number | null
          turnovers?: number | null
          week_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fantasypros_projection_rows_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fantasypros_projection_rows_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "projection_sync_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      league_activity: {
        Row: {
          actor_member_id: string | null
          body: string | null
          created_at: string
          event_type: string
          id: string
          league_id: string
          league_season_id: string | null
          metadata: Json
          related_claim_id: string | null
          related_player_id: string | null
          related_trade_id: string | null
          target_member_id: string | null
          title: string
        }
        Insert: {
          actor_member_id?: string | null
          body?: string | null
          created_at?: string
          event_type: string
          id?: string
          league_id: string
          league_season_id?: string | null
          metadata?: Json
          related_claim_id?: string | null
          related_player_id?: string | null
          related_trade_id?: string | null
          target_member_id?: string | null
          title: string
        }
        Update: {
          actor_member_id?: string | null
          body?: string | null
          created_at?: string
          event_type?: string
          id?: string
          league_id?: string
          league_season_id?: string | null
          metadata?: Json
          related_claim_id?: string | null
          related_player_id?: string | null
          related_trade_id?: string | null
          target_member_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_activity_actor_member_id_fkey"
            columns: ["actor_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_activity_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_activity_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "league_activity_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_activity_related_claim_id_fkey"
            columns: ["related_claim_id"]
            isOneToOne: false
            referencedRelation: "waiver_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_activity_related_player_id_fkey"
            columns: ["related_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_activity_related_trade_id_fkey"
            columns: ["related_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_activity_target_member_id_fkey"
            columns: ["target_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      league_audit_logs: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          league_id: string
          metadata: Json
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          league_id: string
          metadata?: Json
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          league_id?: string
          metadata?: Json
        }
        Relationships: [
          {
            foreignKeyName: "league_audit_logs_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_audit_logs_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_audit_logs_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
        ]
      }
      league_members: {
        Row: {
          id: string
          joined_at: string
          league_id: string
          role: Database["public"]["Enums"]["league_member_role"]
          team_name: string | null
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string
          league_id: string
          role?: Database["public"]["Enums"]["league_member_role"]
          team_name?: string | null
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string
          league_id?: string
          role?: Database["public"]["Enums"]["league_member_role"]
          team_name?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "league_members_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_members_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "league_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      league_seasons: {
        Row: {
          created_at: string
          id: string
          is_current: boolean
          league_id: string
          nba_trade_deadline: string | null
          regular_season_end: string | null
          regular_season_start: string | null
          season_year: number
        }
        Insert: {
          created_at?: string
          id?: string
          is_current?: boolean
          league_id: string
          nba_trade_deadline?: string | null
          regular_season_end?: string | null
          regular_season_start?: string | null
          season_year: number
        }
        Update: {
          created_at?: string
          id?: string
          is_current?: boolean
          league_id?: string
          nba_trade_deadline?: string | null
          regular_season_end?: string | null
          regular_season_start?: string | null
          season_year?: number
        }
        Relationships: [
          {
            foreignKeyName: "league_seasons_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "league_seasons_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
        ]
      }
      leagues: {
        Row: {
          auction_budget: number
          commissioner_id: string
          created_at: string
          deleted_at: string | null
          deleted_by: string | null
          faab_starting_budget: number
          id: string
          invite_code: string | null
          ir_slots: number
          name: string
          playoff_start_week: number
          roster_size: number
          scoring_settings: Json
          slug: string
          status: Database["public"]["Enums"]["league_status"]
          taxi_slots: number
          trade_deadline: string | null
          trade_veto_mode: string
          trade_veto_threshold_percent: number
          trade_veto_window_hours: number
          updated_at: string
          waiver_mode: string
          weekly_add_limit: number | null
        }
        Insert: {
          auction_budget?: number
          commissioner_id: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          faab_starting_budget?: number
          id?: string
          invite_code?: string | null
          ir_slots?: number
          name: string
          playoff_start_week?: number
          roster_size?: number
          scoring_settings?: Json
          slug: string
          status?: Database["public"]["Enums"]["league_status"]
          taxi_slots?: number
          trade_deadline?: string | null
          trade_veto_mode?: string
          trade_veto_threshold_percent?: number
          trade_veto_window_hours?: number
          updated_at?: string
          waiver_mode?: string
          weekly_add_limit?: number | null
        }
        Update: {
          auction_budget?: number
          commissioner_id?: string
          created_at?: string
          deleted_at?: string | null
          deleted_by?: string | null
          faab_starting_budget?: number
          id?: string
          invite_code?: string | null
          ir_slots?: number
          name?: string
          playoff_start_week?: number
          roster_size?: number
          scoring_settings?: Json
          slug?: string
          status?: Database["public"]["Enums"]["league_status"]
          taxi_slots?: number
          trade_deadline?: string | null
          trade_veto_mode?: string
          trade_veto_threshold_percent?: number
          trade_veto_window_hours?: number
          updated_at?: string
          waiver_mode?: string
          weekly_add_limit?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "leagues_commissioner_id_fkey"
            columns: ["commissioner_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leagues_deleted_by_fkey"
            columns: ["deleted_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      lineup_optimizer_settings: {
        Row: {
          created_at: string
          enabled: boolean
          enabled_at: string | null
          last_optimized_at: string | null
          league_id: string
          league_season_id: string
          member_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          enabled_at?: string | null
          last_optimized_at?: string | null
          league_id: string
          league_season_id: string
          member_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          enabled_at?: string | null
          last_optimized_at?: string | null
          league_id?: string
          league_season_id?: string
          member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lineup_optimizer_settings_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lineup_optimizer_settings_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "lineup_optimizer_settings_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lineup_optimizer_settings_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      lineup_slot_templates: {
        Row: {
          id: string
          league_id: string
          slot_count: number
          slot_type: Database["public"]["Enums"]["roster_slot_type"]
        }
        Insert: {
          id?: string
          league_id: string
          slot_count?: number
          slot_type: Database["public"]["Enums"]["roster_slot_type"]
        }
        Update: {
          id?: string
          league_id?: string
          slot_count?: number
          slot_type?: Database["public"]["Enums"]["roster_slot_type"]
        }
        Relationships: [
          {
            foreignKeyName: "lineup_slot_templates_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lineup_slot_templates_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
        ]
      }
      live_poll_leases: {
        Row: {
          acquired_at: string
          expires_at: string
          holder_id: string
          lock_key: number
        }
        Insert: {
          acquired_at?: string
          expires_at: string
          holder_id: string
          lock_key: number
        }
        Update: {
          acquired_at?: string
          expires_at?: string
          holder_id?: string
          lock_key?: number
        }
        Relationships: []
      }
      matchups: {
        Row: {
          away_max_possible_points: number | null
          away_member_id: string
          away_points: number | null
          created_at: string
          finalized_at: string | null
          home_max_possible_points: number | null
          home_member_id: string
          home_points: number | null
          id: string
          is_finalized: boolean
          league_id: string
          league_season_id: string
          matchup_type: Database["public"]["Enums"]["matchup_type"]
          week_number: number
          winner_member_id: string | null
        }
        Insert: {
          away_max_possible_points?: number | null
          away_member_id: string
          away_points?: number | null
          created_at?: string
          finalized_at?: string | null
          home_max_possible_points?: number | null
          home_member_id: string
          home_points?: number | null
          id?: string
          is_finalized?: boolean
          league_id: string
          league_season_id: string
          matchup_type?: Database["public"]["Enums"]["matchup_type"]
          week_number: number
          winner_member_id?: string | null
        }
        Update: {
          away_max_possible_points?: number | null
          away_member_id?: string
          away_points?: number | null
          created_at?: string
          finalized_at?: string | null
          home_max_possible_points?: number | null
          home_member_id?: string
          home_points?: number | null
          id?: string
          is_finalized?: boolean
          league_id?: string
          league_season_id?: string
          matchup_type?: Database["public"]["Enums"]["matchup_type"]
          week_number?: number
          winner_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matchups_away_member_id_fkey"
            columns: ["away_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_home_member_id_fkey"
            columns: ["home_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "matchups_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_winner_member_id_fkey"
            columns: ["winner_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      nba_games: {
        Row: {
          away_score: number
          away_team: string
          bbref_away_team: string | null
          bbref_home_team: string | null
          created_at: string
          ended_at: string | null
          game_date: string
          game_status_text: string | null
          game_time: string | null
          home_score: number
          home_team: string
          id: string
          nba_game_id: string | null
          season_year: number
          sportsdata_game_id: string | null
          started_at: string | null
          status: string
          updated_at: string
          week_number: number
        }
        Insert: {
          away_score?: number
          away_team: string
          bbref_away_team?: string | null
          bbref_home_team?: string | null
          created_at?: string
          ended_at?: string | null
          game_date: string
          game_status_text?: string | null
          game_time?: string | null
          home_score?: number
          home_team: string
          id?: string
          nba_game_id?: string | null
          season_year: number
          sportsdata_game_id?: string | null
          started_at?: string | null
          status: string
          updated_at?: string
          week_number: number
        }
        Update: {
          away_score?: number
          away_team?: string
          bbref_away_team?: string | null
          bbref_home_team?: string | null
          created_at?: string
          ended_at?: string | null
          game_date?: string
          game_status_text?: string | null
          game_time?: string | null
          home_score?: number
          home_team?: string
          id?: string
          nba_game_id?: string | null
          season_year?: number
          sportsdata_game_id?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
          week_number?: number
        }
        Relationships: []
      }
      nominations: {
        Row: {
          closed_at: string | null
          countdown_expires_at: string | null
          current_bid_amount: number
          current_bidder_id: string | null
          draft_id: string
          final_price: number | null
          id: string
          nominated_at: string
          nominating_member_id: string
          nomination_order: number
          player_id: string
          status: Database["public"]["Enums"]["nomination_status"]
          winning_member_id: string | null
        }
        Insert: {
          closed_at?: string | null
          countdown_expires_at?: string | null
          current_bid_amount?: number
          current_bidder_id?: string | null
          draft_id: string
          final_price?: number | null
          id?: string
          nominated_at?: string
          nominating_member_id: string
          nomination_order: number
          player_id: string
          status?: Database["public"]["Enums"]["nomination_status"]
          winning_member_id?: string | null
        }
        Update: {
          closed_at?: string | null
          countdown_expires_at?: string | null
          current_bid_amount?: number
          current_bidder_id?: string | null
          draft_id?: string
          final_price?: number | null
          id?: string
          nominated_at?: string
          nominating_member_id?: string
          nomination_order?: number
          player_id?: string
          status?: Database["public"]["Enums"]["nomination_status"]
          winning_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nominations_current_bidder_id_fkey"
            columns: ["current_bidder_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nominations_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nominations_nominating_member_id_fkey"
            columns: ["nominating_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nominations_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nominations_winning_member_id_fkey"
            columns: ["winning_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_outbox: {
        Row: {
          attempt_count: number
          available_at: string
          body: string
          category: string
          claim_token: string | null
          claimed_at: string | null
          created_at: string
          data: Json
          dead_lettered_at: string | null
          dedupe_key: string
          delivered_at: string | null
          event_type: string
          expo_ticket_id: string | null
          id: string
          last_error: string | null
          member_id: string
          push_token: string | null
          receipt_attempt_count: number
          ticketed_at: string | null
          title: string
        }
        Insert: {
          attempt_count?: number
          available_at?: string
          body: string
          category: string
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          data?: Json
          dead_lettered_at?: string | null
          dedupe_key: string
          delivered_at?: string | null
          event_type: string
          expo_ticket_id?: string | null
          id?: string
          last_error?: string | null
          member_id: string
          push_token?: string | null
          receipt_attempt_count?: number
          ticketed_at?: string | null
          title: string
        }
        Update: {
          attempt_count?: number
          available_at?: string
          body?: string
          category?: string
          claim_token?: string | null
          claimed_at?: string | null
          created_at?: string
          data?: Json
          dead_lettered_at?: string | null
          dedupe_key?: string
          delivered_at?: string | null
          event_type?: string
          expo_ticket_id?: string | null
          id?: string
          last_error?: string | null
          member_id?: string
          push_token?: string | null
          receipt_attempt_count?: number
          ticketed_at?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_outbox_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          activity_enabled: boolean
          draft_enabled: boolean
          trade_enabled: boolean
          updated_at: string
          user_id: string
          waiver_enabled: boolean
        }
        Insert: {
          activity_enabled?: boolean
          draft_enabled?: boolean
          trade_enabled?: boolean
          updated_at?: string
          user_id: string
          waiver_enabled?: boolean
        }
        Update: {
          activity_enabled?: boolean
          draft_enabled?: boolean
          trade_enabled?: boolean
          updated_at?: string
          user_id?: string
          waiver_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "notification_preferences_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      player_game_stats: {
        Row: {
          assists: number | null
          blocks: number | null
          created_at: string
          defensive_rebounds: number | null
          did_not_play: boolean
          double_double: boolean | null
          field_goals_attempted: number | null
          field_goals_made: number | null
          free_throws_attempted: number | null
          free_throws_made: number | null
          game_date: string | null
          game_id: string
          id: string
          minutes_played: number | null
          offensive_rebounds: number | null
          personal_fouls: number | null
          player_id: string
          plus_minus: number | null
          points: number | null
          rebounds: number | null
          season_year: number
          steals: number | null
          three_pointers_attempted: number | null
          three_pointers_made: number | null
          triple_double: boolean | null
          turnovers: number | null
          updated_at: string
          week_number: number
        }
        Insert: {
          assists?: number | null
          blocks?: number | null
          created_at?: string
          defensive_rebounds?: number | null
          did_not_play?: boolean
          double_double?: boolean | null
          field_goals_attempted?: number | null
          field_goals_made?: number | null
          free_throws_attempted?: number | null
          free_throws_made?: number | null
          game_date?: string | null
          game_id: string
          id?: string
          minutes_played?: number | null
          offensive_rebounds?: number | null
          personal_fouls?: number | null
          player_id: string
          plus_minus?: number | null
          points?: number | null
          rebounds?: number | null
          season_year: number
          steals?: number | null
          three_pointers_attempted?: number | null
          three_pointers_made?: number | null
          triple_double?: boolean | null
          turnovers?: number | null
          updated_at?: string
          week_number: number
        }
        Update: {
          assists?: number | null
          blocks?: number | null
          created_at?: string
          defensive_rebounds?: number | null
          did_not_play?: boolean
          double_double?: boolean | null
          field_goals_attempted?: number | null
          field_goals_made?: number | null
          free_throws_attempted?: number | null
          free_throws_made?: number | null
          game_date?: string | null
          game_id?: string
          id?: string
          minutes_played?: number | null
          offensive_rebounds?: number | null
          personal_fouls?: number | null
          player_id?: string
          plus_minus?: number | null
          points?: number | null
          rebounds?: number | null
          season_year?: number
          steals?: number | null
          three_pointers_attempted?: number | null
          three_pointers_made?: number | null
          triple_double?: boolean | null
          turnovers?: number | null
          updated_at?: string
          week_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "player_game_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "nba_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_game_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      player_projections: {
        Row: {
          fetched_at: string
          id: string
          player_id: string
          projected_assists: number | null
          projected_blocks: number | null
          projected_double_doubles: number | null
          projected_field_goals_attempted: number | null
          projected_field_goals_made: number | null
          projected_free_throws_attempted: number | null
          projected_free_throws_made: number | null
          projected_minutes: number | null
          projected_points: number | null
          projected_rebounds: number | null
          projected_stat_points: number | null
          projected_steals: number | null
          projected_three_pointers_made: number | null
          projected_triple_doubles: number | null
          projected_turnovers: number | null
          season_year: number
          week_number: number
        }
        Insert: {
          fetched_at?: string
          id?: string
          player_id: string
          projected_assists?: number | null
          projected_blocks?: number | null
          projected_double_doubles?: number | null
          projected_field_goals_attempted?: number | null
          projected_field_goals_made?: number | null
          projected_free_throws_attempted?: number | null
          projected_free_throws_made?: number | null
          projected_minutes?: number | null
          projected_points?: number | null
          projected_rebounds?: number | null
          projected_stat_points?: number | null
          projected_steals?: number | null
          projected_three_pointers_made?: number | null
          projected_triple_doubles?: number | null
          projected_turnovers?: number | null
          season_year: number
          week_number: number
        }
        Update: {
          fetched_at?: string
          id?: string
          player_id?: string
          projected_assists?: number | null
          projected_blocks?: number | null
          projected_double_doubles?: number | null
          projected_field_goals_attempted?: number | null
          projected_field_goals_made?: number | null
          projected_free_throws_attempted?: number | null
          projected_free_throws_made?: number | null
          projected_minutes?: number | null
          projected_points?: number | null
          projected_rebounds?: number | null
          projected_stat_points?: number | null
          projected_steals?: number | null
          projected_three_pointers_made?: number | null
          projected_triple_doubles?: number | null
          projected_turnovers?: number | null
          season_year?: number
          week_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "player_projections_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          created_at: string
          display_name: string | null
          dynasty_rank: number | null
          dynasty_rank_fetched_at: string | null
          dynasty_rank_source: string | null
          eligible_positions: string[]
          first_name: string
          headshot_url: string | null
          id: string
          injury_status: string | null
          jersey_number: string | null
          last_name: string
          nba_draft_number: number | null
          nba_id: string | null
          nba_team: string | null
          position: Database["public"]["Enums"]["nba_position"] | null
          sleeper_id: string | null
          sportsdata_id: string | null
          status: string | null
          updated_at: string
          years_exp: number | null
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          dynasty_rank?: number | null
          dynasty_rank_fetched_at?: string | null
          dynasty_rank_source?: string | null
          eligible_positions?: string[]
          first_name: string
          headshot_url?: string | null
          id?: string
          injury_status?: string | null
          jersey_number?: string | null
          last_name: string
          nba_draft_number?: number | null
          nba_id?: string | null
          nba_team?: string | null
          position?: Database["public"]["Enums"]["nba_position"] | null
          sleeper_id?: string | null
          sportsdata_id?: string | null
          status?: string | null
          updated_at?: string
          years_exp?: number | null
        }
        Update: {
          created_at?: string
          display_name?: string | null
          dynasty_rank?: number | null
          dynasty_rank_fetched_at?: string | null
          dynasty_rank_source?: string | null
          eligible_positions?: string[]
          first_name?: string
          headshot_url?: string | null
          id?: string
          injury_status?: string | null
          jersey_number?: string | null
          last_name?: string
          nba_draft_number?: number | null
          nba_id?: string | null
          nba_team?: string | null
          position?: Database["public"]["Enums"]["nba_position"] | null
          sleeper_id?: string | null
          sportsdata_id?: string | null
          status?: string | null
          updated_at?: string
          years_exp?: number | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          push_token: string | null
          push_token_revocation_hash: string | null
          timezone: string
          updated_at: string
          username: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id: string
          push_token?: string | null
          push_token_revocation_hash?: string | null
          timezone?: string
          updated_at?: string
          username: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          push_token?: string | null
          push_token_revocation_hash?: string | null
          timezone?: string
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      projection_sync_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          http_status: number | null
          id: string
          matched_count: number
          parser_version: string
          projection_date: string | null
          projection_type: string
          row_count: number
          season_year: number | null
          source: string
          source_metadata: Json
          source_url: string
          started_at: string
          status: string
          unmatched_count: number
          week_number: number | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          http_status?: number | null
          id?: string
          matched_count?: number
          parser_version?: string
          projection_date?: string | null
          projection_type: string
          row_count?: number
          season_year?: number | null
          source?: string
          source_metadata?: Json
          source_url: string
          started_at?: string
          status?: string
          unmatched_count?: number
          week_number?: number | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          http_status?: number | null
          id?: string
          matched_count?: number
          parser_version?: string
          projection_date?: string | null
          projection_type?: string
          row_count?: number
          season_year?: number | null
          source?: string
          source_metadata?: Json
          source_url?: string
          started_at?: string
          status?: string
          unmatched_count?: number
          week_number?: number | null
        }
        Relationships: []
      }
      roster_players: {
        Row: {
          acquired_at: string
          acquired_via: string
          acquisition_cost: number | null
          id: string
          is_on_ir: boolean
          is_on_taxi: boolean
          league_id: string
          league_season_id: string
          member_id: string
          player_id: string
        }
        Insert: {
          acquired_at?: string
          acquired_via: string
          acquisition_cost?: number | null
          id?: string
          is_on_ir?: boolean
          is_on_taxi?: boolean
          league_id: string
          league_season_id: string
          member_id: string
          player_id: string
        }
        Update: {
          acquired_at?: string
          acquired_via?: string
          acquisition_cost?: number | null
          id?: string
          is_on_ir?: boolean
          is_on_taxi?: boolean
          league_id?: string
          league_season_id?: string
          member_id?: string
          player_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "roster_players_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_players_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "roster_players_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_players_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_players_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      roster_transactions: {
        Row: {
          id: string
          league_id: string
          league_season_id: string
          member_id: string
          occurred_at: string
          player_id: string
          related_claim_id: string | null
          related_nomination_id: string | null
          related_trade_id: string | null
          transaction_type: string
        }
        Insert: {
          id?: string
          league_id: string
          league_season_id: string
          member_id: string
          occurred_at?: string
          player_id: string
          related_claim_id?: string | null
          related_nomination_id?: string | null
          related_trade_id?: string | null
          transaction_type: string
        }
        Update: {
          id?: string
          league_id?: string
          league_season_id?: string
          member_id?: string
          occurred_at?: string
          player_id?: string
          related_claim_id?: string | null
          related_nomination_id?: string | null
          related_trade_id?: string | null
          transaction_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "roster_transactions_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_transactions_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "roster_transactions_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_transactions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_transactions_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_transactions_related_claim_id_fkey"
            columns: ["related_claim_id"]
            isOneToOne: false
            referencedRelation: "waiver_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_transactions_related_nomination_id_fkey"
            columns: ["related_nomination_id"]
            isOneToOne: false
            referencedRelation: "nominations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_transactions_related_trade_id_fkey"
            columns: ["related_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      rps_challenges: {
        Row: {
          context: string | null
          created_at: string
          id: string
          league_id: string
          league_season_id: string
          member_a_choice: Database["public"]["Enums"]["rps_choice"] | null
          member_a_id: string
          member_b_choice: Database["public"]["Enums"]["rps_choice"] | null
          member_b_id: string
          resolved_at: string | null
          status: Database["public"]["Enums"]["rps_status"]
          winner_member_id: string | null
        }
        Insert: {
          context?: string | null
          created_at?: string
          id?: string
          league_id: string
          league_season_id: string
          member_a_choice?: Database["public"]["Enums"]["rps_choice"] | null
          member_a_id: string
          member_b_choice?: Database["public"]["Enums"]["rps_choice"] | null
          member_b_id: string
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["rps_status"]
          winner_member_id?: string | null
        }
        Update: {
          context?: string | null
          created_at?: string
          id?: string
          league_id?: string
          league_season_id?: string
          member_a_choice?: Database["public"]["Enums"]["rps_choice"] | null
          member_a_id?: string
          member_b_choice?: Database["public"]["Enums"]["rps_choice"] | null
          member_b_id?: string
          resolved_at?: string | null
          status?: Database["public"]["Enums"]["rps_status"]
          winner_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rps_challenges_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rps_challenges_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "rps_challenges_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rps_challenges_member_a_id_fkey"
            columns: ["member_a_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rps_challenges_member_b_id_fkey"
            columns: ["member_b_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rps_challenges_winner_member_id_fkey"
            columns: ["winner_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      season_weeks: {
        Row: {
          id: string
          season_year: number
          week_end: string
          week_number: number
          week_start: string
        }
        Insert: {
          id?: string
          season_year: number
          week_end: string
          week_number: number
          week_start: string
        }
        Update: {
          id?: string
          season_year?: number
          week_end?: string
          week_number?: number
          week_start?: string
        }
        Relationships: []
      }
      snake_draft_picks: {
        Row: {
          draft_id: string
          draft_pick_id: string | null
          id: string
          member_id: string
          overall_pick: number
          pick_in_round: number
          picked_at: string | null
          player_id: string | null
          round: number
          skip_reason: string | null
          skipped_at: string | null
          timer_expires_at: string | null
        }
        Insert: {
          draft_id: string
          draft_pick_id?: string | null
          id?: string
          member_id: string
          overall_pick: number
          pick_in_round: number
          picked_at?: string | null
          player_id?: string | null
          round: number
          skip_reason?: string | null
          skipped_at?: string | null
          timer_expires_at?: string | null
        }
        Update: {
          draft_id?: string
          draft_pick_id?: string | null
          id?: string
          member_id?: string
          overall_pick?: number
          pick_in_round?: number
          picked_at?: string | null
          player_id?: string | null
          round?: number
          skip_reason?: string | null
          skipped_at?: string | null
          timer_expires_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "snake_draft_picks_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: false
            referencedRelation: "drafts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snake_draft_picks_draft_pick_id_fkey"
            columns: ["draft_pick_id"]
            isOneToOne: false
            referencedRelation: "draft_picks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snake_draft_picks_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "snake_draft_picks_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      standings: {
        Row: {
          created_at: string
          id: string
          league_id: string
          league_season_id: string
          losses: number
          max_possible_points: number
          member_id: string
          points_against: number
          points_for: number
          ties: number
          waiver_priority: number
          week_number: number
          wins: number
        }
        Insert: {
          created_at?: string
          id?: string
          league_id: string
          league_season_id: string
          losses?: number
          max_possible_points?: number
          member_id: string
          points_against?: number
          points_for?: number
          ties?: number
          waiver_priority: number
          week_number: number
          wins?: number
        }
        Update: {
          created_at?: string
          id?: string
          league_id?: string
          league_season_id?: string
          losses?: number
          max_possible_points?: number
          member_id?: string
          points_against?: number
          points_for?: number
          ties?: number
          waiver_priority?: number
          week_number?: number
          wins?: number
        }
        Relationships: [
          {
            foreignKeyName: "standings_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "standings_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "standings_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "standings_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      sync_jobs: {
        Row: {
          claim_token: string | null
          claimed_at: string | null
          completed_at: string | null
          completed_items: number
          created_at: string
          error_log: Json | null
          failed_items: number
          id: string
          job_type: string
          metadata: Json | null
          started_at: string | null
          status: string
          total_items: number | null
        }
        Insert: {
          claim_token?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completed_items?: number
          created_at?: string
          error_log?: Json | null
          failed_items?: number
          id?: string
          job_type: string
          metadata?: Json | null
          started_at?: string | null
          status?: string
          total_items?: number | null
        }
        Update: {
          claim_token?: string | null
          claimed_at?: string | null
          completed_at?: string | null
          completed_items?: number
          created_at?: string
          error_log?: Json | null
          failed_items?: number
          id?: string
          job_type?: string
          metadata?: Json | null
          started_at?: string | null
          status?: string
          total_items?: number | null
        }
        Relationships: []
      }
      sync_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          function_name: string
          id: string
          rows_affected: number | null
          started_at: string
          status: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          function_name: string
          id?: string
          rows_affected?: number | null
          started_at?: string
          status?: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          function_name?: string
          id?: string
          rows_affected?: number | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      trade_block_items: {
        Row: {
          created_at: string
          id: string
          league_id: string
          member_id: string
          note: string | null
          pick_id: string | null
          player_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          league_id: string
          member_id: string
          note?: string | null
          pick_id?: string | null
          player_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          league_id?: string
          member_id?: string
          note?: string | null
          pick_id?: string | null
          player_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_block_items_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_block_items_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "trade_block_items_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_block_items_pick_id_fkey"
            columns: ["pick_id"]
            isOneToOne: false
            referencedRelation: "draft_picks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_block_items_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_items: {
        Row: {
          created_at: string
          faab_amount: number
          from_member_id: string
          id: string
          league_id: string
          pick_id: string | null
          player_id: string | null
          side: Database["public"]["Enums"]["trade_side"]
          to_member_id: string
          trade_id: string
        }
        Insert: {
          created_at?: string
          faab_amount?: number
          from_member_id: string
          id?: string
          league_id: string
          pick_id?: string | null
          player_id?: string | null
          side: Database["public"]["Enums"]["trade_side"]
          to_member_id: string
          trade_id: string
        }
        Update: {
          created_at?: string
          faab_amount?: number
          from_member_id?: string
          id?: string
          league_id?: string
          pick_id?: string | null
          player_id?: string | null
          side?: Database["public"]["Enums"]["trade_side"]
          to_member_id?: string
          trade_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_items_from_member_id_fkey"
            columns: ["from_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_items_from_participant_fkey"
            columns: ["trade_id", "from_member_id"]
            isOneToOne: false
            referencedRelation: "trade_participants"
            referencedColumns: ["trade_id", "member_id"]
          },
          {
            foreignKeyName: "trade_items_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_items_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "trade_items_pick_id_fkey"
            columns: ["pick_id"]
            isOneToOne: false
            referencedRelation: "draft_picks"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_items_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_items_to_member_id_fkey"
            columns: ["to_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_items_to_participant_fkey"
            columns: ["trade_id", "to_member_id"]
            isOneToOne: false
            referencedRelation: "trade_participants"
            referencedColumns: ["trade_id", "member_id"]
          },
          {
            foreignKeyName: "trade_items_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_participants: {
        Row: {
          accepted_at: string | null
          created_at: string
          is_initiator: boolean
          league_id: string
          member_id: string
          proposed_at: string
          sort_order: number
          trade_id: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          is_initiator?: boolean
          league_id: string
          member_id: string
          proposed_at: string
          sort_order?: number
          trade_id: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          is_initiator?: boolean
          league_id?: string
          member_id?: string
          proposed_at?: string
          sort_order?: number
          trade_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_participants_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_participants_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "trade_participants_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_participants_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trade_vetos: {
        Row: {
          id: string
          league_id: string
          member_id: string
          trade_id: string
          veto_type: Database["public"]["Enums"]["veto_type"]
          vetoed_at: string
        }
        Insert: {
          id?: string
          league_id: string
          member_id: string
          trade_id: string
          veto_type: Database["public"]["Enums"]["veto_type"]
          vetoed_at?: string
        }
        Update: {
          id?: string
          league_id?: string
          member_id?: string
          trade_id?: string
          veto_type?: Database["public"]["Enums"]["veto_type"]
          vetoed_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trade_vetos_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_vetos_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "trade_vetos_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trade_vetos_trade_id_fkey"
            columns: ["trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      trades: {
        Row: {
          accepted_at: string | null
          completed_at: string | null
          completion_failure_reason: string | null
          countered_from_trade_id: string | null
          edited_from_trade_id: string | null
          expires_at: string | null
          id: string
          is_multi_team: boolean
          league_id: string
          league_season_id: string
          notes: string | null
          parent_trade_id: string | null
          proposed_at: string
          proposer_faab_amount: number
          proposer_member_id: string
          recipient_faab_amount: number
          recipient_member_id: string
          replaced_by_trade_id: string | null
          status: Database["public"]["Enums"]["trade_status"]
          version: number
          veto_window_expires_at: string | null
          vetoed_at: string | null
        }
        Insert: {
          accepted_at?: string | null
          completed_at?: string | null
          completion_failure_reason?: string | null
          countered_from_trade_id?: string | null
          edited_from_trade_id?: string | null
          expires_at?: string | null
          id?: string
          is_multi_team?: boolean
          league_id: string
          league_season_id: string
          notes?: string | null
          parent_trade_id?: string | null
          proposed_at?: string
          proposer_faab_amount?: number
          proposer_member_id: string
          recipient_faab_amount?: number
          recipient_member_id: string
          replaced_by_trade_id?: string | null
          status?: Database["public"]["Enums"]["trade_status"]
          version?: number
          veto_window_expires_at?: string | null
          vetoed_at?: string | null
        }
        Update: {
          accepted_at?: string | null
          completed_at?: string | null
          completion_failure_reason?: string | null
          countered_from_trade_id?: string | null
          edited_from_trade_id?: string | null
          expires_at?: string | null
          id?: string
          is_multi_team?: boolean
          league_id?: string
          league_season_id?: string
          notes?: string | null
          parent_trade_id?: string | null
          proposed_at?: string
          proposer_faab_amount?: number
          proposer_member_id?: string
          recipient_faab_amount?: number
          recipient_member_id?: string
          replaced_by_trade_id?: string | null
          status?: Database["public"]["Enums"]["trade_status"]
          version?: number
          veto_window_expires_at?: string | null
          vetoed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trades_countered_from_trade_id_fkey"
            columns: ["countered_from_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_edited_from_trade_id_fkey"
            columns: ["edited_from_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "trades_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_parent_trade_id_fkey"
            columns: ["parent_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_proposer_member_id_fkey"
            columns: ["proposer_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_recipient_member_id_fkey"
            columns: ["recipient_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trades_replaced_by_trade_id_fkey"
            columns: ["replaced_by_trade_id"]
            isOneToOne: false
            referencedRelation: "trades"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_claims: {
        Row: {
          bid_amount: number
          claim_order: number
          drop_player_id: string | null
          failure_reason: string | null
          id: string
          league_id: string
          league_season_id: string
          member_id: string
          player_id: string
          priority_at_submission: number
          process_date: string
          processed_at: string | null
          status: Database["public"]["Enums"]["waiver_claim_status"]
          submitted_at: string
        }
        Insert: {
          bid_amount?: number
          claim_order?: number
          drop_player_id?: string | null
          failure_reason?: string | null
          id?: string
          league_id: string
          league_season_id: string
          member_id: string
          player_id: string
          priority_at_submission: number
          process_date: string
          processed_at?: string | null
          status?: Database["public"]["Enums"]["waiver_claim_status"]
          submitted_at?: string
        }
        Update: {
          bid_amount?: number
          claim_order?: number
          drop_player_id?: string | null
          failure_reason?: string | null
          id?: string
          league_id?: string
          league_season_id?: string
          member_id?: string
          player_id?: string
          priority_at_submission?: number
          process_date?: string
          processed_at?: string | null
          status?: Database["public"]["Enums"]["waiver_claim_status"]
          submitted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_claims_drop_player_id_fkey"
            columns: ["drop_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_claims_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_claims_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "waiver_claims_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_claims_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_claims_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
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
          id?: string
          league_id?: string
          league_season_id?: string
          member_id?: string
          priority?: number
        }
        Relationships: [
          {
            foreignKeyName: "waiver_priorities_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_priorities_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "waiver_priorities_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_priorities_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      waiver_wire_log: {
        Row: {
          claimed_by_claim_id: string | null
          cleared_at: string | null
          clears_at: string
          dropped_by_member_id: string | null
          id: string
          league_id: string
          league_season_id: string
          placed_on_waivers_at: string
          player_id: string
        }
        Insert: {
          claimed_by_claim_id?: string | null
          cleared_at?: string | null
          clears_at: string
          dropped_by_member_id?: string | null
          id?: string
          league_id: string
          league_season_id: string
          placed_on_waivers_at?: string
          player_id: string
        }
        Update: {
          claimed_by_claim_id?: string | null
          cleared_at?: string | null
          clears_at?: string
          dropped_by_member_id?: string | null
          id?: string
          league_id?: string
          league_season_id?: string
          placed_on_waivers_at?: string
          player_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "waiver_wire_log_claimed_by_claim_id_fkey"
            columns: ["claimed_by_claim_id"]
            isOneToOne: false
            referencedRelation: "waiver_claims"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_wire_log_dropped_by_member_id_fkey"
            columns: ["dropped_by_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_wire_log_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_wire_log_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "waiver_wire_log_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "waiver_wire_log_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_add_counts: {
        Row: {
          add_count: number
          id: string
          league_id: string
          league_season_id: string
          member_id: string
          updated_at: string
          week_number: number
        }
        Insert: {
          add_count?: number
          id?: string
          league_id: string
          league_season_id: string
          member_id: string
          updated_at?: string
          week_number: number
        }
        Update: {
          add_count?: number
          id?: string
          league_id?: string
          league_season_id?: string
          member_id?: string
          updated_at?: string
          week_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "weekly_add_counts_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_add_counts_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "weekly_add_counts_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_add_counts_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      weekly_lineups: {
        Row: {
          game_date: string
          id: string
          is_auto_set: boolean
          league_id: string
          league_season_id: string
          member_id: string
          player_id: string
          set_at: string
          slot_type: Database["public"]["Enums"]["roster_slot_type"]
          week_number: number
        }
        Insert: {
          game_date: string
          id?: string
          is_auto_set?: boolean
          league_id: string
          league_season_id: string
          member_id: string
          player_id: string
          set_at?: string
          slot_type: Database["public"]["Enums"]["roster_slot_type"]
          week_number: number
        }
        Update: {
          game_date?: string
          id?: string
          is_auto_set?: boolean
          league_id?: string
          league_season_id?: string
          member_id?: string
          player_id?: string
          set_at?: string
          slot_type?: Database["public"]["Enums"]["roster_slot_type"]
          week_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "weekly_lineups_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_lineups_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "weekly_lineups_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_lineups_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "weekly_lineups_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      mv_player_season_averages: {
        Row: {
          avg_assists: number | null
          avg_blocks: number | null
          avg_field_goals_attempted: number | null
          avg_field_goals_made: number | null
          avg_free_throws_attempted: number | null
          avg_free_throws_made: number | null
          avg_minutes_played: number | null
          avg_points: number | null
          avg_rebounds: number | null
          avg_steals: number | null
          avg_three_pointers_made: number | null
          avg_turnovers: number | null
          double_doubles: number | null
          games_played: number | null
          player_id: string | null
          season_year: number | null
          triple_doubles: number | null
        }
        Relationships: [
          {
            foreignKeyName: "player_game_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      v_fantasy_points: {
        Row: {
          fantasy_points: number | null
          game_id: string | null
          league_id: string | null
          player_id: string | null
          season_year: number | null
          stat_id: string | null
          week_number: number | null
        }
        Relationships: [
          {
            foreignKeyName: "player_game_stats_game_id_fkey"
            columns: ["game_id"]
            isOneToOne: false
            referencedRelation: "nba_games"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "player_game_stats_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      v_matchup_detail: {
        Row: {
          away_max_possible_points: number | null
          away_member_id: string | null
          away_points: number | null
          away_team_name: string | null
          created_at: string | null
          finalized_at: string | null
          home_max_possible_points: number | null
          home_member_id: string | null
          home_points: number | null
          home_team_name: string | null
          id: string | null
          is_finalized: boolean | null
          league_id: string | null
          league_season_id: string | null
          matchup_type: Database["public"]["Enums"]["matchup_type"] | null
          week_number: number | null
          winner_member_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "matchups_away_member_id_fkey"
            columns: ["away_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_home_member_id_fkey"
            columns: ["home_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "leagues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_league_id_fkey"
            columns: ["league_id"]
            isOneToOne: false
            referencedRelation: "v_fantasy_points"
            referencedColumns: ["league_id"]
          },
          {
            foreignKeyName: "matchups_league_season_id_fkey"
            columns: ["league_season_id"]
            isOneToOne: false
            referencedRelation: "league_seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matchups_winner_member_id_fkey"
            columns: ["winner_member_id"]
            isOneToOne: false
            referencedRelation: "league_members"
            referencedColumns: ["id"]
          },
        ]
      }
      v_player_avg_fantasy_points: {
        Row: {
          avg_fantasy_points: number | null
          league_id: string | null
          player_id: string | null
          season_year: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_trade_atomic: {
        Args: { p_accepting_member_id: string; p_trade_id: string }
        Returns: Json
      }
      activate_rookie_draft_league_atomic: {
        Args: { p_draft_id: string }
        Returns: boolean
      }
      activate_roster_player_with_lineup_atomic: {
        Args: {
          p_activate_roster_player_id: string
          p_activate_source: string
          p_free_action: string | null
          p_free_roster_player_id: string | null
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
          p_slot_type?: Database["public"]["Enums"]["roster_slot_type"] | null
          p_week_number: number
        }
        Returns: undefined
      }
      activate_roster_player_with_overflow_atomic: {
        Args: {
          p_activate_roster_player_id: string
          p_activate_source: string
          p_free_action: string
          p_free_roster_player_id: string
        }
        Returns: undefined
      }
      add_free_agent_atomic: {
        Args: { p_league_id: string; p_member_id: string; p_player_id: string }
        Returns: undefined
      }
      add_trade_block_item_atomic: {
        Args: {
          p_league_id: string
          p_member_id: string
          p_note?: string
          p_pick_id?: string
          p_player_id?: string
          p_user_id?: string
        }
        Returns: string
      }
      advance_playoff_bracket_atomic: {
        Args: { p_league_id: string }
        Returns: Json
      }
      advance_season_atomic: {
        Args: { p_league_id: string }
        Returns: {
          new_season_id: string
          new_year: number
        }[]
      }
      assert_current_league_season_for_lineup: {
        Args: { p_league_id: string; p_league_season_id: string }
        Returns: undefined
      }
      auto_pick_snake_pick_atomic: {
        Args: { p_draft_id: string; p_member_id: string; p_reason?: string }
        Returns: Json
      }
      auto_set_lineup_atomic: {
        Args: {
          p_assignments: Json
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
        }
        Returns: undefined
      }
      auto_set_lineup_atomic_unchecked: {
        Args: {
          p_assignments: Json
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
        }
        Returns: undefined
      }
      auto_set_lineup_service_atomic: {
        Args: {
          p_assignments: Json
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
        }
        Returns: undefined
      }
      cancel_waiver_claim_atomic: {
        Args: { p_claim_id: string; p_member_id: string; p_user_id?: string }
        Returns: undefined
      }
      checkpoint_stats_sync_job_atomic: {
        Args: {
          p_claim_token: string
          p_completed_items: number
          p_job_id: string
          p_metadata: Json
        }
        Returns: boolean
      }
      claim_notification_outbox_atomic: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          body: string
          category: string
          claim_token: string
          data: Json
          id: string
          member_id: string
          title: string
        }[]
      }
      claim_notification_receipts_atomic: {
        Args: { p_lease_seconds?: number; p_limit?: number }
        Returns: {
          claim_token: string
          expo_ticket_id: string
          id: string
          member_id: string
          push_token: string
        }[]
      }
      claim_stats_sync_job_atomic: {
        Args: { p_job_id?: string; p_stale_after_seconds?: number }
        Returns: {
          claim_token: string
          completed_items: number
          id: string
          job_type: string
          metadata: Json
          total_items: number
        }[]
      }
      clear_ineligible_taxi_players: { Args: never; Returns: number }
      clear_push_token_for_user_atomic: {
        Args: { p_token: string; p_user_id: string }
        Returns: boolean
      }
      close_auction_nomination_atomic: {
        Args: { p_nomination_id: string }
        Returns: boolean
      }
      close_expired_auction_nominations_atomic: {
        Args: { p_limit?: number }
        Returns: {
          closed: boolean
          error_code: string
          error_message: string
          nomination_id: string
        }[]
      }
      commissioner_adjust_faab_balance_atomic: {
        Args: { p_balance: number; p_league_id: string; p_member_id: string }
        Returns: number
      }
      commissioner_override_weekly_add_count_atomic: {
        Args: { p_add_count: number; p_league_id: string; p_member_id: string }
        Returns: number
      }
      commissioner_snake_pick_atomic: {
        Args: {
          p_actor_user_id?: string
          p_draft_id: string
          p_member_id: string
          p_player_id: string
        }
        Returns: Json
      }
      complete_accepted_trade_atomic: {
        Args: { p_trade_id: string }
        Returns: undefined
      }
      complete_notification_outbox_atomic: {
        Args: { p_claim_token: string; p_id: string }
        Returns: boolean
      }
      complete_stats_sync_job_atomic: {
        Args: {
          p_claim_token: string
          p_completed_items: number
          p_job_id: string
          p_metadata: Json
        }
        Returns: boolean
      }
      compute_fantasy_points: {
        Args: { p_league_id: string; p_stat_id: string }
        Returns: number
      }
      count_final_games_missing_stats: {
        Args: { season_year_param: number }
        Returns: number
      }
      counter_multi_team_trade_atomic: {
        Args: {
          p_expires_at?: string
          p_items: Json
          p_member_id: string
          p_notes?: string
          p_participant_member_ids: string[]
          p_trade_id: string
          p_user_id: string
        }
        Returns: string
      }
      counter_trade_atomic: {
        Args: {
          p_expires_at?: string
          p_member_id: string
          p_notes?: string
          p_offer_faab_amount?: number
          p_offer_pick_ids: string[]
          p_offer_player_ids: string[]
          p_request_faab_amount?: number
          p_request_pick_ids: string[]
          p_request_player_ids: string[]
          p_trade_id: string
          p_user_id: string
        }
        Returns: string
      }
      create_auction_nomination_atomic: {
        Args: {
          p_countdown_seconds?: number
          p_draft_id: string
          p_member_id: string
          p_player_id: string
          p_user_id: string
        }
        Returns: {
          closed_at: string | null
          countdown_expires_at: string | null
          current_bid_amount: number
          current_bidder_id: string | null
          draft_id: string
          final_price: number | null
          id: string
          nominated_at: string
          nominating_member_id: string
          nomination_order: number
          player_id: string
          status: Database["public"]["Enums"]["nomination_status"]
          winning_member_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "nominations"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_league: {
        Args: { p_auction_budget?: number; p_name: string; p_team_name: string }
        Returns: Json
      }
      create_mock_draft_room_atomic: {
        Args: {
          p_budget_per_team?: number
          p_draft_type?: string
          p_league_id: string
          p_member_id: string
          p_nomination_order_mode?: string
          p_pick_timer_seconds?: number
          p_room_name?: string
          p_rounds?: number
          p_scheduled_at?: string
          p_timer_expiry_behavior?: string
          p_user_id: string
        }
        Returns: {
          budget_per_team: number | null
          completed_at: string | null
          created_at: string
          created_by_member_id: string | null
          current_nomination_order: number
          draft_type: Database["public"]["Enums"]["draft_type"]
          id: string
          is_mock: boolean
          league_id: string
          league_season_id: string
          nomination_order_mode: string
          pause_reason: string | null
          paused_at: string | null
          pick_timer_seconds: number
          room_name: string | null
          rounds: number | null
          scheduled_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["draft_status"]
          timer_expiry_behavior: string
          timer_paused_remaining_seconds: number | null
        }
        SetofOptions: {
          from: "*"
          to: "drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      create_or_resume_stats_sync_job_atomic: {
        Args: { p_end_date: string; p_start_date: string }
        Returns: string
      }
      create_waiver_claim_atomic: {
        Args: {
          p_bid_amount?: number
          p_claim_order?: number
          p_drop_player_id?: string
          p_league_id: string
          p_member_id: string
          p_player_id: string
          p_user_id?: string
        }
        Returns: string
      }
      current_season_year_et: { Args: { p_now?: string }; Returns: number }
      dead_letter_notification_outbox_atomic: {
        Args: { p_claim_token: string; p_error: string; p_id: string }
        Returns: boolean
      }
      defer_notification_receipt_atomic: {
        Args: {
          p_claim_token: string
          p_error: string
          p_id: string
          p_retry_delay_seconds?: number
        }
        Returns: boolean
      }
      defer_notification_receipt_state_atomic: {
        Args: {
          p_claim_token: string
          p_error: string
          p_id: string
          p_increment_attempt?: boolean
          p_retry_delay_seconds?: number
        }
        Returns: string
      }
      delete_league_atomic: { Args: { p_league_id: string }; Returns: Json }
      drop_and_add_free_agent_atomic: {
        Args: {
          p_league_id: string
          p_member_id: string
          p_player_id: string
          p_roster_player_id: string
        }
        Returns: undefined
      }
      drop_player_atomic: {
        Args: { p_roster_player_id: string }
        Returns: undefined
      }
      edit_multi_team_trade_atomic: {
        Args: {
          p_expires_at?: string
          p_items: Json
          p_member_id: string
          p_notes?: string
          p_participant_member_ids: string[]
          p_trade_id: string
          p_user_id: string
        }
        Returns: string
      }
      edit_trade_atomic: {
        Args: {
          p_expires_at?: string
          p_member_id: string
          p_notes?: string
          p_offer_faab_amount?: number
          p_offer_pick_ids: string[]
          p_offer_player_ids: string[]
          p_request_faab_amount?: number
          p_request_pick_ids: string[]
          p_request_player_ids: string[]
          p_trade_id: string
          p_user_id: string
        }
        Returns: string
      }
      edit_waiver_claim_atomic: {
        Args: {
          p_bid_amount?: number
          p_claim_id: string
          p_claim_order?: number
          p_drop_player_id?: string
          p_member_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      expire_pending_trades_atomic: {
        Args: { p_limit?: number }
        Returns: {
          participant_member_ids: string[]
          proposer_member_id: string
          recipient_member_id: string
          trade_id: string
        }[]
      }
      expire_trade_completion_failure_atomic: {
        Args: { p_reason?: string; p_trade_id: string }
        Returns: undefined
      }
      expire_waiver_wire_logs: { Args: never; Returns: number }
      fail_notification_outbox_atomic: {
        Args: { p_claim_token: string; p_error: string; p_id: string }
        Returns: boolean
      }
      fail_stats_sync_job_atomic: {
        Args: {
          p_claim_token: string
          p_completed_items: number
          p_error: string
          p_job_id: string
          p_metadata: Json
        }
        Returns: boolean
      }
      finalize_score_week_atomic: {
        Args: {
          p_finalized_at?: string
          p_league_id: string
          p_league_season_id: string
          p_matchups: Json
          p_reconciliation_at?: string
          p_standings: Json
          p_week_number: number
        }
        Returns: Json
      }
      generate_invite_code: { Args: never; Returns: string }
      generate_playoff_bracket_atomic: {
        Args: { p_league_id: string }
        Returns: Json
      }
      get_league_activity_feed: {
        Args: { p_league_id: string; p_limit?: number; p_offset?: number }
        Returns: {
          body: string
          eligible_positions: string[]
          id: string
          is_system: boolean
          member_id: string
          nba_id: string
          occurred_at: string
          player_id: string
          player_name: string
          player_position: string
          target_member_id: string
          target_team_name: string
          team_name: string
          title: string
          transaction_type: string
        }[]
      }
      get_league_projection_rows: {
        Args: {
          p_game_date?: string
          p_league_id: string
          p_limit?: number
          p_offset?: number
          p_player_ids?: string[]
          p_season_year?: number
          p_view?: string
        }
        Returns: {
          display_name: string
          eligible_positions: string[]
          headshot_url: string
          injury_status: string
          nba_id: string
          nba_team: string
          next_game_date: string
          next_game_opponent: string
          next_game_time: string
          player_id: string
          position: string
          projection_assists: number
          projection_blocks: number
          projection_date: string
          projection_fantasy_points: number
          projection_fetched_at: string
          projection_field_goal_pct: number
          projection_free_throw_pct: number
          projection_games_played: number
          projection_is_fresh: boolean
          projection_minutes: number
          projection_points: number
          projection_rebounds: number
          projection_source: string
          projection_source_label: string
          projection_status: string
          projection_steals: number
          projection_three_pointers_made: number
          projection_turnovers: number
          projection_view: string
          projection_week_number: number
        }[]
      }
      get_member_transaction_state: {
        Args: { p_league_id: string; p_member_id: string }
        Returns: {
          faab_balance: number
          faab_starting_budget: number
          league_season_id: string
          waiver_mode: string
          week_number: number
          weekly_add_count: number
          weekly_add_limit: number
        }[]
      }
      get_pending_trade_count: {
        Args: { p_league_id: string; p_member_id: string }
        Returns: number
      }
      get_trade_page_refs: {
        Args: {
          p_cursor?: string
          p_league_id: string
          p_limit?: number
          p_member_id: string
        }
        Returns: {
          cursor_token: string
          trade_id: string
        }[]
      }
      invoke_edge_function: {
        Args: { body?: Json; function_name: string }
        Returns: undefined
      }
      invoke_edge_function_at_et_time: {
        Args: { p_function_name: string; p_hour: number; p_minute?: number }
        Returns: undefined
      }
      invoke_projection_sync_if_due: { Args: never; Returns: undefined }
      is_regular_season_game_id: {
        Args: { p_game_id: string }
        Returns: boolean
      }
      join_league_by_invite_code: {
        Args: { p_invite_code: string; p_team_name: string }
        Returns: Json
      }
      join_mock_draft_room_atomic: {
        Args: { p_draft_id: string; p_member_id: string; p_user_id: string }
        Returns: undefined
      }
      leave_mock_draft_room_atomic: {
        Args: { p_draft_id: string; p_member_id: string; p_user_id: string }
        Returns: undefined
      }
      lineup_slot_allowed_positions: {
        Args: { p_slot_type: Database["public"]["Enums"]["roster_slot_type"] }
        Returns: string[]
      }
      make_snake_pick_atomic: {
        Args: { p_draft_id: string; p_member_id: string; p_player_id: string }
        Returns: Json
      }
      merge_duplicate_players: { Args: never; Returns: undefined }
      merge_players: {
        Args: { loser_id: string; winner_id: string }
        Returns: undefined
      }
      name_key: { Args: { n: string }; Returns: string }
      pause_draft_atomic: {
        Args: { p_actor_user_id?: string; p_draft_id: string }
        Returns: undefined
      }
      pause_draft_for_absence_atomic: {
        Args: { p_actor_user_id?: string; p_draft_id: string }
        Returns: undefined
      }
      place_auction_bid_atomic: {
        Args: {
          p_amount: number
          p_draft_id: string
          p_member_id: string
          p_nomination_id: string
          p_user_id: string
        }
        Returns: undefined
      }
      process_due_accepted_trades_atomic: {
        Args: { p_limit?: number }
        Returns: {
          error_code: string
          error_message: string
          participant_member_ids: string[]
          proposer_member_id: string
          recipient_member_id: string
          status: string
          trade_id: string
        }[]
      }
      process_due_waiver_claims_atomic: {
        Args: { p_limit?: number; p_process_date: string }
        Returns: {
          claim_id: string
          failure_reason: string
          member_id: string
          player_id: string
          processed: boolean
          status: Database["public"]["Enums"]["waiver_claim_status"]
        }[]
      }
      process_expired_snake_pick_atomic: {
        Args: { p_draft_id: string }
        Returns: {
          draft_id: string
          error_code: string
          error_message: string
          member_id: string
          pick_id: string
          picked: boolean
          player_id: string
        }[]
      }
      process_expired_snake_picks_atomic: {
        Args: { p_limit?: number }
        Returns: {
          draft_id: string
          error_code: string
          error_message: string
          member_id: string
          pick_id: string
          picked: boolean
          player_id: string
        }[]
      }
      process_next_waiver_claim_atomic: {
        Args: { p_process_date: string }
        Returns: {
          claim_id: string
          failure_reason: string
          member_id: string
          player_id: string
          processed: boolean
          status: Database["public"]["Enums"]["waiver_claim_status"]
        }[]
      }
      projection_stat_fantasy_points: {
        Args: {
          p_assists: number
          p_blocks: number
          p_double_doubles: number
          p_field_goals_attempted: number
          p_field_goals_made: number
          p_free_throws_attempted: number
          p_free_throws_made: number
          p_points: number
          p_rebounds: number
          p_scoring_settings: Json
          p_steals: number
          p_three_pointers_made: number
          p_triple_doubles: number
          p_turnovers: number
        }
        Returns: number
      }
      propose_multi_team_trade_atomic: {
        Args: {
          p_expires_at?: string
          p_items: Json
          p_league_id: string
          p_league_season_id: string
          p_notes?: string
          p_participant_member_ids: string[]
          p_proposer_member_id: string
        }
        Returns: string
      }
      propose_trade_atomic: {
        Args: {
          p_expires_at?: string
          p_league_id: string
          p_league_season_id: string
          p_notes?: string
          p_offer_faab_amount?: number
          p_offer_pick_ids: string[]
          p_offer_player_ids: string[]
          p_proposer_member_id: string
          p_recipient_member_id: string
          p_request_faab_amount?: number
          p_request_pick_ids: string[]
          p_request_player_ids: string[]
        }
        Returns: string
      }
      record_notification_outbox_ticket_atomic: {
        Args: {
          p_claim_token: string
          p_expo_ticket_id: string
          p_id: string
          p_push_token: string
          p_receipt_delay_seconds?: number
        }
        Returns: boolean
      }
      refresh_player_search_caches: { Args: never; Returns: undefined }
      register_push_token_atomic: {
        Args: { p_revocation_hash: string; p_token: string; p_user_id: string }
        Returns: undefined
      }
      reject_trade_atomic: {
        Args: { p_member_id: string; p_trade_id: string; p_user_id: string }
        Returns: Json
      }
      release_live_poll_lease: {
        Args: { p_holder_id: string; p_lock_key: number }
        Returns: boolean
      }
      release_live_poll_lock: { Args: never; Returns: boolean }
      release_stats_sync_job_atomic: {
        Args: {
          p_claim_token: string
          p_completed_items: number
          p_job_id: string
          p_metadata: Json
        }
        Returns: boolean
      }
      remove_trade_block_item_atomic: {
        Args: { p_item_id: string; p_member_id: string; p_user_id?: string }
        Returns: undefined
      }
      reorder_waiver_claim_atomic: {
        Args: {
          p_claim_id: string
          p_direction: string
          p_member_id: string
          p_user_id: string
        }
        Returns: number
      }
      replace_dynasty_rankings: {
        Args: {
          p_fetched_at: string
          p_min_rows?: number
          p_rows: Json
          p_scoring_format?: string
          p_source: string
          p_source_metadata?: Json
          p_source_url?: string
        }
        Returns: Json
      }
      replace_regular_season_matchups_atomic: {
        Args: {
          p_force?: boolean
          p_league_id: string
          p_league_season_id: string
          p_matchups?: Json
        }
        Returns: Json
      }
      reseed_rookie_draft_picks_atomic: {
        Args: { p_draft_id: string; p_rounds?: number }
        Returns: number
      }
      reset_draft_atomic: {
        Args: { p_actor_user_id?: string; p_draft_id: string }
        Returns: undefined
      }
      resume_draft_atomic: {
        Args: { p_actor_user_id?: string; p_draft_id: string }
        Returns: undefined
      }
      resume_draft_if_absent_atomic: {
        Args: { p_actor_user_id?: string; p_draft_id: string }
        Returns: undefined
      }
      revoke_push_token_atomic: {
        Args: { p_revocation_hash: string; p_token: string }
        Returns: boolean
      }
      search_players: {
        Args: {
          p_exclude_player_ids?: string[]
          p_excluded_teams?: string[]
          p_health?: string
          p_include_player_ids?: string[]
          p_league_id?: string
          p_limit?: number
          p_offset?: number
          p_playing_teams?: string[]
          p_position?: string
          p_query?: string
          p_rookies_only?: boolean
          p_season_year?: number
          p_sort_by?: string
          p_sort_dir?: string
          p_teams?: string[]
        }
        Returns: {
          avg_assists: number
          avg_blocks: number
          avg_fantasy_points: number
          avg_minutes_played: number
          avg_points: number
          avg_rebounds: number
          avg_steals: number
          avg_three_pointers_made: number
          avg_turnovers: number
          display_name: string
          eligible_positions: string[]
          games_played: number
          headshot_url: string
          id: string
          injury_status: string
          nba_id: string
          nba_team: string
          position: string
          projection_assists: number
          projection_blocks: number
          projection_date: string
          projection_fantasy_points: number
          projection_fetched_at: string
          projection_minutes: number
          projection_opponent: string
          projection_points: number
          projection_rebounds: number
          projection_source: string
          projection_source_label: string
          projection_status: string
          projection_steals: number
          projection_three_pointers_made: number
          projection_turnovers: number
          projection_view: string
          status: string
          years_exp: number
        }[]
      }
      set_player_slot_atomic: {
        Args: {
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
          p_player_id: string
          p_slot_type: Database["public"]["Enums"]["roster_slot_type"]
          p_week_number: number
        }
        Returns: undefined
      }
      set_player_slot_moves_atomic: {
        Args: {
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
          p_moves: Json
          p_week_number: number
        }
        Returns: undefined
      }
      set_player_slot_moves_atomic_unchecked: {
        Args: {
          p_game_date: string
          p_league_id: string
          p_league_season_id: string
          p_member_id: string
          p_moves: Json
          p_week_number: number
        }
        Returns: undefined
      }
      start_auction_draft_atomic: {
        Args: {
          p_budget_per_team?: number
          p_is_mock?: boolean
          p_league_id: string
          p_nomination_order_mode?: string
          p_pick_timer_seconds?: number
          p_timer_expiry_behavior?: string
        }
        Returns: {
          budget_per_team: number | null
          completed_at: string | null
          created_at: string
          created_by_member_id: string | null
          current_nomination_order: number
          draft_type: Database["public"]["Enums"]["draft_type"]
          id: string
          is_mock: boolean
          league_id: string
          league_season_id: string
          nomination_order_mode: string
          pause_reason: string | null
          paused_at: string | null
          pick_timer_seconds: number
          room_name: string | null
          rounds: number | null
          scheduled_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["draft_status"]
          timer_expiry_behavior: string
          timer_paused_remaining_seconds: number | null
        }
        SetofOptions: {
          from: "*"
          to: "drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_mock_draft_room_atomic: {
        Args: { p_draft_id: string; p_member_id: string; p_user_id: string }
        Returns: {
          budget_per_team: number | null
          completed_at: string | null
          created_at: string
          created_by_member_id: string | null
          current_nomination_order: number
          draft_type: Database["public"]["Enums"]["draft_type"]
          id: string
          is_mock: boolean
          league_id: string
          league_season_id: string
          nomination_order_mode: string
          pause_reason: string | null
          paused_at: string | null
          pick_timer_seconds: number
          room_name: string | null
          rounds: number | null
          scheduled_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["draft_status"]
          timer_expiry_behavior: string
          timer_paused_remaining_seconds: number | null
        }
        SetofOptions: {
          from: "*"
          to: "drafts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      start_rookie_draft_atomic: {
        Args: {
          p_is_mock?: boolean
          p_league_id: string
          p_pick_timer_seconds?: number
          p_rounds?: number
          p_timer_expiry_behavior?: string
        }
        Returns: Json
      }
      stop_draft_atomic: {
        Args: { p_actor_user_id?: string; p_draft_id: string }
        Returns: undefined
      }
      toggle_ir_atomic: {
        Args: {
          p_roster_player_id: string
          p_to_ir: boolean
          p_user_id: string
        }
        Returns: undefined
      }
      toggle_taxi_atomic: {
        Args: {
          p_roster_player_id: string
          p_to_taxi: boolean
          p_user_id: string
        }
        Returns: undefined
      }
      try_live_poll_lease: {
        Args: { p_lock_key: number; p_ttl_seconds?: number }
        Returns: string
      }
      try_live_poll_lock: { Args: never; Returns: boolean }
      update_league_configuration_atomic: {
        Args: { p_league_id: string; p_settings: Json; p_slots?: Json }
        Returns: undefined
      }
      update_league_settings_atomic: {
        Args: { p_league_id: string; p_settings: Json }
        Returns: undefined
      }
      update_lineup_slots_atomic: {
        Args: { p_league_id: string; p_slots: Json }
        Returns: undefined
      }
      update_lineup_slots_atomic_unchecked: {
        Args: { p_league_id: string; p_slots: Json }
        Returns: undefined
      }
      veto_trade_atomic: {
        Args: { p_member_id: string; p_trade_id: string }
        Returns: Json
      }
      withdraw_auction_nomination_atomic: {
        Args: {
          p_member_id: string
          p_nomination_id: string
          p_user_id: string
        }
        Returns: boolean
      }
      withdraw_trade_atomic: {
        Args: { p_member_id: string; p_trade_id: string; p_user_id: string }
        Returns: Json
      }
    }
    Enums: {
      draft_status:
        | "pending"
        | "in_progress"
        | "paused"
        | "completed"
        | "cancelled"
      draft_type: "auction" | "snake"
      league_member_role: "commissioner" | "co_commissioner" | "manager"
      league_status:
        | "setup"
        | "drafting"
        | "active"
        | "playoffs"
        | "offseason"
        | "archived"
      matchup_type:
        | "regular_season"
        | "playoff_quarterfinal"
        | "playoff_semifinal"
        | "playoff_final"
      nba_position: "PG" | "SG" | "SF" | "PF" | "C" | "G" | "F"
      nomination_status: "open" | "sold" | "no_bid" | "withdrawn"
      roster_slot_type:
        | "PG"
        | "SG"
        | "SF"
        | "PF"
        | "C"
        | "G"
        | "F"
        | "UTIL"
        | "BE"
        | "IR"
      rps_choice: "rock" | "paper" | "scissors"
      rps_status: "pending" | "completed"
      trade_side: "proposer" | "recipient"
      trade_status:
        | "pending"
        | "accepted"
        | "rejected"
        | "withdrawn"
        | "vetoed"
        | "completed"
        | "expired"
        | "countered"
        | "edited"
      veto_type: "commissioner" | "member"
      waiver_claim_status:
        | "pending"
        | "succeeded"
        | "failed_priority"
        | "failed_roster"
        | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      draft_status: [
        "pending",
        "in_progress",
        "paused",
        "completed",
        "cancelled",
      ],
      draft_type: ["auction", "snake"],
      league_member_role: ["commissioner", "co_commissioner", "manager"],
      league_status: [
        "setup",
        "drafting",
        "active",
        "playoffs",
        "offseason",
        "archived",
      ],
      matchup_type: [
        "regular_season",
        "playoff_quarterfinal",
        "playoff_semifinal",
        "playoff_final",
      ],
      nba_position: ["PG", "SG", "SF", "PF", "C", "G", "F"],
      nomination_status: ["open", "sold", "no_bid", "withdrawn"],
      roster_slot_type: [
        "PG",
        "SG",
        "SF",
        "PF",
        "C",
        "G",
        "F",
        "UTIL",
        "BE",
        "IR",
      ],
      rps_choice: ["rock", "paper", "scissors"],
      rps_status: ["pending", "completed"],
      trade_side: ["proposer", "recipient"],
      trade_status: [
        "pending",
        "accepted",
        "rejected",
        "withdrawn",
        "vetoed",
        "completed",
        "expired",
        "countered",
        "edited",
      ],
      veto_type: ["commissioner", "member"],
      waiver_claim_status: [
        "pending",
        "succeeded",
        "failed_priority",
        "failed_roster",
        "cancelled",
      ],
    },
  },
} as const

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
