import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useLeagueContext } from '@/contexts/league-context'
import { breakpoints, colors, fontSize, fontWeight, layout, radii, spacing } from '@/constants/tokens'
import { MotionPressable } from '@/components/Motion'
import { DraftAdminBar } from '@/components/league/draft-room/DraftAdminBar'
import { DraftScreenHeader } from '@/components/league/draft-room/DraftScreenHeader'
import { AuctionDraftSidePanel } from '@/components/league/draft-room/AuctionDraftSidePanel'
import { AuctionIdlePanel } from '@/components/league/draft-room/AuctionIdlePanel'
import { AuctionLivePanel } from '@/components/league/draft-room/AuctionLivePanel'
import { useDraftAdminControls } from '@/components/league/draft-room/useDraftAdminControls'
import { useAuctionDraftRoomController } from '@/hooks/useAuctionDraftRoomController'

const HISTORY_ROW_HEIGHT = 54

export default function DraftRoomScreen() {
    const { draftId } = useLocalSearchParams<{ draftId: string }>()
    const { current, isCommissioner } = useLeagueContext()
    const router = useRouter()
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    const isDesktop = width >= breakpoints.desktop && !compactLandscape

    const myMemberId = current?.id

    const controller = useAuctionDraftRoomController({ draftId, memberId: myMemberId })
    const { state, loadError, refresh, budgetByMember } = controller

    const { handleStopDraft, handleResetDraft, handlePauseDraft, handleResumeDraft } =
        useDraftAdminControls({
            draftId,
            refresh,
            onStopped: () => navigateBackToDraftList(state?.draft.isMock),
            confirmCopy: {
                stop: 'This ends the draft now. Players already drafted stay on their rosters and the league moves into the season. This cannot be undone.',
                reset: 'This wipes every pick, bid, and budget and restarts the draft from scratch. This cannot be undone.',
                pause: 'This freezes nominations and bidding until the commissioner resumes the draft.',
                resume: 'This reopens the draft clock and lets managers nominate and bid again.',
            },
        })

    function navigateBackToDraftList(isMock = false) {
        router.replace(isMock ? '/league?tab=mockRooms' : '/league?tab=auctions')
    }

    if (!state) {
        const hasLoadError = loadError != null
        return (
            <>
                <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    <DraftScreenHeader title="Auction Draft" onBack={() => navigateBackToDraftList()} />
                    <View style={styles.draftEndedContainer}>
                        <Text style={styles.draftEndedTitle}>{hasLoadError ? 'Could not load draft' : 'Draft not found'}</Text>
                        <Text style={styles.draftEndedSub}>
                            {hasLoadError ? loadError : 'This draft may have ended or no longer exists.'}
                        </Text>
                        <MotionPressable
                            style={styles.nominateButton}
                            onPress={hasLoadError ? refresh : () => navigateBackToDraftList()}
                            pressedScale={0.96}
                        >
                            <Text style={styles.nominateButtonText}>{hasLoadError ? 'Try Again' : 'Back to League'}</Text>
                        </MotionPressable>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    const { draft } = state
    const isPaused = draft.status === 'paused'
    const myBudget = myMemberId ? budgetByMember.get(myMemberId) : undefined
    const draftTitle = draft.isMock ? 'Mock Auction Draft' : 'Auction Draft'
    const historyListHeight = Math.min(
        controller.closedNominations.length * HISTORY_ROW_HEIGHT,
        Math.max(360, height - 300),
    )

    if (draft.status === 'completed' || draft.status === 'cancelled') {
        const stopped = draft.status === 'cancelled'
        return (
            <>
                <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
                <SafeAreaView style={styles.container} edges={['bottom']}>
                    <DraftScreenHeader title={draftTitle} onBack={() => navigateBackToDraftList(draft.isMock)} />
                    <View style={styles.draftEndedContainer}>
                        <Text style={styles.draftEndedTitle}>{stopped ? 'Draft Stopped' : 'Draft Complete'}</Text>
                        <Text style={styles.draftEndedSub}>
                            {stopped
                                ? 'The commissioner ended the draft. Players already drafted are on their rosters; everyone else is a free agent.'
                                : 'All teams are out of budget. Remaining players are free agents.'}
                        </Text>
                        <MotionPressable
                            style={styles.nominateButton}
                            onPress={() => navigateBackToDraftList(draft.isMock)}
                            pressedScale={0.96}
                        >
                            <Text style={styles.nominateButtonText}>Back to League</Text>
                        </MotionPressable>
                    </View>
                </SafeAreaView>
            </>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: 'Draft Room', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
            <DraftScreenHeader title={draftTitle} onBack={() => navigateBackToDraftList(draft.isMock)}>
                {myBudget?.remaining != null ? (
                    <View style={styles.budgetChip}>
                        <Text style={styles.budgetChipText}>${myBudget.remaining} left</Text>
                    </View>
                ) : null}
            </DraftScreenHeader>

            {isCommissioner ? (
                <DraftAdminBar
                    isPaused={isPaused}
                    onPause={handlePauseDraft}
                    onResume={handleResumeDraft}
                    onReset={handleResetDraft}
                    onStop={handleStopDraft}
                />
            ) : null}

            {loadError ? (
                <Pressable style={styles.refreshWarning} onPress={refresh}>
                    <Text style={styles.refreshWarningText}>Live draft refresh failed. Tap to retry.</Text>
                </Pressable>
            ) : null}

            <KeyboardAvoidingView
                style={styles.keyboard}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={[
                    styles.scrollContent,
                    compactLandscape && styles.scrollContentCompact,
                    isDesktop && styles.scrollContentDesktop,
                ]}
                keyboardShouldPersistTaps="handled"
            >
                <View style={[styles.columns, compactLandscape && styles.columnsCompact, isDesktop && styles.columnsDesktop]}>
                    <View style={[styles.column, compactLandscape && styles.columnCompact, isDesktop && styles.columnMainDesktop]}>
                        {state.openNomination
                            ? <AuctionLivePanel controller={controller} memberId={myMemberId} compact={compactLandscape} />
                            : <AuctionIdlePanel controller={controller} memberId={myMemberId} compact={compactLandscape} />}
                    </View>

                    <AuctionDraftSidePanel
                        tab={controller.tab}
                        onTabChange={controller.setTab}
                        budgets={state.budgets}
                        closedNominations={controller.closedNominations}
                        budgetByMember={budgetByMember}
                        wonCountByMember={controller.wonCountByMember}
                        myMemberId={myMemberId}
                        compact={compactLandscape}
                        desktop={isDesktop}
                        historyListHeight={historyListHeight}
                    />
                </View>
            </ScrollView>
            </KeyboardAvoidingView>
            </SafeAreaView>
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    keyboard: { flex: 1 },
    scroll: { flex: 1 },
    scrollContent: { padding: spacing.xl, paddingBottom: spacing['3xl'], gap: spacing.lg, width: '100%', maxWidth: 760, alignSelf: 'center' },
    scrollContentCompact: {
        paddingHorizontal: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: spacing['4xl'],
        gap: spacing.sm,
    },
    // Wide screens open up to the shared content width so the auction floor
    // fills the canvas instead of a narrow centered strip.
    scrollContentDesktop: {
        maxWidth: layout.contentMaxWidth,
        paddingHorizontal: spacing['3xl'],
        paddingTop: spacing['3xl'],
    },

    // Single column on phones; block card + activity left, budgets/history
    // right once `isDesktop` flips the outer wrapper to a row.
    columns: { gap: spacing.lg },
    columnsCompact: { gap: spacing.sm },
    columnsDesktop: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.xl },
    column: { gap: spacing.lg },
    columnCompact: { gap: spacing.sm },
    columnMainDesktop: { flex: 3, minWidth: 0 },

    budgetChip: {
        backgroundColor: colors.primaryLight,
        minHeight: 36,
        justifyContent: 'center',
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    budgetChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.primaryDark },
    refreshWarning: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.sm,
        backgroundColor: colors.dangerLight,
        borderBottomWidth: 1,
        borderBottomColor: colors.danger,
        alignItems: 'center',
    },
    refreshWarningText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },

    nominateButton: {
        marginTop: spacing.xs,
        height: 48,
        backgroundColor: colors.primary,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        justifyContent: 'center',
        alignItems: 'center',
    },
    nominateButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.md },

    draftEndedContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing['4xl'], gap: spacing.lg },
    draftEndedTitle: { fontSize: fontSize['2xl'], fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    draftEndedSub: { fontSize: fontSize.md, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
})
