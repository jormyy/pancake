import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPlan } from '@/lib/trades'
import { isTradeTaxiEligible } from '@/lib/trade-assets'
import { colors, foundation, radii, spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPlanEditor({ incoming, roster, value, onChange, disabled = false, extendedTaxi = false, allowIR = true, allowTaxi = true }: {
    incoming: TradeItem[]
    roster: RosterPlayer[]
    value: TradeRosterPlan
    onChange: (value: TradeRosterPlan) => void
    disabled?: boolean
    extendedTaxi?: boolean
    allowIR?: boolean
    allowTaxi?: boolean
}) {
    const [choosingDrops, setChoosingDrops] = useState(false)
    const changePlacement = (playerId: string, placement: 'active' | 'ir' | 'taxi') => onChange({
        ...value,
        irPlayerIds: [...value.irPlayerIds.filter((id) => id !== playerId), ...(placement === 'ir' ? [playerId] : [])],
        taxiPlayerIds: [...value.taxiPlayerIds.filter((id) => id !== playerId), ...(placement === 'taxi' ? [playerId] : [])],
    })
    return <View style={styles.root}>
        <Text style={textStyles.sectionLabel}>Roster plan</Text>
        {incoming.flatMap((item) => {
            if (item.kind !== 'player') return []
            const selectedPlacement = value.irPlayerIds.includes(item.playerId) ? 'ir' : value.taxiPlayerIds.includes(item.playerId) ? 'taxi' : 'active'
            const eligible = {
                active: true,
                ir: allowIR && isIREligible(item.injuryStatus ?? null),
                taxi: allowTaxi && isTradeTaxiEligible(item, extendedTaxi),
            }
            const placements = (['active', 'ir', 'taxi'] as const).filter((placement) => eligible[placement] || placement === selectedPlacement)
            const fixedPlacement = item.fromTaxi ? 'Taxi · tenure retained' : placements.length === 1 ? 'Active' : null
            return [<View key={item.playerId} style={styles.player}>
                <Text style={textStyles.body}>{item.playerName}</Text>
                <View style={styles.placements} accessibilityRole={fixedPlacement ? undefined : 'radiogroup'} accessibilityLabel={`${item.playerName} roster slot`}>
                    {fixedPlacement ? <Text style={textStyles.meta}>{fixedPlacement}</Text> : placements.map((placement) => {
                        const selected = placement === selectedPlacement
                        const unavailable = disabled || !eligible[placement]
                        return <Pressable key={placement} disabled={unavailable} accessibilityRole="radio" aria-checked={selected}
                            accessibilityLabel={`${item.playerName}: ${placement}`} accessibilityState={{ checked: selected, disabled: unavailable }}
                            onPress={() => { if (!selected) changePlacement(item.playerId, placement) }} style={[styles.placement, selected && styles.selected]}>
                            <Text style={[textStyles.body, { color: unavailable ? colors.textDisabled : selected ? colors.primaryDark : colors.textSecondary }]}>{placement === 'active' ? 'Active' : placement === 'ir' ? 'IR' : 'Taxi'}</Text>
                        </Pressable>
                    })}
                </View>
            </View>]
        })}
        <Pressable onPress={() => setChoosingDrops((value) => !value)} style={styles.dropToggle}
            accessibilityRole="button" accessibilityLabel="Choose drops at trade completion" accessibilityState={{ expanded: choosingDrops }}>
            <Text style={textStyles.body}>{choosingDrops ? 'Hide drop choices' : 'Choose drops'}</Text>
            <Text style={textStyles.meta}>{value.dropPlayerIds.length === 1 ? '1 drop' : `${value.dropPlayerIds.length} drops`}</Text>
        </Pressable>
        {choosingDrops ? <View style={styles.player}>
            <Text style={textStyles.meta}>Drops happen at completion. They will stay on waivers until the first 3 AM ET run after 48 hours.</Text>
            {roster.map((player) => {
                const selected = value.dropPlayerIds.includes(player.players.id)
                return <Pressable key={player.id} disabled={disabled} accessibilityRole="checkbox" aria-checked={selected}
                    accessibilityLabel={`Drop ${player.players.display_name} at completion`} accessibilityState={{ checked: selected, disabled }}
                    onPress={() => onChange({ ...value, dropPlayerIds: selected ? value.dropPlayerIds.filter((id) => id !== player.players.id) : [...value.dropPlayerIds, player.players.id] })}
                    style={[styles.dropToggle, selected && styles.selected]}>
                    <Text style={textStyles.body}>{player.players.display_name}</Text>
                    <Text style={[textStyles.meta, selected && { color: colors.dangerDark }]}>{selected ? 'Drop' : 'Keep'}</Text>
                </Pressable>
            })}
        </View> : null}
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.bgSubtle, borderRadius: radii.md },
    player: { gap: spacing.sm },
    placements: { flexDirection: 'row', gap: spacing.md },
    placement: { minHeight: foundation.minTouch, paddingHorizontal: spacing.lg, justifyContent: 'center', borderRadius: radii.md },
    selected: { backgroundColor: colors.primaryLight },
    dropToggle: { minHeight: foundation.minTouch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingHorizontal: spacing.sm },
})
