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

    const results = await Promise.allSettled(
        (trades ?? []).map((trade) =>
            supabase
                .rpc('complete_accepted_trade_atomic', { p_trade_id: trade.id })
                .then((res) => ({ tradeId: trade.id, error: res.error })),
        ),
    )

    for (const r of results) {
        if (r.status === 'fulfilled') {
            if (r.value.error) {
                failed += 1
                failures.push(`Trade ${r.value.tradeId}: ${r.value.error.message}`)
            } else {
                processed += 1
            }
        } else {
            failed += 1
            failures.push(`Trade <unknown>: ${r.reason?.message ?? String(r.reason)}`)
        }
    }

    return { processed, failed, failures }
}
