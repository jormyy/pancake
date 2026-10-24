import { useMemo } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/ui/Button'
import { colors, fontSize, fontWeight, spacing, table, textStyles, tints, uiColors } from '@/constants/tokens'
import { playerHeadshotUrl } from '@/lib/format'
import { isIREligible, type RosterPlayer } from '@/lib/roster'

export function RosterTrimBanner({
    players,
    excess,
    irAvailable,
    busyId,
    onDrop,
    dropDisabled = false,
    onMoveToIR,
}: {
    players: RosterPlayer[]
    excess: number
    irAvailable: boolean
    busyId: string | null
    onDrop: (player: RosterPlayer) => void
    dropDisabled?: boolean
    onMoveToIR: (player: RosterPlayer) => void
}) {
    const recoveryPlayers = useMemo(() => [...players].sort((a, b) =>
        Number(irAvailable && isIREligible(b.players.injury_status)) - Number(irAvailable && isIREligible(a.players.injury_status)),
    ), [players, irAvailable])
    if (excess <= 0) return null

    return (
        <View style={styles.banner} accessibilityRole="alert" accessibilityLabel={`Roster is ${excess} over the active player limit`}>
            <Text style={styles.title}>Trim roster: {excess} over limit</Text>
            <Text style={styles.detail}>Drop a player or move one to IR to unlock lineup changes.</Text>
            <ScrollView style={styles.list} nestedScrollEnabled>
                {recoveryPlayers.map((player) => {
                    const busy = busyId !== null
                    return (
                        <View key={player.id} style={styles.row}>
                            <Avatar
                                name={player.players.display_name}
                                uri={playerHeadshotUrl(player.players.nba_id) ?? undefined}
                                color={colors.bgMuted}
                                size={36}
                            />
                            <View style={styles.identity}>
                                <Text style={styles.name} numberOfLines={1}>{player.players.display_name}</Text>
                                <Text style={styles.meta} numberOfLines={1}>
                                    {[player.players.nba_team, player.players.position].filter(Boolean).join(' · ')}
                                </Text>
                            </View>
                            <View style={styles.actions}>
                                {irAvailable && isIREligible(player.players.injury_status) ? (
                                    <Button
                                        title="IR"
                                        size="sm"
                                        variant="outline"
                                        onPress={() => onMoveToIR(player)}
                                        disabled={busy}
                                        accessibilityLabel={`Move ${player.players.display_name} to IR`}
                                    />
                                ) : null}

                                <Button
                                    title="Drop"
                                    size="sm"
                                    variant="outline"
                                    onPress={() => onDrop(player)}
                                    disabled={busy || dropDisabled}
                                    accessibilityLabel={`Drop ${player.players.display_name}`}
                                />
                            </View>
                        </View>
                    )
                })}
            </ScrollView>
        </View>
    )
}

const styles = StyleSheet.create({
    banner: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        backgroundColor: tints.dangerAction,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
        gap: spacing.xs,
    },
    title: { ...textStyles.rowTitle, color: colors.dangerDark },
    detail: { ...textStyles.meta, color: uiColors.dangerText },
    list: { maxHeight: table.rowHeight * 3, marginTop: spacing.xs },
    row: {
        minHeight: table.rowHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: uiColors.dangerBorder,
        paddingVertical: spacing.xs,
    },
    identity: { flex: 1, minWidth: 0 },
    name: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
    meta: { fontSize: fontSize.xs, color: colors.textMuted },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs },
})
