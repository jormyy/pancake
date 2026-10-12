import { StyleSheet, Text, View } from 'react-native'
import { useLeagueContext } from '@/contexts/league-context'
import { ErrorBanner } from '@/components/ui'
import { colors, fontSize, spacing } from '@/constants/tokens'

export function LeagueAccessNotice() {
    const { memberships, membershipError, online, refresh } = useLeagueContext()
    if (memberships.length === 0 || (online && !membershipError)) return null
    if (online) {
        return <ErrorBanner message="League access could not be checked. Tap to retry." onRetry={() => { void refresh() }} />
    }
    return (
        <View style={styles.notice} accessibilityLiveRegion="polite">
            <Text style={styles.text}>Offline · League access is unverified.</Text>
        </View>
    )
}

const styles = StyleSheet.create({
    notice: { paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, backgroundColor: colors.bgSubtle },
    text: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
})
