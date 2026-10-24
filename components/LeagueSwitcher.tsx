import { ScrollView, Text, StyleSheet } from 'react-native'
import { colors, controlSize, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

type LeagueSwitcherMembership = {
    id: string
    leagues?: { name: string | null } | null
}

export function LeagueSwitcher({
    memberships,
    currentId,
    onSelect,
    compact = false,
}: {
    memberships: LeagueSwitcherMembership[]
    currentId: string | undefined
    onSelect: (m: LeagueSwitcherMembership) => void
    compact?: boolean
}) {
    if (memberships.length <= 1) return null

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={[styles.switcherRow, compact && styles.switcherRowCompact]}
            contentContainerStyle={[styles.switcherContent, compact && styles.switcherContentCompact]}
        >
            {memberships.map((m) => {
                const isActive = m.id === currentId
                return (
                    <MotionPressable
                        key={m.id}
                        style={[styles.switcherChip, isActive && styles.switcherChipActive]}
                        onPress={() => onSelect(m)}
                        accessibilityRole="button"
                        accessibilityLabel={`Switch to ${m.leagues?.name ?? 'League'}`}
                        accessibilityState={{ selected: isActive }}
                        hitSlop={spacing.md}
                    >
                        <Text style={[styles.switcherText, isActive && styles.switcherTextActive]}>
                            {m.leagues?.name ?? 'League'}
                        </Text>
                    </MotionPressable>
                )
            })}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    switcherRow: { maxHeight: controlSize.button.md.height, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    switcherRowCompact: { maxHeight: controlSize.minTouch },
    switcherContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        gap: spacing.md,
        paddingVertical: spacing.md,
    },
    switcherContentCompact: { paddingVertical: spacing.xs },
    switcherChip: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.full,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    switcherChipActive: { backgroundColor: colors.primary },
    switcherText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    switcherTextActive: { color: colors.textWhite },
})
