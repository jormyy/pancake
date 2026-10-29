import { isIREligible, isTaxiEligible } from '@pancake/core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { RosterPlayerRow, RosterSectionBand, rosterActionDisabledStyle } from '@/components/roster/RosterItems'
import type { RosterPlayer } from '@/lib/roster'
import type { TradeItem, TradeRosterPlan, TradeRosterPreview } from '@/lib/trades'
import { colors, foundation, radii, spacing, textStyles } from '@/constants/tokens'

export function TradeRosterPlanEditor({ incoming, roster, value, onChange, disabled = false, allowIR = true, allowTaxi = true, unavailableMoves = {}, unavailableDestinations = {}, avgMap, avgStatsMap }: {
    incoming: TradeItem[]
    avgMap?: ReadonlyMap<string, number>
    avgStatsMap?: ReadonlyMap<string, { avg_minutes_played: number | null }>
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
            current: row.is_on_taxi ? 'taxi' as const : row.is_on_ir ? 'ir' as const : 'active' as const, incoming: false, fixedTaxi: false })),
        ...incoming.flatMap(item => item.kind === 'player' ? [{ id: item.playerId, name: item.playerName, injury: item.injuryStatus,
            player: { name: item.playerName, playerId: item.playerId, nbaId: item.nbaId, team: item.nbaTeam, positions: item.eligiblePositions ?? (item.position ? [item.position] : []), yearsExp: item.yearsExp, careerGames: item.careerGames, injuryStatus: item.injuryStatus },
            current: 'active' as const, incoming: true, fixedTaxi: Boolean(item.fromTaxi) }] : []),
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
                    ...(destination !== row.current && destination !== 'drop' ? [{ playerId: row.id, destination }] : [])],
            })
        }
    }
    const selectedFor = (row: typeof rows[number]) => row.fixedTaxi ? 'taxi' : value.dropPlayerIds.includes(row.id) ? 'drop'
        : row.incoming ? value.irPlayerIds.includes(row.id) ? 'ir' : value.taxiPlayerIds.includes(row.id) ? 'taxi' : 'active'
            : value.rosterMoves?.find(move => move.playerId === row.id)?.destination ?? row.current
    return <View style={styles.root}>
        {(['active', 'ir', 'taxi', 'drop'] as const).filter(section => rows.some(row => selectedFor(row) === section)).map(section => <View key={section} style={styles.section}>
            <RosterSectionBand label={section === 'active' ? 'Regular' : section === 'ir' ? 'IR' : section === 'taxi' ? 'Taxi' : 'Planned drops'} />
        {rows.map(row => {
            const selected = selectedFor(row)
            if (selected !== section) return null
            const item: RosterPlayer = {
                id: row.id, acquired_via: 'trade', is_on_ir: selected === 'ir', is_on_taxi: selected === 'taxi',
                players: { id: row.id, display_name: row.name, nba_team: row.player.team ?? null,
                    nba_id: row.player.nbaId ?? null, position: row.player.positions?.[0] ?? null,
                    eligible_positions: row.player.positions ?? [], injury_status: row.injury ?? null,
                    years_exp: row.player.yearsExp ?? null, nba_draft_number: null,
                    birthdate: 'birthdate' in row.player ? row.player.birthdate : null, career_regular_season_games: row.player.careerGames },
            }
            const incomingStats = incoming.find(item => item.kind === 'player' && item.playerId === row.id)
            return <RosterPlayerRow key={row.id} item={item} stackedActions
                avgFpts={avgMap?.get(row.id) ?? (incomingStats?.kind === 'player' ? incomingStats.avgFantasyPoints ?? undefined : undefined)}
                avgMinutes={avgStatsMap?.get(row.id)?.avg_minutes_played ?? (incomingStats?.kind === 'player' ? incomingStats.avgMinutesPlayed : undefined)}
                metadata={row.incoming ? <Text style={styles.incoming}>Incoming</Text> : undefined}
                actions={<View style={styles.choices} accessibilityRole="radiogroup" accessibilityLabel={`${row.name} roster slot`}>
                    {(['active', 'ir', 'taxi', 'drop'] as const).flatMap(destination => {
                        const unavailable = disabled || row.fixedTaxi && destination !== 'taxi' || row.incoming && destination === 'drop' || Boolean(unavailableMoves[row.id]) ||
                            destination === 'ir' && (!allowIR || !isIREligible(row.injury ?? null) || Boolean(unavailableDestinations[row.id]?.ir)) ||
                            destination === 'taxi' && (!row.incoming || !allowTaxi || !isTaxiEligible(row.player.yearsExp ?? null, row.player.careerGames ?? null) || Boolean(unavailableDestinations[row.id]?.taxi))
                        const checked = destination === selected
                        const label = destination === 'drop' ? `Drop ${row.name} at completion` : `${row.name}: ${destination}`
                        return [<Pressable key={destination} accessibilityRole="radio" aria-checked={checked}
                            accessibilityLabel={label} accessibilityState={{ checked, disabled: unavailable }} disabled={unavailable}
                            style={[styles.choice, checked && styles.selected, unavailable && rosterActionDisabledStyle]}
                            onPress={() => { if (!unavailable && !checked) change(row, destination) }}>
                            <Text style={[textStyles.meta, { color: destination === 'drop' && checked ? colors.dangerDark : colors.textPrimary }]}>
                                {destination === 'active' ? 'Regular' : destination === 'ir' ? 'IR' : destination === 'taxi' ? 'Taxi' : 'Drop'}
                            </Text>
                        </Pressable>]
                    })}
                </View>} />
        })}</View>)}
    </View>
}

const styles = StyleSheet.create({
    root: { gap: spacing.md },
    section: { backgroundColor: colors.bgCard, borderRadius: radii.lg, overflow: 'hidden' },
    incoming: { ...textStyles.meta, color: colors.primaryDark },
    choices: { flexDirection: 'row', gap: spacing.xs, alignSelf: 'flex-end' },
    choice: { minHeight: foundation.minTouch, paddingHorizontal: spacing.md, justifyContent: 'center', borderRadius: radii.md },
    selected: { backgroundColor: colors.primaryLight },
})
