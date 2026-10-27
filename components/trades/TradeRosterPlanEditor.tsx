import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPlan } from '@/lib/trades'
import { isTradeTaxiEligible } from '@/lib/trade-assets'
import { colors, foundation, radii, spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPlanEditor({ incoming, roster, value, onChange, disabled = false, allowIR = true, allowTaxi = true, unavailableMoves = {}, unavailableDestinations = {} }: {
    incoming: TradeItem[]
    roster: RosterPlayer[]
    value: TradeRosterPlan
    onChange: (value: TradeRosterPlan) => void
    disabled?: boolean
    allowIR?: boolean
    allowTaxi?: boolean
    unavailableMoves?: Record<string, string>
    unavailableDestinations?: Record<string, Partial<Record<'ir' | 'taxi', string>>>
}) {
    const [choosingMoves, setChoosingMoves] = useState(false)
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
                ir: allowIR && isIREligible(item.injuryStatus ?? null) && !unavailableDestinations[item.playerId]?.ir,
                taxi: allowTaxi && isTradeTaxiEligible(item) && !unavailableDestinations[item.playerId]?.taxi,
            }
            const placements = ['active', 'ir', 'taxi'] as const
            const fixedPlacement = item.fromTaxi ? 'Taxi · tenure retained' : null
            return [<View key={item.playerId} style={styles.player}>
                <PlayerRowContent name={item.playerName} nbaId={item.nbaId} team={item.nbaTeam} positions={item.eligiblePositions ?? (item.position ? [item.position] : [])}
                    yearsExp={item.yearsExp} careerGames={item.careerGames} injuryStatus={item.injuryStatus} />
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
                {!eligible.ir ? <Text style={textStyles.meta}>{unavailableDestinations[item.playerId]?.ir ?? 'IR requires an available IR slot and an Out or IR designation.'}</Text> : null}
                {!eligible.taxi ? <Text style={textStyles.meta}>{unavailableDestinations[item.playerId]?.taxi ?? 'Taxi requires a taxi slot and an eligible rookie or career game count.'}</Text> : null}
            </View>]
        })}
        <Pressable onPress={() => setChoosingMoves((current) => !current)} style={styles.dropToggle}
            accessibilityRole="button" accessibilityLabel="Choose roster moves at trade completion" accessibilityState={{ expanded: choosingMoves }}>
            <Text style={textStyles.body}>Choose roster moves</Text>
            <Text style={textStyles.meta}>{value.rosterMoves?.length ?? 0} moves</Text>
        </Pressable>
        {choosingMoves ? <View style={styles.player}>
            <Text style={textStyles.meta}>Moves happen at settlement. Players cannot return to taxi after promotion.</Text>
            {roster.filter((player) => !value.dropPlayerIds.includes(player.players.id)).map((player) => {
                const move = value.rosterMoves?.find((item) => item.playerId === player.players.id)
                const current = player.is_on_taxi ? 'taxi' : player.is_on_ir ? 'ir' : 'active'
                const selected = move?.destination ?? current
                const canIR = allowIR && isIREligible(player.players.injury_status)
                return <View key={player.id} style={styles.player}>
                    <PlayerRowContent name={player.players.display_name} nbaId={player.players.nba_id} team={player.players.nba_team}
                        positions={player.players.eligible_positions} yearsExp={player.players.years_exp} careerGames={player.players.career_regular_season_games}
                        injuryStatus={player.players.injury_status} />
                    <View style={styles.placements}>
                        {(['keep', 'active', 'ir'] as const).map((destination) => {
                            const unavailable = disabled || Boolean(unavailableMoves[player.players.id]) || destination === 'ir' && !canIR
                            const checked = destination === 'keep' ? !move : Boolean(move && selected === destination)
                            return <Pressable key={destination} accessibilityRole="radio" aria-checked={checked}
                                accessibilityLabel={`${player.players.display_name}: ${destination === 'keep' ? 'keep current slot' : destination}`}
                                accessibilityState={{ checked, disabled: unavailable }} disabled={unavailable}
                                style={[styles.placement, checked && styles.selected]}
                                onPress={() => onChange({ ...value, rosterMoves: [
                                    ...(value.rosterMoves ?? []).filter((item) => item.playerId !== player.players.id),
                                    ...(destination === 'keep' || destination === current ? [] : [{ playerId: player.players.id, destination }]),
                                ] })}>
                                <Text style={textStyles.body}>{destination === 'keep' ? `Keep ${current === 'active' ? 'regular' : current.toUpperCase()}` : destination === 'active' ? 'Regular' : 'IR'}</Text>
                            </Pressable>
                        })}
                    </View>
                    {unavailableMoves[player.players.id] ? <Text style={textStyles.meta}>{unavailableMoves[player.players.id]}</Text> : null}
                    {!canIR ? <Text style={textStyles.meta}>IR requires an Out or IR designation and an IR slot.</Text> : null}
                </View>
            })}
        </View> : null}
        <Pressable onPress={() => setChoosingDrops((value) => !value)} style={styles.dropToggle}
            accessibilityRole="button" accessibilityLabel="Choose drops at trade completion" accessibilityState={{ expanded: choosingDrops }}>
            <Text style={textStyles.body}>{choosingDrops ? 'Hide drop choices' : 'Choose drops'}</Text>
            <Text style={textStyles.meta}>{value.dropPlayerIds.length === 1 ? '1 drop' : `${value.dropPlayerIds.length} drops`}</Text>
        </Pressable>
        {choosingDrops ? <View style={styles.player}>
            <Text style={textStyles.meta}>Drops happen at completion. They will stay on waivers until the first 3 AM ET run after 48 hours.</Text>
            {roster.map((player) => {
                const selected = value.dropPlayerIds.includes(player.players.id)
                return <Pressable key={player.id} disabled={disabled || Boolean(unavailableMoves[player.players.id])} accessibilityRole="checkbox" aria-checked={selected}
                    accessibilityLabel={`Drop ${player.players.display_name} at completion`} accessibilityState={{ checked: selected, disabled: disabled || Boolean(unavailableMoves[player.players.id]) }}
                    onPress={() => onChange({ ...value, rosterMoves: value.rosterMoves?.filter((move) => move.playerId !== player.players.id), dropPlayerIds: selected ? value.dropPlayerIds.filter((id) => id !== player.players.id) : [...value.dropPlayerIds, player.players.id] })}
                    style={[styles.dropToggle, selected && styles.selected]}>
                    <PlayerRowContent name={player.players.display_name} nbaId={player.players.nba_id} team={player.players.nba_team} positions={player.players.eligible_positions ?? []}
                        yearsExp={player.players.years_exp} careerGames={player.players.career_regular_season_games} injuryStatus={player.players.injury_status} />
                    <Text style={[textStyles.meta, selected && { color: colors.dangerDark }]}>{unavailableMoves[player.players.id] ?? (selected ? 'Drop' : 'Keep')}</Text>
                </Pressable>
            })}
        </View> : null}
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.bgSubtle, borderRadius: radii.md },
    player: { gap: spacing.sm },
    placements: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    placement: { minHeight: foundation.minTouch, paddingHorizontal: spacing.lg, justifyContent: 'center', borderRadius: radii.md },
    selected: { backgroundColor: colors.primaryLight },
    dropToggle: { minHeight: foundation.minTouch, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingHorizontal: spacing.sm },
})
