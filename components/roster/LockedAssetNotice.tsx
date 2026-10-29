import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { borderWidth, colors, controlSize, radii, spacing, textStyles } from '@/constants/tokens'
import { lockLink, type AssetLock } from '@/lib/locked-assets'

export function LockedAssetNotice({ locks, onNavigate }: { locks: readonly AssetLock[]; onNavigate?: () => void }) {
    const router = useRouter()
    const sources = [...new Map(locks.map(lock => [`${lock.sourceKind}:${lock.sourceId}`, lock])).values()]
    if (!sources.length) return null
    return <View style={styles.root}>
        <View style={styles.badge} accessibilityLabel="Asset locked">
            <MaterialIcons name="lock" size={controlSize.icon.sm} color={colors.textSecondary} />
            <Text style={styles.label}>Locked</Text>
        </View>
        {sources.map(lock => <Pressable key={`${lock.sourceKind}:${lock.sourceId}`} style={styles.link}
            accessibilityRole="link" accessibilityLabel={lock.reason}
            onPress={() => { onNavigate?.(); router.push(lockLink(lock) as Parameters<typeof router.push>[0]) }}>
            <Text style={styles.reason} numberOfLines={1}>{lock.reason}</Text>
        </Pressable>)}
    </View>
}

const styles = StyleSheet.create({
    root: { paddingHorizontal: spacing.sm, paddingBottom: spacing.xs, gap: spacing.xxs },
    badge: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: spacing.xxs,
        paddingHorizontal: spacing.xs, paddingVertical: spacing.xxs, borderRadius: radii.xs,
        borderWidth: borderWidth.thin, borderColor: colors.border, backgroundColor: colors.bgSubtle },
    label: { ...textStyles.meta, color: colors.textSecondary },
    link: { minHeight: controlSize.minTouch, justifyContent: 'center' },
    reason: { ...textStyles.meta, color: colors.primaryDark, textDecorationLine: 'underline' },
})
