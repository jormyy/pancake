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
