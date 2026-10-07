import { FlashList } from '@shopify/flash-list'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { MotionPressable } from '@/components/Motion'
import { colors, controlSize, fontSize, fontWeight, radii, spacing, table, textStyles } from '@/constants/tokens'
import { draftAgeLabel, draftPlayerMeta } from '@/lib/draft-display'
import { NOMINATION_ORDER_MODE_LABELS } from '@/lib/draft'
import { playerHeadshotUrl } from '@/lib/format'
import type { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'

type Controller = ReturnType<typeof useAuctionDraftRoomController>

export function AuctionIdlePanel({
    controller,
    memberId,
    compact,
}: {
    controller: Controller
    memberId?: string
    compact: boolean
}) {
    const state = controller.state
    if (!state) return null
    const { draft, order, currentNominatorMemberId } = state
    const isPaused = draft.status === 'paused'
    const isMyTurn = currentNominatorMemberId === memberId
    const currentNominatorTeam = order.find((item) => item.memberId === currentNominatorMemberId)?.teamName ?? 'Unknown'

    let content
    if (draft.status === 'pending') {
        // Before the start, no one holds the nomination yet.
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingTeam}>Draft hasn&apos;t started</Text>
            <Text style={styles.waitingText}>{draft.scheduledAt ? `Starts ${new Date(draft.scheduledAt).toLocaleString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            })}` : 'The commissioner starts the draft.'}</Text>
        </View>
    } else if (isPaused) {
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingTeam}>Draft paused</Text>
            <Text style={styles.waitingText}>Commissioner will resume the clock.</Text>
        </View>
    } else if (!controller.realtimeConnected) {
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingTeam}>Reconnecting live draft</Text>
            <Text style={styles.waitingText}>Nominations stay disabled until the connection recovers.</Text>
        </View>
    } else if (!isMyTurn) {
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingText}>Waiting for</Text>
            <Text style={styles.waitingTeam}>{currentNominatorTeam}</Text>
            <Text style={styles.waitingText}>to nominate</Text>
        </View>
    } else {
        content = <>
            <Text style={styles.yourTurnBanner}>Your turn to nominate</Text>
            <Text style={styles.nominationModeHint}>
                Nomination order: {NOMINATION_ORDER_MODE_LABELS[draft.nominationOrderMode]}
            </Text>
            {controller.nominating ? <>
                <TextInput style={styles.searchInput} value={controller.searchQuery}
                    onChangeText={controller.setSearchQuery} placeholder="Search player name..."
                    autoFocus accessibilityLabel="Search player name" />
                <FlashList data={controller.searchResults} keyExtractor={(player) => player.id}
                    scrollEnabled={false} renderItem={({ item }) => (
                        <MotionPressable style={styles.playerResult}
                            onPress={() => controller.handleNominate(item.id)} disabled={controller.submittingNom}
                            pressedScale={0.975} accessibilityRole="button"
                            accessibilityLabel={`Nominate ${item.display_name ?? 'player'}`}>
                            <Avatar name={item.display_name ?? 'Player'} color={colors.bgMuted}
                                uri={playerHeadshotUrl(item.nba_id)} size={32} />
                            <View style={styles.playerCopy}>
                                <Text style={styles.playerResultName}>{item.display_name}</Text>
                                <Text style={styles.playerResultMeta}>{draftPlayerMeta([
                                    item.dynasty_rank != null ? `#${item.dynasty_rank}` : null,
                                    item.nba_team, item.position, draftAgeLabel(item.age),
                                ])}</Text>
                            </View>
                            <Text style={styles.nominateLabel}>Nominate</Text>
                        </MotionPressable>
                    )} ListEmptyComponent={controller.searchError
                        ? <Text style={styles.emptySearch}>Search failed. Keep typing or try again.</Text>
                        : controller.searchQuery.length > 0 && !controller.searchLoading
                            ? <Text style={styles.emptySearch}>No players found</Text> : null} />
                <MotionPressable style={styles.cancelButton} onPress={controller.cancelNominating}
                    pressedScale={0.94} accessibilityRole="button" accessibilityLabel="Cancel nomination search">
                    <Text style={styles.cancelText}>Cancel</Text>
                </MotionPressable>
            </> : <MotionPressable style={styles.nominateButton} onPress={() => controller.setNominating(true)}
                pressedScale={0.965} accessibilityRole="button" accessibilityLabel="Search and nominate a player">
                <Text style={styles.nominateButtonText}>Search & Nominate a Player</Text>
            </MotionPressable>}
        </>
    }

    return <View style={[styles.card, compact && styles.cardCompact]}>{content}</View>
}

const styles = StyleSheet.create({
    card: { backgroundColor: colors.bgCard, borderRadius: radii.lg, borderCurve: 'continuous', borderWidth: 1,
        borderColor: colors.borderLight, padding: spacing.xl, gap: spacing.md },
    cardCompact: { padding: spacing.md, gap: spacing.sm },
    waitingRow: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
    waitingText: { ...textStyles.body, color: colors.textMuted },
    waitingTeam: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    yourTurnBanner: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textAlign: 'center' },
    nominationModeHint: { ...textStyles.meta, textAlign: 'center' },
    nominateButton: { marginTop: spacing.xs, height: controlSize.button.md.height, backgroundColor: colors.primary, borderRadius: radii.lg,
        borderCurve: 'continuous', justifyContent: 'center', alignItems: 'center' },
    nominateButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    // 16px keeps iOS Safari from zooming into the field.
    searchInput: { height: controlSize.field.md, backgroundColor: colors.bgInput, borderRadius: radii.md, borderCurve: 'continuous',
        borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.lg, fontSize: fontSize.lg, marginTop: spacing.xs },
    playerResult: { minHeight: table.rowHeight, flexDirection: 'row', alignItems: 'center',
        borderTopWidth: 1, borderTopColor: colors.separator, gap: spacing.md },
    playerCopy: { flex: 1, minWidth: 0 },
    playerResultName: { ...textStyles.rowTitle },
    playerResultMeta: { ...textStyles.meta },
    nominateLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    emptySearch: { ...textStyles.meta, color: colors.textPlaceholder, textAlign: 'center', marginTop: spacing.md },
    cancelButton: { minHeight: controlSize.minTouch, marginTop: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    cancelText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
})
