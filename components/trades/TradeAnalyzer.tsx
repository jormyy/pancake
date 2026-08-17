import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { colors, fontSize, fontWeight, radii, scrim, spacing } from '@/constants/tokens'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { getLeagueMembers, isTradingClosed } from '@/lib/league'
import {
    dynastyAnalyzerLatestRouteCacheKey,
    dynastyAnalyzerLatestScopeCacheKey,
    dynastyAnalyzerRouteSignature,
    dynastyAnalyzerSnapshotCacheKey,
    dynastyScoringSignature,
    type DynastyAnalyzerCacheScope,
} from '@/lib/dynasty-decisions'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import { saveTradeAnalyzerDraft } from '@/lib/trade-analyzer-session'
import type { Trade } from '@/lib/trades'
import type { TradeComposerMember } from '@/lib/trade-ui-model'

type Snapshot = {
    analysis: DynastyTradeAnalysis
    participantNames: Record<string, string>
    savedAt: string
    leagueId: string
    memberId: string
}

export default function TradeAnalyzer({ prefillTrade }: { prefillTrade?: Trade | null }) {
    const { push } = useRouter()
    const { user } = useAuth()
    const { current, currentLeague } = useLeagueContext()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const online = useOnlineStatus()
    const [members, setMembers] = useState<TradeComposerMember[]>([])
    const [networkUnavailable, setNetworkUnavailable] = useState(false)
    const [multiTeamMode, setMultiTeamMode] = useState(false)
    const [notes, setNotes] = useState('')
    const [expirationDays, setExpirationDays] = useState('3')
    const [confirming, setConfirming] = useState(false)
    const prefillRef = useRef('')
    const composer = useMultiTeamTradeComposer({
        enabled: Boolean(myMemberId && leagueId),
        myMemberId,
        leagueId,
        myTeamName: current?.team_name ?? 'Your team',
        members,
        faabEnabled: currentLeague?.waiver_mode === 'faab',
    })
    const participantName = composer.participantName
    const resetComposer = composer.reset
    const participantIds = composer.participantIds
    const setParticipantIds = composer.setParticipantIds
    const prefillFromTrade = composer.prefillFromTrade
    const items = composer.buildMultiTeamItems()
    const networkAvailable = online && !networkUnavailable
    const teamCount = Math.max(4, members.length + 1)
    const faabBudget = currentLeague?.faab_starting_budget ?? 100
    const { analysis, seasonYear, loading, error } = useDynastyTradeAnalysis({
        enabled: composer.assetsReady,
        leagueId,
        memberId: myMemberId,
        scoringSettings: currentLeague?.scoring_settings,
        teams: teamCount,
        faabBudget,
        participants: composer.participantViews,
        items,
    })
    const cacheIdentity = user?.id && myMemberId && leagueId ? {
        userId: user.id,
        memberId: myMemberId,
        leagueId,
    } : null
    const latestScopeKey = cacheIdentity ? dynastyAnalyzerLatestScopeCacheKey(cacheIdentity) : null
    const lastCompleteScope = latestScopeKey
        ? readPersistentCache<DynastyAnalyzerCacheScope>(latestScopeKey)
        : null
    const liveCacheScope = useMemo<DynastyAnalyzerCacheScope | null>(() =>
        user?.id && myMemberId && leagueId && seasonYear != null ? {
            userId: user.id,
            memberId: myMemberId,
            leagueId,
            seasonYear,
            scoringSignature: dynastyScoringSignature(currentLeague?.scoring_settings),
            teams: teamCount,
            faabBudget,
        } : null,
    [currentLeague?.scoring_settings, faabBudget, leagueId, myMemberId, seasonYear, teamCount, user?.id])
    const analyzerCacheScope = liveCacheScope ?? lastCompleteScope
    const routeSignature = dynastyAnalyzerRouteSignature(items)
    const latestRouteKey = analyzerCacheScope ? dynastyAnalyzerLatestRouteCacheKey(analyzerCacheScope) : null
    const lastRouteSignature = latestRouteKey ? readPersistentCache<string>(latestRouteKey) : null
    const cacheRouteSignature = routeSignature || (!networkAvailable ? lastRouteSignature : null)
    const snapshotKey = analyzerCacheScope && cacheRouteSignature
        ? dynastyAnalyzerSnapshotCacheKey(analyzerCacheScope, cacheRouteSignature)
        : null
    const cachedSnapshot = snapshotKey ? readPersistentCache<Snapshot>(snapshotKey) : null

    useEffect(() => {
        let active = true
        if (!leagueId) return
        setMembers([])
        setNetworkUnavailable(false)
        setConfirming(false)
        prefillRef.current = ''
        resetComposer()
        void getLeagueMembers(leagueId).then((rows) => {
            if (active) {
                setMembers(rows.filter((member) => member.id !== myMemberId))
                setNetworkUnavailable(false)
            }
        }).catch(() => {
            if (active) setNetworkUnavailable(true)
        })
        return () => { active = false }
    }, [leagueId, myMemberId, resetComposer, user?.id])

    useEffect(() => {
        if (networkUnavailable || members.length === 0) return
        const allowed = new Set([myMemberId, ...members.map((member) => member.id)])
        const validParticipants = participantIds.filter((memberId) => allowed.has(memberId))
        if (validParticipants.length !== participantIds.length) setParticipantIds(validParticipants)
    }, [members, myMemberId, networkUnavailable, participantIds, setParticipantIds])

    useEffect(() => {
        if (!prefillTrade || prefillRef.current === prefillTrade.id) return
        prefillRef.current = prefillTrade.id
        setMultiTeamMode(prefillTrade.isMultiTeam)
        prefillFromTrade(prefillTrade, myMemberId)
    }, [myMemberId, prefillFromTrade, prefillTrade])

    useEffect(() => {
        if (!liveCacheScope || !latestScopeKey || !snapshotKey || !latestRouteKey || !routeSignature ||
            !analysis || analysis.assets.length === 0) return
        writePersistentCache(snapshotKey, {
            analysis,
            participantNames: Object.fromEntries(analysis.teams.map((team) => [team.memberId, participantName(team.memberId)])),
            savedAt: new Date().toISOString(),
            leagueId,
            memberId: myMemberId,
        })
        writePersistentCache(latestRouteKey, routeSignature)
        writePersistentCache(latestScopeKey, liveCacheScope)
    }, [analysis, latestRouteKey, latestScopeKey, leagueId, liveCacheScope, myMemberId, participantName,
        routeSignature, snapshotKey])

    const setMode = useCallback((nextMulti: boolean) => {
        setMultiTeamMode(nextMulti)
        composer.reset()
    }, [composer])
    const selectTeam = useCallback((memberId: string) => {
        if (multiTeamMode) composer.toggleParticipant(memberId)
        else composer.setParticipantIds([myMemberId, memberId])
    }, [composer, multiTeamMode, myMemberId])
    const twoTeamInvolved = new Set(items.flatMap((item) => [item.fromMemberId, item.toMemberId]))
    const participantCountReady = multiTeamMode ? composer.participantIds.length >= 3 : composer.participantIds.length === 2
    const routeIsComplete = items.length > 0 &&
        participantCountReady &&
        composer.participantIds.every((memberId) => twoTeamInvolved.has(memberId))
    const canMakeOffer = networkAvailable && !isTradingClosed(currentLeague) && composer.assetsReady && routeIsComplete
    const offerHelp = !networkAvailable ? 'Connect to make an offer.'
        : isTradingClosed(currentLeague) ? 'Trades are locked for this league.'
            : !composer.assetsReady ? 'Trade assets are still loading.'
                : !routeIsComplete ? 'Add at least one asset from or to every selected team.'
                    : null
    const makeOffer = useCallback(() => {
        if (!canMakeOffer) return
        const draftId = saveTradeAnalyzerDraft({
            leagueId,
            actorMemberId: myMemberId,
            participantMemberIds: composer.participantIds,
            items,
        })
        setConfirming(false)
        push({ pathname: '/(modals)/propose-trade', params: { analyzerDraftId: draftId } })
    }, [canMakeOffer, composer.participantIds, items, leagueId, myMemberId, push])
    const shownAnalysis = analysis ?? (!networkAvailable ? cachedSnapshot?.analysis ?? null : null)
    const analysisParticipantName = useCallback((memberId: string) => {
        const liveName = participantName(memberId)
        return liveName === 'Unnamed' ? cachedSnapshot?.participantNames?.[memberId] ?? liveName : liveName
    }, [cachedSnapshot?.participantNames, participantName])
    const builderProps = {
        participants: composer.participantViews,
        items,
        myMemberId,
        faabEnabled: currentLeague?.waiver_mode === 'faab',
        notes,
        notesError: null,
        expirationDays,
        expirationError: null,
        rosterError: composer.rosterError ?? error,
        rosterLoading: composer.rosterLoading,
        avgMap: composer.avgMap,
        avgStatsMap: composer.avgStatsMap,
        participantName,
        onRetry: composer.retry,
        onTogglePlayer: composer.toggleParticipantPlayer,
        onTogglePick: composer.toggleParticipantPick,
        onDestinationChange: composer.setParticipantDestination,
        onPlayerDestinationChange: composer.setParticipantPlayerDestination,
        onPickDestinationChange: composer.setParticipantPickDestination,
        onFaabChange: composer.setParticipantFaab,
        onNotesChange: setNotes,
        onExpirationDaysChange: setExpirationDays,
    }

    return (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.intro}>
                <Text style={styles.title}>Trade Analyzer</Text>
                <Text style={styles.copy}>Run private experiments with the 5-year dynasty outlook.</Text>
                {!networkAvailable ? <Text style={styles.offline}>Offline: the last safe result stays visible. Offer creation is disabled.</Text> : null}
            </View>
            <View style={styles.modeRow}>
                <ModeButton label="2-Team" active={!multiTeamMode} onPress={() => setMode(false)} />
                <ModeButton label="Multi-Team" active={multiTeamMode} onPress={() => setMode(true)} />
            </View>
            <Text style={styles.sectionLabel}>TEAMS</Text>
            <View style={styles.teamChips}>
                {members.map((member) => {
                    const active = composer.selectedParticipantIds.has(member.id)
                    return <Pressable key={member.id} style={[styles.teamChip, active && styles.teamChipActive]}
                        onPress={() => selectTeam(member.id)} accessibilityRole="button"
                        accessibilityState={{ selected: active }} accessibilityLabel={`${active ? 'Remove' : 'Analyze with'} ${member.team_name ?? 'Unnamed team'}`}>
                        <Text style={[styles.teamChipText, active && styles.teamChipTextActive]}>{member.team_name ?? 'Unnamed'}</Text>
                    </Pressable>
                })}
            </View>
            {composer.participantViews.length >= 2 ? <MultiTeamTradeBuilder {...builderProps} /> : (
                <View style={styles.empty}><Text style={styles.copy}>Choose a team. Then add players, picks, or FAAB.</Text></View>
            )}
            <TradeAnalysisSummary analysis={shownAnalysis} participantName={analysisParticipantName}
                loading={loading && !shownAnalysis} cached={!analysis && Boolean(shownAnalysis)} />
            <Pressable style={[styles.makeOffer, !canMakeOffer && styles.disabled]} disabled={!canMakeOffer}
                onPress={() => setConfirming(true)} accessibilityRole="button" accessibilityState={{ disabled: !canMakeOffer }}
                accessibilityLabel={networkAvailable ? 'Make Offer from this analysis' : 'Make Offer unavailable offline'} id="analyzer-make-offer">
                <Text style={styles.makeOfferText}>Make Offer</Text>
            </Pressable>
            {offerHelp ? <Text style={styles.offerHelp} id="analyzer-offer-help">{offerHelp}</Text> : null}
            <Modal visible={confirming} transparent animationType="fade" onRequestClose={() => setConfirming(false)}>
                <View style={styles.modalBackdrop}><View style={styles.modalCard}>
                    <Text style={styles.title}>Use this experiment?</Text>
                    <Text style={styles.copy}>The offer editor will keep these teams and assets. You can review them before sending.</Text>
                    <View style={styles.modalActions}>
                        <Pressable style={styles.cancel} onPress={() => setConfirming(false)} accessibilityRole="button"><Text>Cancel</Text></Pressable>
                        <Pressable style={[styles.makeOffer, !canMakeOffer && styles.disabled]} onPress={makeOffer}
                            disabled={!canMakeOffer} accessibilityRole="button" accessibilityState={{ disabled: !canMakeOffer }}
                            accessibilityLabel={canMakeOffer ? 'Continue to offer editor' : 'Continue unavailable offline'}
                            id="analyzer-confirm-offer"><Text style={styles.makeOfferText}>Continue</Text></Pressable>
                    </View>
                </View></View>
            </Modal>
        </ScrollView>
    )
}

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
    return <Pressable style={[styles.modeButton, active && styles.modeButtonActive]} onPress={onPress}
        accessibilityRole="button" accessibilityState={{ selected: active }}><Text style={[styles.teamChipText, active && styles.teamChipTextActive]}>{label}</Text></Pressable>
}

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    content: { width: '100%', maxWidth: 900, alignSelf: 'center', paddingBottom: spacing['4xl'] },
    intro: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, gap: spacing.xs },
    title: { fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.textPrimary },
    copy: { fontSize: fontSize.sm, color: colors.textSecondary },
    offline: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.warningDark },
    modeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
    modeButton: { minHeight: 44, minWidth: 96, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgMuted, borderRadius: radii.md, borderWidth: 1, borderColor: colors.borderLight },
    modeButtonActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    sectionLabel: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    teamChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, padding: spacing.xl },
    teamChip: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.lg, backgroundColor: colors.bgMuted, borderRadius: radii['3xl'] },
    teamChipActive: { backgroundColor: colors.primary },
    teamChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    teamChipTextActive: { color: colors.textWhite },
    empty: { margin: spacing.xl, padding: spacing.xl, backgroundColor: colors.bgMuted, borderRadius: radii.lg },
    makeOffer: { minHeight: 48, marginHorizontal: spacing.xl, paddingHorizontal: spacing.xl, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderRadius: radii.md },
    makeOfferText: { color: colors.textWhite, fontSize: fontSize.md, fontWeight: fontWeight.bold },
    disabled: { opacity: 0.45 },
    offerHelp: { marginTop: spacing.sm, paddingHorizontal: spacing.xl, textAlign: 'center', fontSize: fontSize.xs, color: colors.textMuted },
    modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: scrim },
    modalCard: { width: '100%', maxWidth: 480, gap: spacing.lg, padding: spacing.xl, backgroundColor: colors.bgCard, borderRadius: radii.xl },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.md },
    cancel: { minHeight: 48, minWidth: 96, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgMuted, borderRadius: radii.md },
})
