import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { RosterView } from '@/lib/cache/view-types'
import { useAuth } from '@/hooks/use-auth'
import { useCallback, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { RosterClaimItem } from '@/components/roster/RosterItems'
import { cancelWaiverClaim, claimProcessDateLabel, editWaiverClaim, reorderWaiverClaim, scheduledClaimRunAt, type WaiverClaim } from '@/lib/waivers'
import { colors, controlSize, spacing, textStyles } from '@/constants/tokens'

export function WaiversSection({ active, onFindPlayer }: { active: boolean; onFindPlayer: () => void }) {
    const { current, currentLeague } = useLeagueContext()
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
        {claim.status === 'pending' && scheduledClaimRunAt(claim.processDate).getTime() > Date.now() ? <Pressable style={styles.action} accessibilityRole="button" accessibilityLabel={`Edit claim and drop for ${claim.playerName}`}
            disabled={Boolean(busyId)} onPress={() => router.push({ pathname: '/(modals)/claim-player', params: { playerId: claim.playerId, claimId: claim.id } })}>
            <Text style={styles.link}>Edit claim and drop</Text>
        </Pressable> : null}
    </View>
    return <ScrollView contentContainerStyle={styles.root}>
        <Text style={textStyles.sectionLabel}>Waivers</Text>
        <Text style={textStyles.body}>{currentLeague?.waiver_mode === 'faab' ? `Available FAAB $${visible?.state?.faabBalance ?? '—'}` : 'Rolling waiver priority'} · Priority #{visible?.priority ?? '—'}</Text>
        <Text style={textStyles.meta}>Next run {claimProcessDateLabel(null)}</Text>
        {visible?.state ? <Text style={textStyles.meta}>Pickups {visible.state.weeklyAddCount}/{visible.state.weeklyAddLimit ?? '∞'} this week</Text> : null}
        <Pressable style={styles.action} accessibilityRole="button" onPress={onFindPlayer}><Text style={styles.link}>Find a player to claim</Text></Pressable>
        {!online ? <Text style={textStyles.meta}>Offline. Changes stay pending until you reconnect.</Text> : null}
        {error ? <View><Text accessibilityRole="alert" style={styles.error}>{error}</Text><Pressable style={styles.action} accessibilityRole="button" onPress={() => { void refresh() }}><Text style={styles.link}>Retry</Text></Pressable></View> : null}
        {loading && !visible ? <Text style={textStyles.meta}>Loading claims…</Text> : null}
        <Text style={textStyles.sectionLabel}>Pending claims ({pending.length})</Text>
        {pending.length ? pending.map(renderClaim) : visible ? <Text style={textStyles.meta}>No pending claims.</Text> : null}
        <Text style={textStyles.sectionLabel}>Recent results</Text>
        {results.length ? results.map(renderClaim) : visible ? <Text style={textStyles.meta}>No recent results.</Text> : null}
    </ScrollView>
}

const styles = StyleSheet.create({
    root: { padding: spacing.lg, gap: spacing.md },
    claim: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    action: { minHeight: controlSize.minTouch, minWidth: controlSize.minTouch, justifyContent: 'center', alignSelf: 'flex-start' },
    link: { ...textStyles.body, color: colors.primaryDark },
    error: { ...textStyles.body, color: colors.dangerDark },
})
