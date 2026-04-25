import { ScrollView, Pressable, Text, StyleSheet } from 'react-native'
import { colors } from '@/constants/tokens'

export type LeagueSwitcherMembership = {
    id: string
    leagues?: { name: string | null } | null
}

export function LeagueSwitcher({
    memberships,
    currentId,
    onSelect,
}: {
    memberships: LeagueSwitcherMembership[]
    currentId: string | undefined
    onSelect: (m: LeagueSwitcherMembership) => void
}) {
    if (memberships.length <= 1) return null

    return (
        <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.switcherRow}
            contentContainerStyle={styles.switcherContent}
        >
            {memberships.map((m) => {
                const isActive = m.id === currentId
                return (
                    <Pressable
                        key={m.id}
                        style={[styles.switcherChip, isActive && styles.switcherChipActive]}
                        onPress={() => onSelect(m)}
                    >
                        <Text style={[styles.switcherText, isActive && styles.switcherTextActive]}>
                            {m.leagues?.name ?? 'League'}
                        </Text>
                    </Pressable>
                )
            })}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    switcherRow: { maxHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    switcherContent: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        gap: 8,
        paddingVertical: 8,
    },
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
