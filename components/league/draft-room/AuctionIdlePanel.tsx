import { FlashList } from '@shopify/flash-list'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import { Avatar } from '@/components/Avatar'
import { MotionPressable } from '@/components/Motion'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
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
    if (isPaused) {
        const absentNames = controller.absentMembers.map((member) => member.teamName).join(', ')
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingTeam}>Draft paused</Text>
            <Text style={styles.waitingText}>
                {draft.pauseReason === 'member_absent' && absentNames
                    ? `Waiting for ${absentNames} to rejoin...`
                    : 'Commissioner will resume the clock.'}
            </Text>
        </View>
    } else if (!controller.allMembersPresent) {
        const absentNames = controller.absentMembers.map((member) => member.teamName).join(', ')
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingTeam}>Waiting for everyone to join</Text>
            <Text style={styles.waitingText}>{absentNames} hasn&apos;t joined the draft room yet.</Text>
        </View>
    } else if (!isMyTurn) {
        content = <View style={styles.waitingRow}>
            <Text style={styles.waitingText}>Waiting for</Text>
            <Text style={styles.waitingTeam}>{currentNominatorTeam}</Text>
            <Text style={styles.waitingText}>to nominate...</Text>
        </View>
    } else {
        content = <>
            <Text style={styles.yourTurnBanner}>Your turn to nominate!</Text>
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
                                uri={playerHeadshotUrl(item.nba_id)} size={36} />
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
    card: { backgroundColor: colors.bgScreen, borderRadius: radii.md, borderCurve: 'continuous', borderWidth: 1,
        borderColor: colors.borderLight, padding: spacing.xl, gap: spacing.md },
    cardCompact: { padding: spacing.md, gap: spacing.sm },
    waitingRow: { alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.md },
    waitingText: { fontSize: fontSize.md, color: colors.textMuted },
    waitingTeam: { fontSize: fontSize['2lg'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    yourTurnBanner: { fontSize: fontSize.lg, fontWeight: fontWeight.extrabold, color: colors.primaryDark, textAlign: 'center' },
    nominationModeHint: { fontSize: fontSize.sm, color: colors.textMuted, textAlign: 'center', marginTop: spacing.xs },
    nominateButton: { marginTop: spacing.xs, height: 48, backgroundColor: colors.primary, borderRadius: radii.md,
        borderCurve: 'continuous', justifyContent: 'center', alignItems: 'center' },
    nominateButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },
    searchInput: { height: 44, backgroundColor: colors.bgMuted, borderRadius: radii.md, borderCurve: 'continuous',
        paddingHorizontal: 14, fontSize: fontSize.lg, marginTop: spacing.xs },
    playerResult: { minHeight: 52, flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm,
        borderTopWidth: 1, borderTopColor: colors.separator, gap: spacing.md },
    playerCopy: { flex: 1 },
    playerResultName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold },
    playerResultMeta: { fontSize: fontSize['2sm'], color: colors.textMuted, marginTop: 1 },
    nominateLabel: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    emptySearch: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginTop: spacing.md },
    cancelButton: { minHeight: 44, marginTop: spacing.sm, alignItems: 'center', justifyContent: 'center' },
    cancelText: { fontSize: fontSize.md, color: colors.textMuted, fontWeight: fontWeight.semibold },
})
