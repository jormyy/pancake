import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { colors, fontSize, fontWeight, radii, spacing, tints, uiColors } from '@/constants/tokens'
import { playerHeadshotUrl } from '@/lib/format'
import { isIREligible, isTaxiEligible, type RosterPlayer } from '@/lib/roster'

export function RosterTrimBanner({
    players,
    excess,
    irAvailable,
    taxiAvailable,
    busyId,
    onDrop,
    onMoveToIR,
    onMoveToTaxi,
}: {
    players: RosterPlayer[]
    excess: number
    irAvailable: boolean
    taxiAvailable: boolean
    busyId: string | null
    onDrop: (player: RosterPlayer) => void
    onMoveToIR: (player: RosterPlayer) => void
    onMoveToTaxi: (player: RosterPlayer) => void
}) {
    if (excess <= 0) return null

    return (
        <View style={styles.banner} accessibilityRole="alert" accessibilityLabel={`Roster is ${excess} over the active player limit`}>
            <Text style={styles.title}>Trim roster: {excess} over limit</Text>
            <Text style={styles.detail}>Lineup changes are locked. Drop players or move eligible players to an open reserve slot.</Text>
            <ScrollView style={styles.list} nestedScrollEnabled>
                {players.map((player) => {
                    const busy = busyId === player.id
                    return (
                        <View key={player.id} style={styles.row}>
                            <Avatar
                                name={player.players.display_name}
                                uri={playerHeadshotUrl(player.players.nba_id) ?? undefined}
                                color={colors.bgMuted}
                                size={34}
                            />
                            <View style={styles.identity}>
                                <Text style={styles.name} numberOfLines={1}>{player.players.display_name}</Text>
                                <Text style={styles.meta} numberOfLines={1}>
                                    {[player.players.nba_team, player.players.position].filter(Boolean).join(' · ')}
                                </Text>
                            </View>
                            <View style={styles.actions}>
                                {irAvailable && isIREligible(player.players.injury_status) ? (
                                    <Pressable
                                        style={[styles.action, styles.reserveAction]}
                                        onPress={() => onMoveToIR(player)}
                                        disabled={busy}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Move ${player.players.display_name} to IR`}
                                        accessibilityState={{ disabled: busy }}
                                    >
                                        <Text style={styles.reserveText}>IR</Text>
                                    </Pressable>
                                ) : null}
                                {taxiAvailable && isTaxiEligible(player.players) ? (
                                    <Pressable
                                        style={[styles.action, styles.reserveAction]}
                                        onPress={() => onMoveToTaxi(player)}
                                        disabled={busy}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Move ${player.players.display_name} to Taxi Squad`}
                                        accessibilityState={{ disabled: busy }}
                                    >
                                        <Text style={styles.reserveText}>Taxi</Text>
                                    </Pressable>
                                ) : null}
                                <Pressable
                                    style={[styles.action, styles.dropAction]}
                                    onPress={() => onDrop(player)}
                                    disabled={busy}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Drop ${player.players.display_name}`}
                                    accessibilityState={{ disabled: busy }}
                                >
                                    <Text style={styles.dropText}>Drop</Text>
                                </Pressable>
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
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        backgroundColor: tints.dangerAction,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
        gap: spacing.xs,
    },
    title: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.dangerDark },
    detail: { fontSize: fontSize.sm, color: uiColors.dangerText, lineHeight: 19 },
    list: { maxHeight: 280, marginTop: spacing.sm },
    row: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: uiColors.dangerBorder,
        paddingVertical: spacing.xs,
    },
    identity: { flex: 1, minWidth: 100 },
    name: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textPrimary },
    meta: { fontSize: fontSize.xs, color: colors.textMuted },
    actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: spacing.xs },
    action: {
        minHeight: 44,
        minWidth: 48,
        paddingHorizontal: spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 1,
    },
    reserveAction: { backgroundColor: colors.bgScreen, borderColor: colors.primaryBorder },
    reserveText: { color: colors.primaryDark, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
    dropAction: { backgroundColor: colors.danger, borderColor: colors.danger },
    dropText: { color: colors.textWhite, fontSize: fontSize.xs, fontWeight: fontWeight.bold },
})
