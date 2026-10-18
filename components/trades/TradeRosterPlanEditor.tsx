import { Pressable, Text, View } from 'react-native'
import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPlan } from '@/lib/trades'
import { colors, spacing } from '@/constants/tokens'

export function TradeRosterPlanEditor({ incoming, roster, value, onChange, disabled = false }: {
    incoming: TradeItem[]
    roster: RosterPlayer[]
    value: TradeRosterPlan
    onChange: (value: TradeRosterPlan) => void
    disabled?: boolean
}) {
    const changePlacement = (playerId: string, placement: 'active' | 'ir' | 'taxi') => onChange({
        ...value,
        irPlayerIds: [...value.irPlayerIds.filter((id) => id !== playerId), ...(placement === 'ir' ? [playerId] : [])],
        taxiPlayerIds: [...value.taxiPlayerIds.filter((id) => id !== playerId), ...(placement === 'taxi' ? [playerId] : [])],
    })
    return <View style={{ gap: spacing.md }}>
        <Text>Roster plan</Text>
        <Text>Drops and placements happen only when this trade completes. Drops enter waivers for 48 hours.</Text>
        <Text>Traded taxi players remain on taxi with their original tenure.</Text>
        {incoming.flatMap((item) => item.kind === 'player' ? [<View key={item.playerId} style={{ gap: spacing.sm }}>
            <Text>{item.playerName}</Text>
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
                {(['active', 'ir', 'taxi'] as const).map((placement) => {
                    const selected = placement === 'ir' ? value.irPlayerIds.includes(item.playerId)
                        : placement === 'taxi' ? value.taxiPlayerIds.includes(item.playerId)
                            : !value.irPlayerIds.includes(item.playerId) && !value.taxiPlayerIds.includes(item.playerId)
                    const unavailable = disabled || placement === 'ir' && !isIREligible(item.injuryStatus ?? null)
                    return <Pressable key={placement} disabled={unavailable} accessibilityRole="radio" aria-checked={selected}
                        accessibilityLabel={`${item.playerName}: ${placement}`} accessibilityState={{ checked: selected, disabled: unavailable }}
                        onPress={() => changePlacement(item.playerId, placement)} style={{ padding: spacing.sm, opacity: unavailable ? 0.5 : 1 }}>
                        <Text style={{ color: selected ? colors.primaryDark : colors.textSecondary }}>{placement === 'active' ? 'Active' : placement === 'ir' ? 'IR' : 'Taxi'}</Text>
                    </Pressable>
                })}
            </View>
        </View>] : [])}
        {roster.map((player) => {
            const selected = value.dropPlayerIds.includes(player.players.id)
            return <Pressable key={player.id} disabled={disabled} accessibilityRole="checkbox" aria-checked={selected}
                accessibilityLabel={`Drop ${player.players.display_name} at completion`} accessibilityState={{ checked: selected, disabled }}
                onPress={() => onChange({ ...value, dropPlayerIds: selected ? value.dropPlayerIds.filter((id) => id !== player.players.id) : [...value.dropPlayerIds, player.players.id] })}
                style={{ padding: spacing.sm }}>
                <Text>{selected ? 'Drop' : 'Keep'} {player.players.display_name}</Text>
            </Pressable>
        })}
    </View>
}
