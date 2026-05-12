import { supabase } from '../lib/supabase'

export async function processAcceptedTrades(): Promise<{ processed: number; failed: number; failures: string[] }> {
    const { data: trades, error } = await supabase
        .from('trades')
        .select('id')
        .eq('status', 'accepted')
        .lte('veto_window_expires_at', new Date().toISOString())

    if (error) throw error

    let processed = 0
    let failed = 0
    const failures: string[] = []
    for (const trade of trades ?? []) {
        const { error: completeError } = await supabase.rpc('complete_accepted_trade_atomic', {
            p_trade_id: trade.id,
        })
        if (completeError) {
            failed += 1
            failures.push(`Trade ${trade.id}: ${completeError.message}`)
        } else {
            processed += 1
        }
    }

    return { processed, failed, failures }
}
