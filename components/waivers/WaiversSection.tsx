import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { RosterView } from '@/lib/cache/view-types'
import { useAuth } from '@/hooks/use-auth'
import { useCallback, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { RosterClaimItem } from '@/components/roster/RosterItems'
import { Button, Card, usePageMetrics } from '@/components/ui'
import { SectionBand } from '@/components/ui/SectionBand'
import { cancelWaiverClaim, claimProcessDateLabel, editWaiverClaim, reorderWaiverClaim, scheduledClaimRunAt, type WaiverClaim } from '@/lib/waivers'
import { borderWidth, colors, layout, spacing, textStyles } from '@/constants/tokens'

export function WaiversSection({ active, onFindPlayer }: { active: boolean; onFindPlayer: () => void }) {
    const { current, currentLeague } = useLeagueContext()
    const { padX } = usePageMetrics()
    const { user } = useAuth()
    const router = useRouter()
    const online = useOnlineStatus()
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const scope = `${leagueId}:${memberId}`
    const currentScope = useRef(scope)
    currentScope.current = scope
    const view = useScreenView<RosterView>(user && memberId && leagueId ? screenScope('roster', leagueId, memberId, { section: 'waivers' }, user.id) : null, active)
    const refreshView = view.refresh
    const [busyId, setBusyId] = useState<string | null>(null)
    const busy = useRef(false)
    const [mutationError, setMutationError] = useState<string | null>(null)
    const error = mutationError ?? view.error?.message ?? null
    const setError = setMutationError
    const loading = view.loading
    const refresh = useCallback(async () => { await refreshView(true) }, [refreshView])
    const data = view.data ? { scope, claims: view.data.claims, state: view.data.transactionState, priority: view.data.waiverPriority } : null
    const mutate = async (id: string, operation: () => Promise<unknown>) => {
        if (busy.current) return
        busy.current = true
        setBusyId(id)
        try {
            await operation()
            if (currentScope.current === scope) await refresh()
            return currentScope.current === scope
        } catch (cause) {
            if (currentScope.current === scope) setError(cause instanceof Error ? cause.message : 'Could not update this claim. Try again.')
        } finally {
            busy.current = false
            setBusyId(null)
        }
    }
    const visible = data?.scope === scope ? data : null
    const pending = visible?.claims.filter(claim => claim.status === 'pending') ?? []
    const results = visible?.claims.filter(claim => claim.status !== 'pending') ?? []
    const renderClaim = (claim: WaiverClaim) => <View key={claim.id} style={styles.claim}>
        <RosterClaimItem claim={claim}
            onTimeline={() => current && router.push({ pathname: '/timeline', params: { memberId: current.id, entityId: claim.id, filter: 'claims' } })}
            cancellingId={busyId ? claim.id : null} waiverMode={currentLeague?.waiver_mode ?? 'rolling'}
            onCancel={id => { if (memberId) void mutate(id, () => cancelWaiverClaim(id, memberId)) }}
            onEditBid={async (item, bidAmount) => { if (memberId) return mutate(item.id, () => editWaiverClaim(item.id, memberId, { dropPlayerId: item.dropPlayerId, bidAmount })) }}
            onReorder={(id, direction) => { if (memberId) void mutate(id, () => reorderWaiverClaim(id, memberId, direction)) }} />
        {claim.status === 'pending' && scheduledClaimRunAt(claim.processDate, currentLeague?.timezone).getTime() > Date.now() ? <Button title="Edit claim and drop" variant="secondary" style={styles.editAction} accessibilityLabel={`Edit claim and drop for ${claim.playerName}`}
            disabled={Boolean(busyId)} onPress={() => router.push({ pathname: '/(modals)/claim-player', params: { playerId: claim.playerId, claimId: claim.id } })} /> : null}
    </View>
    return <ScrollView contentContainerStyle={[styles.root, { paddingHorizontal: padX }]}>
        <Card style={styles.summary}>
            <View style={styles.summaryRow}>
                <View style={styles.summaryStat}>
                    <Text style={textStyles.sectionLabel}>{currentLeague?.waiver_mode === 'faab' ? 'Available FAAB' : 'Waiver order'}</Text>
                    <Text style={textStyles.hero}>{currentLeague?.waiver_mode === 'faab' ? `$${visible?.state?.faabBalance ?? '—'}` : 'Rolling'}</Text>
                </View>
                <View style={styles.priority}>
                    <Text style={textStyles.sectionLabel}>Priority</Text>
                    <Text style={textStyles.compactScore}>#{visible?.priority ?? '—'}</Text>
                </View>
            </View>
            <View style={styles.schedule}>
                <Text style={textStyles.body}>Next run {claimProcessDateLabel(null, new Date(), currentLeague?.timezone)}</Text>
                {visible?.state ? <Text style={textStyles.meta}>Pickups {visible.state.weeklyAddCount}/{visible.state.weeklyAddLimit ?? '∞'} this week</Text> : null}
            </View>
            <Button title="Find a player to claim" icon="add" onPress={onFindPlayer} fullWidth />
        </Card>
        {!online ? <Text style={textStyles.meta}>Offline. Changes stay pending until you reconnect.</Text> : null}
        {error ? <Card><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Button title="Retry" variant="secondary" onPress={() => { void refresh() }} /></Card> : null}
        {loading && !visible ? <Text style={textStyles.meta}>Loading claims…</Text> : null}
        <Card padding="none" elevated="none" style={styles.section}>
            <SectionBand label={`Pending claims (${pending.length})`} />
            {pending.length ? pending.map(renderClaim) : visible ? <Text style={styles.empty}>No pending claims.</Text> : null}
        </Card>
        <Card padding="none" elevated="none" style={styles.section}>
            <SectionBand label="Recent results" />
            {results.length ? results.map(renderClaim) : visible ? <Text style={styles.empty}>No recent results.</Text> : null}
        </Card>
    </ScrollView>
}

const styles = StyleSheet.create({
    root: { width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center', paddingVertical: spacing.lg, gap: spacing.xl },
    summary: { gap: spacing.lg },
    summaryRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
    summaryStat: { flex: 1, minWidth: 0, gap: spacing.xs },
    priority: { alignItems: 'center', gap: spacing.xs, borderLeftWidth: borderWidth.thin, borderLeftColor: colors.borderLight, paddingLeft: spacing.xl },
    schedule: { gap: spacing.xs },
    section: { overflow: 'hidden' },
    claim: { borderBottomWidth: borderWidth.thin, borderBottomColor: colors.separator },
    editAction: { marginHorizontal: spacing.lg, marginBottom: spacing.lg },
    empty: { ...textStyles.meta, padding: spacing.lg },
    error: { ...textStyles.body, color: colors.dangerDark },
})
