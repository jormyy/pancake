import { tradeRosterPlanKey } from '@/lib/trade-roster-preview'
import { useEffect, useMemo, useState } from 'react'
import { Modal, StyleSheet } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { getRosterStatsMaps, type RosterStatsMaps } from '@/lib/roster-stats'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { acceptTrade, setTradeRosterPlan, type Trade, type TradeRosterPlan, type TradeRosterPreview } from '@/lib/trades'
import { prefillTradeRosterPlan } from '@/lib/trade-composer'
import { previewTradeLegality } from '@/lib/trade-legality'
import { isTradeRosterLegal } from '@/lib/trade-legality-step'
import { getErrorMessage } from '@/lib/shared/errors'
import { TradeLegalityScreen } from './TradeLegalityScreen'
import { useLeagueContext } from '@/contexts/league-context'
import { colors } from '@/constants/tokens'

export function PendingTradeRosterPlan({ trade, memberId, onCancel, onConfirmed }: {
    trade: Trade
    memberId: string
    onCancel: () => void
    onConfirmed: () => void
}) {
    const { currentLeague } = useLeagueContext()
    const leagueId = currentLeague?.id
    const [plan, setPlan] = useState<TradeRosterPlan>(() => prefillTradeRosterPlan(trade, memberId))
    const owner = JSON.stringify([leagueId, memberId, trade.id])
    const [result, setResult] = useState<{ owner: string; key: string; teams: TradeRosterPreview[] } | null>(null)
    const preview = result?.owner === owner ? result.teams : []
    const [roster, setRoster] = useState<RosterPlayer[]>([])
    const [stats, setStats] = useState<RosterStatsMaps>()
    const [error, setError] = useState<string | null>(null)
    const [attempt, setAttempt] = useState(0)
    const [saving, setSaving] = useState(false)
    const serializedPlan = JSON.stringify(plan)
    const requestKey = JSON.stringify([tradeRosterPlanKey(trade), serializedPlan])
    const loading = result?.owner !== owner || result.key !== requestKey
    useEffect(() => {
        if (!leagueId) return
        let cancelled = false
        void getRoster(memberId, leagueId).then(rows => { if (!cancelled) setRoster(rows) })
            .catch(error => { if (!cancelled) setError(getErrorMessage(error)) })
        return () => { cancelled = true }
    }, [leagueId, memberId])
    useEffect(() => {
        if (!leagueId) return
        let cancelled = false
        const timer = setTimeout(() => {
            void previewTradeLegality({ leagueId, tradeId: trade.id, plans: { [memberId]: JSON.parse(serializedPlan) } }).then(teams => {
                if (!cancelled) { setResult({ owner, key: requestKey, teams }); setError(null) }
            }).catch(error => { if (!cancelled) { setError(getErrorMessage(error)) } })
        }, 150)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [leagueId, memberId, serializedPlan, trade, attempt, owner, requestKey])
    const incoming = useMemo(() => trade.routedItems.filter(item => item.toMemberId === memberId), [trade, memberId])
    useEffect(() => {
        if (!leagueId) return
        let cancelled = false
        const ids = [...roster.map(row => row.players.id), ...incoming.flatMap(item => item.kind === 'player' ? [item.playerId] : [])]
        void getRosterStatsMaps(ids, leagueId).then(value => { if (!cancelled) setStats(value) })
            .catch(() => { if (!cancelled) setStats(undefined) })
        return () => { cancelled = true }
    }, [incoming, leagueId, roster])
    const offered = new Set(trade.routedItems.flatMap(item => item.kind === 'player' ? [item.playerId] : []))
    const own = preview.find(team => team.memberId === memberId)
    const legal = isTradeRosterLegal(own)
    const confirm = async () => {
        if (saving || loading || error || !legal || !leagueId) return
        setSaving(true)
        try {
            if (trade.status === 'accepted') await setTradeRosterPlan(trade.id, memberId, plan)
            else await acceptTrade(trade.id, memberId, plan)
            onConfirmed()
        } catch (error) {
            setError(getErrorMessage(error))
            const teams = await previewTradeLegality({ leagueId, tradeId: trade.id, plans: { [memberId]: plan } }).catch(() => null)
            if (teams) setResult({ owner, key: requestKey, teams })
        } finally { setSaving(false) }
    }
    return <Modal visible animationType="slide" onRequestClose={onCancel}>
        <SafeAreaView style={styles.root}>
            <TradeLegalityScreen trade={trade} memberId={memberId} teams={preview} loading={loading} saving={saving}
                error={error} onRetry={() => setAttempt(value => value + 1)} onClose={onCancel} onSubmit={confirm} mode="accept"
                editor={{ incoming, avgMap: stats?.avgMap, avgStatsMap: stats?.avgStatsMap, roster: roster.filter(row => !offered.has(row.players.id)), value: plan, onChange: setPlan,
                    allowIR: (currentLeague?.ir_slots ?? 0) > 0, allowTaxi: (currentLeague?.taxi_slots ?? 0) > 0,
                    unavailableMoves: own?.unavailableMoves, unavailableDestinations: own?.unavailableDestinations }} />
        </SafeAreaView>
    </Modal>
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bgScreen },
})
