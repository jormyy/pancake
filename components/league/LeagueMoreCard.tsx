import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import type { ComponentProps } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { Card } from '@/components/ui/Card'
import { SectionBand } from '@/components/ui/SectionBand'
import { colors, controlSize, layout, motion, spacing, textStyles } from '@/constants/tokens'
import type { LeagueSection } from '@/lib/league/tabs'

type IconName = ComponentProps<typeof MaterialIcons>['name']

const MORE_ITEMS: readonly { key: LeagueSection; label: string; icon: IconName }[] = [
    { key: 'history', label: 'Activity', icon: 'swap-horiz' },
    { key: 'picks', label: 'Picks', icon: 'sports-basketball' },
    { key: 'seasons', label: 'History', icon: 'emoji-events' },
    { key: 'draft', label: 'Draft', icon: 'groups' },
    { key: 'settings', label: 'Settings', icon: 'settings' },
]

type PressableState = { hovered?: boolean; pressed?: boolean }

export function LeagueMoreCard({ onSelect, activeTab }: {
    onSelect: (tab: LeagueSection) => void
    activeTab?: LeagueSection
}) {
    return (
        <Card padding="none" elevated="none" style={styles.card}>
            <SectionBand label="More" />
            {MORE_ITEMS.map((item, index) => {
                const active = item.key === activeTab
                return (
                    <Pressable
                        key={item.key}
                        onPress={() => onSelect(item.key)}
                        accessibilityRole="button"
                        accessibilityLabel={item.label}
                        style={({ hovered, pressed }: PressableState) => [
                            styles.row,
                            index < MORE_ITEMS.length - 1 && styles.divider,
                            hovered && styles.rowHover,
                            pressed && styles.pressed,
                        ]}
                    >
                        <MaterialIcons name={item.icon} size={controlSize.icon.md} color={active ? colors.primaryDark : colors.textSecondary} />
                        <Text style={[styles.label, active && styles.labelActive]}>{item.label}</Text>
                        <MaterialIcons name="chevron-right" size={controlSize.icon.md} color={colors.textMuted} />
                    </Pressable>
                )
            })}
        </Card>
    )
}

const styles = StyleSheet.create({
    card: {
        width: '100%',
        maxWidth: layout.formMaxWidth + 2 * layout.pagePadX.regular,
        alignSelf: 'center',
        overflow: 'hidden',
        marginTop: spacing.xl,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: controlSize.minTouch,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
    rowHover: { backgroundColor: colors.bgSubtle },
    pressed: { opacity: motion.pressedOpacity },
    label: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    labelActive: { color: colors.primaryDark },
})
