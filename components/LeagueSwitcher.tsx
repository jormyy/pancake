import { ScrollView, Text, StyleSheet } from 'react-native'
import { colors } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'

export type LeagueSwitcherMembership = {
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
                        pressedScale={0.94}
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
    switcherRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    switcherRowCompact: { maxHeight: 38 },
    switcherContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 8,
        paddingVertical: 8,
    },
    switcherContentCompact: { paddingVertical: 5 },
    switcherChip: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    switcherChipActive: { backgroundColor: colors.primary },
    switcherText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
    switcherTextActive: { color: colors.textWhite },
})
