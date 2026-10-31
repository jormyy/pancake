import type { PickupDestination } from '@/lib/pickup'
import { readAssetLocks } from '@/lib/locked-assets'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'
import { View, Text, StyleSheet } from 'react-native'
import { useMemo } from 'react'
import type { RosterPlayer } from '@/lib/roster'
import { groupRosterOptions, orderRosterOptions, rosterSlotLabel } from '@/lib/player-roster-options'
import { colors, spacing, table, textStyles } from '@/constants/tokens'


import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'

type Props = {
    visible: boolean
    title: string
    roster: RosterPlayer[]
    dropping: string | null
    onDrop: (rp: RosterPlayer, destination?: PickupDestination) => void
    destinations?: (rp: RosterPlayer) => Record<PickupDestination, boolean>
    irMoveCandidates?: RosterPlayer[]
    onMoveToIR?: (rp: RosterPlayer) => void
    onAdd?: () => void
    onAddToTaxi?: () => void
    onCancel: () => void
}

export function DropPlayerPickerModal({ visible, title, roster, dropping, onDrop, onCancel, irMoveCandidates = [], onMoveToIR, onAdd, onAddToTaxi, destinations }: Props) {
    const dropGroups = useMemo(() => groupRosterOptions(orderRosterOptions(roster)), [roster])
    const irOptions = useMemo(() => orderRosterOptions(irMoveCandidates), [irMoveCandidates])
    const close = () => {
        if (dropping === null) onCancel()
    }
    return (
        <Sheet visible={visible} onClose={close} title={title}>
            <Text style={styles.subtitle}>{onAdd ? 'Choose where to add this player.' : 'Roster full'}</Text>
            {onAdd || onAddToTaxi ? <View style={styles.row}>
                {onAdd ? <Button title="Add" onPress={onAdd} disabled={dropping !== null} /> : null}
                {onAddToTaxi ? <Button title="Add to taxi" onPress={onAddToTaxi} disabled={dropping !== null} /> : null}
            </View> : null}
            {irMoveCandidates.length > 0 && onMoveToIR ? (
                <View style={styles.list}>
                    {irOptions.map(rp => (
                        <View key={rp.id} style={styles.row}>
                            <PlayerRowContent locks={readAssetLocks(rp)} name={rp.players.display_name} nbaId={rp.players.nba_id} team={rp.players.nba_team} positions={rp.players.eligible_positions ?? []}
                                birthdate={rp.players.birthdate} yearsExp={rp.players.years_exp} careerGames={rp.players.career_regular_season_games} injuryStatus={rp.players.injury_status} />
                            <Button title="Move to IR" size="sm" onPress={() => onMoveToIR(rp)}
                                disabled={dropping !== null} loading={dropping === rp.id}
                                accessibilityLabel={`Move ${rp.players.display_name} to IR and add player`} />
                        </View>
                    ))}
                </View>
            ) : null}
            {dropGroups.map(group => <View key={group.label} style={styles.group}>
                <Text accessibilityRole="header" style={styles.groupLabel}>{group.label}</Text>
                <View style={styles.list}>
                {group.players.map((rp) => {
                    const p = rp.players
                    const available = destinations?.(rp)

                    return (
                        <View key={rp.id} style={styles.row}>
                            <PlayerRowContent locks={readAssetLocks(rp)} name={p.display_name} nbaId={p.nba_id} team={p.nba_team}
                                positions={p.eligible_positions?.length ? p.eligible_positions : p.position ? [p.position] : []}
                                birthdate={p.birthdate} yearsExp={p.years_exp} careerGames={p.career_regular_season_games} injuryStatus={p.injury_status} metadata={<Text style={styles.meta}>{rosterSlotLabel(rp)}</Text>} />
                            <Button
                                title="Drop"
                                size="sm"
                                variant="outline"
                                onPress={() => onDrop(rp)}
                                disabled={dropping !== null || available?.active === false}
                                loading={dropping === rp.id}
                                accessibilityLabel={`Drop ${p.display_name}`}
                            />
                            {rp.is_on_taxi && available?.taxi ? <Button title="Replace in Taxi" size="sm" onPress={() => onDrop(rp,'taxi')}
                                disabled={dropping !== null} accessibilityLabel={`Drop ${p.display_name} and add to Taxi`} /> : null}
                            {rp.is_on_ir && available?.ir ? <Button title="Replace in IR" size="sm" onPress={() => onDrop(rp,'ir')}
                                disabled={dropping !== null} accessibilityLabel={`Drop ${p.display_name} and add to IR`} /> : null}
                        </View>
                    )
                })}
                </View>
            </View>)}

        </Sheet>
    )
}

const styles = StyleSheet.create({
    meta: { ...textStyles.meta },
    subtitle: { ...textStyles.body, marginBottom: spacing.md },
    group: { marginTop: spacing.md, gap: spacing.xs },
    groupLabel: { ...textStyles.sectionLabel },
    list: { borderTopWidth: 1, borderTopColor: colors.separator },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: table.rowHeight,
        paddingVertical: spacing.sm,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.md,
    },
    info: { flex: 1, minWidth: 0, gap: spacing.xxs },
    metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
})
