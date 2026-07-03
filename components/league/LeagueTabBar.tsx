import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { LEAGUE_TABS, type LeagueTab } from '@/lib/league/tabs'

type LeagueTabBarProps = {
    activeTab: LeagueTab
    onTabChange: (tab: LeagueTab) => void
}

export function LeagueTabBar({ activeTab, onTabChange }: LeagueTabBarProps) {
    return (
        <View style={styles.tabRow}>
            {LEAGUE_TABS.map((tab) => (
                <Pressable
                    key={tab.key}
                    style={[styles.tabChip, activeTab === tab.key && styles.tabChipActive]}
                    onPress={() => onTabChange(tab.key)}
                >
                    <Text style={[styles.tabChipText, activeTab === tab.key && styles.tabChipTextActive]}>
                        {tab.label}
                    </Text>
                </Pressable>
            ))}
        </View>
    )
}

const styles = StyleSheet.create({
    tabRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: spacing.sm,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    tabChip: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    tabChipActive: { backgroundColor: colors.primary },
    tabChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    tabChipTextActive: { color: colors.textWhite },
})
