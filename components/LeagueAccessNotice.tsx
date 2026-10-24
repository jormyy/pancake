import { Platform, StyleSheet, Text, View } from 'react-native'
import { useLeagueContext } from '@/contexts/league-context'
import { ErrorBanner } from '@/components/ui'
import { colors, fontSize, spacing, type WebOnlyViewStyle } from '@/constants/tokens'

export function LeagueAccessNotice() {
    const { memberships, membershipError, online, refresh } = useLeagueContext()
    if (memberships.length === 0 || (online && !membershipError)) return null
    return (
        <View style={[styles.overlay, Platform.OS === 'web' && styles.webOverlay]} pointerEvents="box-none" role="status" aria-live="polite" accessibilityLiveRegion="polite">
            {online ? <ErrorBanner message="League access could not be checked. Tap to retry." onRetry={() => { void refresh() }} /> : (
                <View style={styles.notice}>
                    <Text style={styles.text}>Offline · showing saved data</Text>
                </View>
            )}
        </View>
    )
}

const styles = StyleSheet.create({
    overlay: { position: 'absolute', bottom: spacing.sm, left: spacing.lg, right: spacing.lg, zIndex: 1000, alignItems: 'center' },
    webOverlay: { position: 'fixed', bottom: 'calc(72px + env(safe-area-inset-bottom, 0px))' } as unknown as WebOnlyViewStyle,
    notice: { paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, backgroundColor: colors.bgSubtle },
    text: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center' },
})
