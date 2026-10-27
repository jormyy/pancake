import { readScreenView } from '@/lib/cache/screen-cache'
import { screenScope } from '@/lib/cache/screen-scope'
import { useEffect, useState } from 'react'
import { type RosterPlayer } from '@/lib/roster'
import { type Trade, type TradeRosterPlan, type TradeRosterPreview } from '@/lib/trades'
import { TradeRosterPreviewList } from './TradeRosterPreviewList'
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
    const leagueId = currentLeague?.id
    const [preview, setPreview] = useState<TradeRosterPreview[]>([])
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const [error, setError] = useState<string | null>(null)
    useEffect(() => {
        if (!leagueId) return
        let cancelled = false
        setPreview([])
        setError(null)
        readScreenView<{ roster: RosterPlayer[]; rosterPreview: TradeRosterPreview[] }>(screenScope('trade-details', leagueId, memberId, { tradeId: trade.id })).then(({ roster: rows, rosterPreview: teams }) => {
            if (!cancelled) { setRoster(rows); setPreview(teams) }
        }).catch(() => { if (!cancelled) setError('Could not load drop choices. Reopen the trade to retry.') })
        return () => { cancelled = true }
    }, [leagueId, memberId, trade])
    if (!currentLeague) return null
    const incoming = trade.routedItems.filter((item) => item.toMemberId === memberId)
    const offered = new Set(trade.routedItems.flatMap((item) => item.kind === 'player' ? [item.playerId] : []))
    const plan: TradeRosterPlan = {
        taxiPlayerIds: incoming.flatMap((item) => item.kind === 'player' && item.toTaxi ? [item.playerId] : []),
        irPlayerIds: incoming.flatMap((item) => item.kind === 'player' && item.toIR ? [item.playerId] : []),
        rosterMoves: trade.participants.find((participant) => participant.memberId === memberId)?.rosterMoves ?? [],
        dropPlayerIds: trade.participants.find((participant) => participant.memberId === memberId)?.dropPlayerIds ?? [],
    }
    return <>
        {error ? <Text>{error}</Text> : null}
        <TradeRosterPreviewList teams={preview} />
        <TradeRosterPlanEditor incoming={incoming} roster={roster.filter((player) => !offered.has(player.players.id))}
            value={plan} onChange={onChange} disabled={disabled || preview.length === 0}
            unavailableMoves={preview.find((team) => team.memberId === memberId)?.unavailableMoves}
            unavailableDestinations={preview.find((team) => team.memberId === memberId)?.unavailableDestinations}
            allowIR={currentLeague.ir_slots > 0} allowTaxi={(currentLeague.taxi_slots ?? 0) > 0} />
    </>
}
