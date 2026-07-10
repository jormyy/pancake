import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useMultiTeamTradeComposer, type TradeComposerMember } from '@/hooks/use-multi-team-trade-composer'
import { getErrorMessage, showAlert, showSuccess } from '@/lib/alert'
import { getLeagueMembers, isTradingClosed } from '@/lib/league'
import {
    buildTwoTeamTradeComposerPayload,
    getTradeComposerMode,
    prefillTradeComposerFromTrade,
    submitMultiTeamTradeComposer,
    submitTradeComposer,
    tradeComposerSuccessCopy,
    tradeComposerTitle,
} from '@/lib/trade-composer'
import {
    counterMultiTeamTrade,
    counterTrade,
    editMultiTeamTrade,
    editTrade,
    getCurrentSeasonId,
    getTradeById,
    proposeMultiTeamTrade,
    proposeTrade,
} from '@/lib/trades'

export default function ProposeTradeScreen() {
    const { current, currentLeague } = useLeagueContext()
    const params = useLocalSearchParams<{
        recipientMemberId?: string
        editTradeId?: string
        counterTradeId?: string
        requestPlayerId?: string
        requestPickId?: string
    }>()
    const { back } = useRouter()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const [members, setMembers] = useState<TradeComposerMember[]>([])
    const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(params.recipientMemberId ?? null)
    const [multiTeamMode, setMultiTeamMode] = useState(false)
    const [notes, setNotes] = useState('')
    const [expirationDays, setExpirationDays] = useState('3')
    const [loading, setLoading] = useState(true)
    const [membersError, setMembersError] = useState<string | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const submittingRef = useRef(false)
    const routePrefillKeyRef = useRef<string | null>(null)
    const membersRequestRef = useRef(0)
    const { mode, editTradeId, counterTradeId, sourceTradeId } = getTradeComposerMode(params)
    const canUseMultiTeamMode = mode === 'propose'
    const faabEnabled = currentLeague?.waiver_mode === 'faab'
    const composer = useMultiTeamTradeComposer({
        enabled: Boolean(myMemberId && leagueId && (multiTeamMode || selectedRecipientId)),
        myMemberId,
        leagueId,
        myTeamName: current?.team_name ?? 'Your team',
        members,
        faabEnabled,
    })
    const {
        loadedParticipantKey,
        participantIds,
        participantViews,
        prefillFromTrade,
        reset,
        selectParticipantAsset,
        setParticipantIds,
        toggleParticipant,
    } = composer

    const loadMembers = useCallback(async () => {
        const requestId = ++membersRequestRef.current
        if (!leagueId) {
            setMembers([])
            setMembersError(null)
            setLoading(false)
            return
        }
        setLoading(true)
        setMembersError(null)
        try {
            const all = await getLeagueMembers(leagueId)
            if (membersRequestRef.current !== requestId) return
            setMembers(all.filter((member) => member.id !== myMemberId))
        } catch (error) {
            if (membersRequestRef.current !== requestId) return
            setMembers([])
            setMembersError(getErrorMessage(error) ?? 'Could not load league members.')
        } finally {
            if (membersRequestRef.current === requestId) setLoading(false)
        }
    }, [leagueId, myMemberId])

    useEffect(() => {
        void loadMembers()
        return () => { membersRequestRef.current += 1 }
    }, [loadMembers])

    useEffect(() => {
        if (multiTeamMode || !selectedRecipientId || !myMemberId) return
        setParticipantIds([myMemberId, selectedRecipientId])
    }, [multiTeamMode, myMemberId, selectedRecipientId, setParticipantIds])

    useEffect(() => {
        if (!sourceTradeId || !myMemberId) return
        let cancelled = false
        getTradeById(sourceTradeId, myMemberId)
            .then((trade) => {
                if (cancelled || !trade) return
                const prefill = prefillTradeComposerFromTrade(mode, trade)
                setMultiTeamMode(trade.isMultiTeam)
                setSelectedRecipientId(trade.isMultiTeam ? null : prefill.selectedRecipientId)
                setNotes(prefill.notes)
                setExpirationDays(prefill.expirationDays)
                prefillFromTrade(trade, myMemberId)
            })
            .catch((error) => showAlert('Error', getErrorMessage(error) ?? 'Could not load trade.'))
        return () => {
            cancelled = true
        }
    }, [mode, myMemberId, prefillFromTrade, sourceTradeId])

    useEffect(() => {
        if (multiTeamMode || !selectedRecipientId || loadedParticipantKey !== participantIds.join(',')) return
        const routeKey = `${selectedRecipientId}:${params.requestPlayerId ?? ''}:${params.requestPickId ?? ''}`
        if (routePrefillKeyRef.current === routeKey) return
        const recipient = participantViews.find((participant) => participant.memberId === selectedRecipientId)
        if (!recipient) return
        if (params.requestPlayerId && recipient.roster.some((player) => player.players.id === params.requestPlayerId)) {
            selectParticipantAsset(selectedRecipientId, 'player', params.requestPlayerId)
        }
        if (params.requestPickId && recipient.picks.some((pick) => pick.pickId === params.requestPickId)) {
            selectParticipantAsset(selectedRecipientId, 'pick', params.requestPickId)
        }
        routePrefillKeyRef.current = routeKey
    }, [
        loadedParticipantKey,
        multiTeamMode,
        params.requestPickId,
        params.requestPlayerId,
        participantIds,
        participantViews,
        selectParticipantAsset,
        selectedRecipientId,
    ])

    const setMode = useCallback((useMultiTeam: boolean) => {
        if (!canUseMultiTeamMode) return
        setMultiTeamMode(useMultiTeam)
        setSelectedRecipientId(null)
        routePrefillKeyRef.current = null
        reset()
    }, [canUseMultiTeamMode, reset])

    const selectTeam = useCallback((memberId: string) => {
        if (multiTeamMode) toggleParticipant(memberId)
        else setSelectedRecipientId(memberId)
    }, [multiTeamMode, toggleParticipant])

    const items = composer.buildMultiTeamItems()
    const twoTeamDraft = selectedRecipientId
        ? buildTwoTeamTradeComposerPayload(items, myMemberId, selectedRecipientId, {
            notes,
            expirationDaysInput: expirationDays,
            leagueStatus: currentLeague?.status,
            tradeDeadline: currentLeague?.trade_deadline,
        })
        : null
    const tradingClosed = isTradingClosed(currentLeague)
    const canSubmit = !tradingClosed && !submitting && !composer.rosterLoading && (
        multiTeamMode
            ? participantIds.length >= 3 && items.length > 0
            : Boolean(selectedRecipientId && twoTeamDraft?.hasOffer && twoTeamDraft.hasRequest)
    )

    const handleSubmit = useCallback(async () => {
        if (submittingRef.current || !canSubmit) return
        submittingRef.current = true
        setSubmitting(true)
        try {
            if (multiTeamMode) {
                await submitMultiTeamTradeComposer({
                    mode,
                    editTradeId,
                    counterTradeId,
                    myMemberId,
                    leagueId,
                    participantMemberIds: participantIds,
                    items,
                    notes,
                    expirationDays,
                    leagueStatus: currentLeague?.status,
                    tradeDeadline: currentLeague?.trade_deadline,
                }, { getCurrentSeasonId, proposeMultiTeamTrade, counterMultiTeamTrade, editMultiTeamTrade })
            } else if (selectedRecipientId && twoTeamDraft) {
                await submitTradeComposer({
                    mode,
                    editTradeId,
                    counterTradeId,
                    myMemberId,
                    leagueId,
                    selectedRecipientId,
                    payload: twoTeamDraft.payload,
                }, { getCurrentSeasonId, proposeTrade, counterTrade, editTrade })
            }
            const successCopy = tradeComposerSuccessCopy(mode)
            showSuccess(successCopy.title, successCopy.message)
            back()
        } catch (error) {
            showAlert('Error', getErrorMessage(error) ?? 'Could not propose trade.')
        } finally {
            submittingRef.current = false
            setSubmitting(false)
        }
    }, [
        back,
        canSubmit,
        counterTradeId,
        currentLeague?.status,
        currentLeague?.trade_deadline,
        editTradeId,
        expirationDays,
        items,
        leagueId,
        mode,
        multiTeamMode,
        myMemberId,
        notes,
        participantIds,
        selectedRecipientId,
        twoTeamDraft,
    ])

    if (!current) {
        return (
            <SafeAreaView style={styles.container} edges={['top']}>
                <View style={styles.emptyCenter}><Text style={styles.emptyText}>No active league.</Text></View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <View style={styles.header}>
                <View style={styles.headerInner}>
                    <Pressable onPress={back} style={styles.headerButton} accessibilityRole="button" accessibilityLabel="Cancel trade proposal">
                        <Text style={styles.cancelText}>Cancel</Text>
                    </Pressable>
                    <Text style={styles.headerTitle} numberOfLines={1}>{tradeComposerTitle(mode)}</Text>
                    <Pressable
                        onPress={handleSubmit}
                        style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
                        disabled={!canSubmit}
                        accessibilityRole="button"
                        accessibilityLabel="Send trade proposal"
                        testID="trade-submit"
                        id="trade-submit"
                    >
                        <Text style={[styles.submitText, !canSubmit && styles.submitTextDisabled]}>Send</Text>
                    </Pressable>
                </View>
            </View>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                {tradingClosed ? (
                    <View style={styles.lockBanner}>
                        <Text style={styles.lockBannerText}>Trades are locked only from the trade deadline until the champion is finalized.</Text>
                    </View>
                ) : null}
                <Text style={styles.sectionLabel}>TRADE WITH</Text>
                {canUseMultiTeamMode ? (
                    <View style={styles.modeSwitch}>
                        <ModeButton label="2-Team" active={!multiTeamMode} onPress={() => setMode(false)} />
                        <ModeButton label="Multi-Team" active={multiTeamMode} onPress={() => setMode(true)} />
                    </View>
                ) : null}
                <View style={styles.teamChips}>
                    {members.map((member) => {
                        const active = multiTeamMode
                            ? composer.selectedParticipantIds.has(member.id)
                            : selectedRecipientId === member.id
                        return (
                            <Pressable
                                key={member.id}
                                style={[styles.teamChip, active && styles.teamChipActive]}
                                onPress={() => selectTeam(member.id)}
                                accessibilityRole="button"
                                accessibilityLabel={`${active ? 'Remove' : 'Trade with'} ${member.team_name ?? 'Unnamed team'}`}
                                testID={`trade-participant-${member.id}`}
                                id={`trade-participant-${member.id}`}
                            >
                                <Text style={[styles.teamChipText, active && styles.teamChipTextActive]}>
                                    {member.team_name ?? 'Unnamed'}
                                </Text>
                            </Pressable>
                        )
                    })}
                </View>
                {membersError ? (
                    <>
                        <ErrorBanner message={membersError} onRetry={() => { void loadMembers() }} />
                        <EmptyState icon="error-outline" message="Teams unavailable"
                            description="Retry to load the league members available for this trade."
                            fullScreen={false} framed />
                    </>
                ) : composer.participantViews.length >= 2 ? (
                    <MultiTeamTradeBuilder
                        participants={composer.participantViews}
                        items={items}
                        myMemberId={myMemberId}
                        faabEnabled={faabEnabled}
                        notes={notes}
                        expirationDays={expirationDays}
                        rosterError={composer.rosterError}
                        avgMap={composer.avgMap}
                        avgStatsMap={composer.avgStatsMap}
                        participantName={composer.participantName}
                        onRetry={composer.retry}
                        onTogglePlayer={composer.toggleParticipantPlayer}
                        onTogglePick={composer.toggleParticipantPick}
                        onDestinationChange={composer.setParticipantDestination}
                        onPlayerDestinationChange={composer.setParticipantPlayerDestination}
                        onPickDestinationChange={composer.setParticipantPickDestination}
                        onFaabChange={composer.setParticipantFaab}
                        onNotesChange={setNotes}
                        onExpirationDaysChange={setExpirationDays}
                    />
                ) : !loading ? (
                    <EmptyState
                        icon={multiTeamMode ? 'group-add' : 'swap-horiz'}
                        message={multiTeamMode ? 'Pick at least two more teams' : 'Pick a team to trade with'}
                        description={multiTeamMode
                            ? 'Choose teams above, then select the assets each team sends.'
                            : 'Choose a team above, then build both sides of the offer.'
                        }
                        fullScreen={false}
                        framed
                    />
                ) : null}
                <View style={styles.bottomSpace} />
            </ScrollView>
        </SafeAreaView>
    )
}

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
    return (
        <Pressable
            style={[styles.modeButton, active && styles.modeButtonActive]}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={`Use ${label.toLowerCase()} trade mode`}
            testID={label === 'Multi-Team' ? 'trade-mode-multi' : 'trade-mode-two'}
            id={label === 'Multi-Team' ? 'trade-mode-multi' : 'trade-mode-two'}
        >
            <Text style={[styles.modeButtonText, active && styles.modeButtonTextActive]}>{label}</Text>
        </Pressable>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { flex: 1 },
    scrollContent: { width: '100%', maxWidth: 900, alignSelf: 'center' },
    header: { paddingVertical: spacing.lg, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
    headerInner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        width: '100%',
        maxWidth: 900,
        alignSelf: 'center',
    },
    headerTitle: {
        flex: 1,
        marginHorizontal: spacing.md,
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
    },
    headerButton: {
        minWidth: 72,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    cancelText: { fontSize: fontSize.lg, color: colors.textSecondary },
    submitButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        minHeight: 44,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 72,
        alignItems: 'center',
        justifyContent: 'center',
    },
    submitButtonDisabled: { backgroundColor: colors.bgMuted, borderWidth: 1, borderColor: colors.borderLight, opacity: 0.55 },
    submitText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    submitTextDisabled: { color: colors.textPlaceholder },
    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    modeSwitch: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm },
    modeButton: {
        minHeight: 40,
        paddingHorizontal: spacing.lg,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        borderWidth: 1,
        borderColor: colors.borderLight,
        justifyContent: 'center',
        alignItems: 'center',
    },
    modeButtonActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    modeButtonText: { color: colors.textSecondary, fontSize: fontSize.sm, fontWeight: fontWeight.bold },
    modeButtonTextActive: { color: colors.textWhite },
    teamChips: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xs, gap: spacing.md, flexDirection: 'row', flexWrap: 'wrap' },
    teamChip: {
        paddingHorizontal: 14,
        minHeight: 44,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    teamChipActive: { backgroundColor: colors.primary },
    teamChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamChipTextActive: { color: colors.textWhite },
    lockBanner: {
        marginHorizontal: spacing.xl,
        marginTop: spacing.xl,
        padding: spacing.lg,
        borderRadius: radii.lg,
        borderWidth: 1,
        borderColor: colors.warningDark,
        backgroundColor: colors.warningLight,
    },
    lockBannerText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.warningDark, textAlign: 'center' },
    emptyCenter: { alignItems: 'center', padding: spacing['5xl'] },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center' },
    bottomSpace: { height: 40 },
})
