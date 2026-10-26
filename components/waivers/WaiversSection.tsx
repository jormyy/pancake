import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { RosterClaimItem } from '@/components/roster/RosterItems'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'
import { listenForMemberClaimsChanges } from '@/lib/claim-updates'
import { deferLeagueRefresh, leagueResourceAffects, listenForLeagueChanges } from '@/lib/league-changes'
import { cancelWaiverClaim, claimProcessDateLabel, editWaiverClaim, getMyWaiverClaims, getMyWaiverPriority, reorderWaiverClaim, scheduledClaimRunAt, type WaiverClaim } from '@/lib/waivers'
import { colors, spacing, textStyles } from '@/constants/tokens'

export function WaiversSection({ active }: { active: boolean }) {
    const { current, currentLeague } = useLeagueContext()
    const router = useRouter()
    const online = useOnlineStatus()
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const scope = `${leagueId}:${memberId}`
    const currentScope = useRef(scope)
    currentScope.current = scope
    const sequence = useRef(0)
    const busy = useRef(false)
    const [data, setData] = useState<{ scope: string; claims: WaiverClaim[]; state: MemberTransactionState | null; priority: number | null } | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [busyId, setBusyId] = useState<string | null>(null)
    const refresh = useCallback(async () => {
        if (!active || !online || !memberId || !leagueId) return
        const request = ++sequence.current
        setLoading(true)
        try {
            const [claims, state, priority] = await Promise.all([
                getMyWaiverClaims(memberId, leagueId),
                getMemberTransactionState(memberId, leagueId),
                getMyWaiverPriority(memberId, leagueId),
            ])
            if (sequence.current !== request || currentScope.current !== scope) return
            setData({ scope, claims, state, priority })
            setError(null)
        } catch (cause) {
            if (sequence.current === request && currentScope.current === scope) setError(cause instanceof Error ? cause.message : 'Could not load claims. Try again.')
        } finally {
            if (sequence.current === request && currentScope.current === scope) setLoading(false)
        }
    }, [active, online, memberId, leagueId, scope])
    useEffect(() => {
        void refresh()
        if (!active || !memberId || !leagueId) return
        const deferred = deferLeagueRefresh(() => { void refresh() })
        const stopClaims = listenForMemberClaimsChanges(memberId, deferred.trigger)
        const stopLeague = listenForLeagueChanges(leagueId, change => {
            if (change.topic === 'roster' || leagueResourceAffects(change, ['claims', 'waivers', 'priority', 'faab', 'season'], { memberId })) deferred.trigger()
        })
        return () => { sequence.current += 1; stopClaims(); stopLeague(); deferred.cancel() }
    }, [active, memberId, leagueId, online, refresh])
    const mutate = async (id: string, operation: () => Promise<unknown>) => {
        if (!online || busy.current) return
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
        <RosterClaimItem claim={claim} cancellingId={!online || busyId ? claim.id : null} waiverMode={currentLeague?.waiver_mode ?? 'rolling'}
            onCancel={id => { if (memberId) void mutate(id, () => cancelWaiverClaim(id, memberId)) }}
            onEditBid={async (item, bidAmount) => { if (memberId) return mutate(item.id, () => editWaiverClaim(item.id, memberId, { dropPlayerId: item.dropPlayerId, bidAmount })) }}
            onReorder={(id, direction) => { if (memberId) void mutate(id, () => reorderWaiverClaim(id, memberId, direction)) }} />
        {claim.status === 'pending' && scheduledClaimRunAt(claim.processDate).getTime() > Date.now() ? <Pressable style={styles.action} accessibilityRole="button" accessibilityLabel={`Edit claim and drop for ${claim.playerName}`}
            disabled={!online || Boolean(busyId)} onPress={() => router.push({ pathname: '/(modals)/claim-player', params: { playerId: claim.playerId, claimId: claim.id } })}>
            <Text style={styles.link}>Edit claim and drop</Text>
        </Pressable> : null}
    </View>
    return <ScrollView contentContainerStyle={styles.root}>
        <Text style={textStyles.sectionLabel}>Waivers</Text>
        <Text style={textStyles.body}>{currentLeague?.waiver_mode === 'faab' ? `Available FAAB $${visible?.state?.faabBalance ?? '—'}` : 'Rolling waiver priority'} · Priority #{visible?.priority ?? '—'}</Text>
        <Text style={textStyles.meta}>Next run {claimProcessDateLabel(null)}. Dropped players wait at least 48 hours.</Text>
        {visible?.state ? <Text style={textStyles.meta}>Successful pickups {visible.state.weeklyAddCount}/{visible.state.weeklyAddLimit ?? '∞'} this scoring week.</Text> : null}
        <Text style={textStyles.meta}>Bids stay private until processing. Higher bids go first. Claim order decides between your equal bids.</Text>
        <Pressable style={styles.action} accessibilityRole="button" onPress={() => router.push('/players?section=players')}><Text style={styles.link}>Find a player to claim</Text></Pressable>
        {!online ? <Text style={textStyles.meta}>Offline. Connect to change claims.</Text> : null}
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
    action: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
    link: { ...textStyles.body, color: colors.primaryDark },
    error: { ...textStyles.body, color: colors.dangerDark },
})
