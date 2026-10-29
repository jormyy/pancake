import { tradeRosterPlanKey } from '@/lib/trade-roster-preview'
import { useEffect, useMemo, useState } from 'react'
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { getRoster, type RosterPlayer } from '@/lib/roster'
import { acceptTrade, setTradeRosterPlan, type Trade, type TradeRosterPlan, type TradeRosterPreview } from '@/lib/trades'
import { prefillTradeRosterPlan } from '@/lib/trade-composer'
import { previewTradeLegality } from '@/lib/trade-legality'
import { isTradeRosterLegal } from '@/lib/trade-legality-step'
import { getErrorMessage } from '@/lib/shared/errors'
import { TradeRosterPreviewList } from './TradeRosterPreviewList'
import { useLeagueContext } from '@/contexts/league-context'
import { TradeRosterPlanEditor } from './TradeRosterPlanEditor'
import { Button, ErrorBanner, PageHeader } from '@/components/ui'
import { colors, spacing, textStyles } from '@/constants/tokens'

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
    const offered = new Set(trade.routedItems.flatMap(item => item.kind === 'player' ? [item.playerId] : []))
    const own = preview.find(team => team.memberId === memberId)
    const legal = preview.length > 0 && preview.every(isTradeRosterLegal)
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
            <PageHeader title="Make it legal" titleIsPageHeading actions={<Button title="Cancel" variant="secondary" onPress={onCancel} />} />
            <ScrollView contentContainerStyle={styles.content}>
                <Text style={textStyles.body}>Preview your roster after the trade. Your choices take effect together after the review window.</Text>
                {error ? <ErrorBanner message={error} onRetry={() => setAttempt(value => value + 1)} /> : null}
                <TradeRosterPreviewList teams={preview} />
                <TradeRosterPlanEditor incoming={incoming} roster={roster.filter(row => !offered.has(row.players.id))}
                    value={plan} onChange={setPlan} preview={own} disabled={saving || !own}
                    unavailableMoves={own?.unavailableMoves} unavailableDestinations={own?.unavailableDestinations} />
            </ScrollView>
            <View style={styles.confirm}>
                <Text style={textStyles.meta}>{loading ? 'Checking roster…' : legal ? 'Ready for review. Nothing moves yet.' : 'Resolve the rules above to continue.'}</Text>
                <Button title="Confirm" onPress={confirm} disabled={loading || saving || Boolean(error) || !legal} loading={saving} />
            </View>
        </SafeAreaView>
    </Modal>
}

const styles = StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bgScreen },
    content: { padding: spacing.lg, gap: spacing.lg },
    confirm: { padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.bgCard },
})
