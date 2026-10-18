import { useEffect, useState } from 'react'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import type { Trade, TradeRosterPlan } from '@/lib/trades'
import { useLeagueContext } from '@/contexts/league-context'
import { Text } from 'react-native'
import { TradeRosterPlanEditor } from './TradeRosterPlanEditor'

export function PendingTradeRosterPlan({ trade, memberId, onChange, disabled }: {
    trade: Trade
    memberId: string
    onChange: (plan: TradeRosterPlan) => void
    disabled: boolean
}) {
    const { currentLeague } = useLeagueContext()
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (!currentLeague?.allow_inactive_trades) return
        let cancelled = false
        getRoster(memberId, currentLeague.id).then((rows) => {
            if (!cancelled) setRoster(rows)
        }).catch(() => { if (!cancelled) setError('Could not load drop choices. Reopen the trade to retry.') })
        return () => { cancelled = true }
    }, [currentLeague?.allow_inactive_trades, currentLeague?.id, memberId])
    if (!currentLeague?.allow_inactive_trades) return null
    const incoming = trade.routedItems.filter((item) => item.toMemberId === memberId)
    const offered = new Set(trade.routedItems.flatMap((item) => item.kind === 'player' ? [item.playerId] : []))
    const plan: TradeRosterPlan = {
        taxiPlayerIds: incoming.flatMap((item) => item.kind === 'player' && item.toTaxi ? [item.playerId] : []),
        irPlayerIds: incoming.flatMap((item) => item.kind === 'player' && item.toIR ? [item.playerId] : []),
        dropPlayerIds: trade.participants.find((participant) => participant.memberId === memberId)?.dropPlayerIds ?? [],
    }
    return <>
        {error ? <Text>{error}</Text> : null}
        <TradeRosterPlanEditor incoming={incoming} roster={roster.filter((player) => !offered.has(player.players.id))}
            value={plan} onChange={onChange} disabled={disabled} />
    </>
}
