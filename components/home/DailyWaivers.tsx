import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useScreenView } from '@/hooks/use-screen-view'
import { screenScope } from '@/lib/cache/screen-scope'
import type { RosterView } from '@/lib/cache/view-types'
import { claimProcessDateLabel, scheduledClaimLabel, scheduledClaimRunAt } from '@/lib/waivers'


export function DailyWaivers() {
    const { current, currentLeague, membershipValidated, membershipError, online } = useLeagueContext()
    const { user } = useAuth()
    const router = useRouter()
    const memberId = current?.id
    const leagueId = currentLeague?.id
    const authorized = Boolean(user && memberId && leagueId && membershipValidated && !membershipError)
    const { data, error, refresh } = useScreenView<RosterView>(user?.id && memberId && leagueId
        ? screenScope('roster', leagueId, memberId, {}, user.id) : null, authorized)
    const pending = data?.claims.filter(claim => claim.status === 'pending') ?? []
    const nextClaim = [...pending].sort((a, b) => a.processDate.localeCompare(b.processDate))[0]
    const runDue = nextClaim && scheduledClaimRunAt(nextClaim.processDate, currentLeague?.timezone).getTime() <= Date.now()
    return (
        <View style={styles.panel} accessibilityLabel="Today's waivers">
            <Text style={textStyles.sectionLabel} accessibilityRole="header">Waivers</Text>
            <Text style={textStyles.body}>{data ? `${pending.length} pending claim${pending.length === 1 ? '' : 's'}` : 'Claims unavailable'}</Text>
            <Text style={textStyles.body}>{runDue ? 'Claims are due for processing' : `Next run ${nextClaim ? scheduledClaimLabel(nextClaim.processDate, currentLeague?.timezone) : claimProcessDateLabel(null, new Date(), currentLeague?.timezone)}`}</Text>
            <Text style={textStyles.body}>{currentLeague?.waiver_mode === 'faab'
                ? `FAAB left $${data?.transactionState?.faabBalance ?? '—'}`
                : `Waiver priority #${data?.waiverPriority ?? '—'}`}</Text>
            {!online ? <Text style={textStyles.meta}>Offline. Connect to update claims.</Text> : null}
            {error ? <Button title="Retry waivers" variant="ghost" onPress={() => { void refresh(true) }} /> : null}
            <View style={styles.actions}>
                <Button title="Find a player to claim" onPress={() => router.push('/players?section=players')} />
                <Button title="Manage claims" variant="outline" onPress={() => router.push('/players?section=waivers')} />
            </View>
            {pending.slice(0, 3).map(claim => <Button key={claim.id} title={`Edit claim: ${claim.playerName}`} variant="ghost"
                onPress={() => router.push({ pathname: '/(modals)/claim-player', params: { playerId: claim.playerId, claimId: claim.id } })} />)}
        </View>
    )
}

const styles = StyleSheet.create({
    panel: { padding: spacing.lg, gap: spacing.sm, borderTopWidth: 1, borderColor: colors.borderLight },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
})
