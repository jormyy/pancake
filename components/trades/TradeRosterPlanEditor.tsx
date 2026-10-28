import { Pressable, StyleSheet, Text, View } from 'react-native'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { isIREligible } from '@pancake/core'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPlan, TradeRosterPreview } from '@/lib/trades'
import { isTradeTaxiEligible } from '@/lib/trade-assets'
import { tradeLegalityStep } from '@/lib/trade-legality-step'
import { colors, foundation, radii, spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPlanEditor({ incoming, roster, value, onChange, preview, disabled = false, allowIR = true, allowTaxi = true, unavailableMoves = {}, unavailableDestinations = {} }: {
    incoming: TradeItem[]
    roster: RosterPlayer[]
    value: TradeRosterPlan
    onChange: (value: TradeRosterPlan) => void
    preview?: TradeRosterPreview
    disabled?: boolean
    allowIR?: boolean
    allowTaxi?: boolean
    unavailableMoves?: Record<string, string>
    unavailableDestinations?: Record<string, Partial<Record<'ir' | 'taxi', string>>>
}) {
    const rows = [
        ...roster.map(row => ({ id: row.players.id, name: row.players.display_name, injury: row.players.injury_status,
            player: { name: row.players.display_name, playerId: row.players.id, nbaId: row.players.nba_id, team: row.players.nba_team, positions: row.players.eligible_positions, birthdate: row.players.birthdate, yearsExp: row.players.years_exp, careerGames: row.players.career_regular_season_games, injuryStatus: row.players.injury_status },
            current: row.is_on_taxi ? 'taxi' as const : row.is_on_ir ? 'ir' as const : 'active' as const, incoming: false, taxiEligible: false, fixedTaxi: false })),
        ...incoming.flatMap(item => item.kind === 'player' ? [{ id: item.playerId, name: item.playerName, injury: item.injuryStatus,
            player: { name: item.playerName, playerId: item.playerId, nbaId: item.nbaId, team: item.nbaTeam, positions: item.eligiblePositions ?? (item.position ? [item.position] : []), yearsExp: item.yearsExp, careerGames: item.careerGames, injuryStatus: item.injuryStatus },
            current: 'active' as const, incoming: true, taxiEligible: isTradeTaxiEligible(item), fixedTaxi: Boolean(item.fromTaxi) }] : []),
    ]
    const change = (row: typeof rows[number], destination: 'active' | 'ir' | 'taxi' | 'drop') => {
        if (row.incoming) {
            onChange({ ...value,
                irPlayerIds: [...value.irPlayerIds.filter(id => id !== row.id), ...(destination === 'ir' ? [row.id] : [])],
                taxiPlayerIds: [...value.taxiPlayerIds.filter(id => id !== row.id), ...(destination === 'taxi' ? [row.id] : [])],
            })
        } else {
            onChange({ ...value,
                dropPlayerIds: [...value.dropPlayerIds.filter(id => id !== row.id), ...(destination === 'drop' ? [row.id] : [])],
                rosterMoves: [...(value.rosterMoves ?? []).filter(move => move.playerId !== row.id),
                    ...(destination !== row.current && (destination === 'active' || destination === 'ir') ? [{ playerId: row.id, destination }] : [])],
            })
        }
    }
    return <View style={styles.root}>
        <Text style={textStyles.sectionLabel}>{preview ? tradeLegalityStep(preview, roster, incoming) : 'Roster choices'}</Text>
        {rows.map(row => {
            const selected = row.fixedTaxi ? 'taxi' : value.dropPlayerIds.includes(row.id) ? 'drop'
                : row.incoming ? value.irPlayerIds.includes(row.id) ? 'ir' : value.taxiPlayerIds.includes(row.id) ? 'taxi' : 'active'
                    : value.rosterMoves?.find(move => move.playerId === row.id)?.destination ?? row.current
            return <View key={row.id} style={styles.player}>
                <PlayerRowContent {...row.player} />
                <View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={`${row.name} roster slot`}>
                    {(['active', 'ir', 'taxi', 'drop'] as const).flatMap(destination => {
                        if (row.fixedTaxi && destination !== 'taxi' || row.incoming && destination === 'drop' ||
                            destination === 'taxi' && !row.incoming && row.current !== 'taxi') return []
                        const unavailable = disabled || Boolean(unavailableMoves[row.id]) ||
                            destination === 'ir' && (!allowIR || !isIREligible(row.injury ?? null) || Boolean(unavailableDestinations[row.id]?.ir)) ||
                            destination === 'taxi' && (!allowTaxi || row.incoming && !row.fixedTaxi && (!row.taxiEligible || Boolean(unavailableDestinations[row.id]?.taxi)))
                        const checked = destination === selected
                        const label = destination === 'drop' ? `Drop ${row.name} at completion` : `${row.name}: ${destination}`
                        return [<Pressable key={destination} accessibilityRole="radio" aria-checked={checked}
                            accessibilityLabel={label} accessibilityState={{ checked, disabled: unavailable }} disabled={unavailable}
                            style={[styles.choice, checked && styles.selected]}
                            onPress={() => { if (!checked) change(row, destination) }}>
                            <Text style={[textStyles.meta, { color: unavailable ? colors.textDisabled : destination === 'drop' && checked ? colors.dangerDark : colors.textPrimary }]}>
                                {destination === 'active' ? 'Regular' : destination === 'ir' ? 'IR' : destination === 'taxi' ? 'Taxi' : 'Drop'}
                            </Text>
                        </Pressable>]
                    })}
                </View>
            </View>
        })}
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.md, padding: spacing.lg, backgroundColor: colors.bgSubtle, borderRadius: radii.md },
    player: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
    choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    choice: { minHeight: foundation.minTouch, paddingHorizontal: spacing.md, justifyContent: 'center', borderRadius: radii.md },
    selected: { backgroundColor: colors.primaryLight },
})
