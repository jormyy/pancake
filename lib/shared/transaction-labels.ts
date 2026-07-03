/**
 * Leaf module: human-readable labels for roster transaction types.
 *
 * Kept dependency-free so it can be imported by both `lib/players.ts` and
 * `lib/transactions.ts` without creating a cycle.
 */
export const TRANSACTION_LABELS: Record<string, string> = {
    fa_add: 'Added',
    fa_drop: 'Dropped',
    waiver_add: 'Claimed',
    waiver_drop: 'Dropped',
    trade_in: 'Acquired via Trade',
    trade_out: 'Traded Away',
    ir_designate: 'Placed on IR',
    ir_return: 'Activated from IR',
    taxi_designate: 'Placed on Taxi Squad',
    taxi_return: 'Activated from Taxi Squad',
    draft_won: 'Drafted',
    carry_over: 'Carried Over',
}

// Human category chips for system `league_activity` events (League History
// feed). Covers every event_type written by the SQL functions in
// supabase/sql/functions (trade-negotiation, waivers-and-adds,
// dynasty-transactions); unknown types fall back to 'Activity'.
const ACTIVITY_EVENT_CATEGORIES: Record<string, string> = {
    trade_block_updated: 'Trade',
    trade_offered: 'Trade',
    trade_countered: 'Trade',
    trade_edited: 'Trade',
    trade_completed: 'Trade',
    trade_expired: 'Trade',
    waiver_claim_succeeded: 'Waivers',
    waiver_claim_failed_priority: 'Waivers',
    faab_bid_won: 'Waivers',
    faab_bid_lost: 'Waivers',
    free_agent_added: 'Roster',
    commissioner_faab_adjusted: 'League',
    commissioner_add_count_override: 'League',
}

export function activityEventCategory(eventType: string): string {
    return ACTIVITY_EVENT_CATEGORIES[eventType] ?? 'Activity'
}
