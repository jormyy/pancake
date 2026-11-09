import { TRADE_FORMULA_VERSION } from '@/core/src/dynasty/tradeScoring'
import { pickLabel } from '@/lib/picks'
import { ScreenStatusScrollView as ScrollView } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { ScrollView as NativeScrollView } from 'react-native'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { useRouter } from 'expo-router'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { MultiTeamTradeBuilder } from '@/components/trades/MultiTeamTradeBuilder'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { borderWidth, colors, componentTokens, controlSize, fontSize, fontWeight, foundation, layout, radii, spacing, textStyles } from '@/constants/tokens'
import { usePageMetrics } from '@/components/ui/Page'
import { Button } from '@/components/ui/Button'
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

const BUILDER_WIDTH = componentTokens.tradeAnalyzer.builderWidth

type Snapshot = {
    modelVersion: string
    analysis: DynastyTradeAnalysis
    participantNames: Record<string, string>
    savedAt: string
    leagueId: string
    memberId: string
}

export default function TradeAnalyzer({ prefillTrade }: { prefillTrade?: Trade | null }) {
    const { push } = useRouter()
    const { user } = useAuth()
    const { usableWidth } = usePageMetrics()
    // The builder keeps its 2-column team layout; the verdict joins it on the
    // right only when both fit.
    const sideBySide = usableWidth >= BUILDER_WIDTH + spacing['3xl'] + layout.railWidth
    const { current, currentLeague } = useLeagueContext()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const online = useOnlineStatus()
    const membersKey = user?.id && myMemberId && leagueId ? `pancake:analyzer-members:v1:${user.id}:${myMemberId}:${leagueId}` : null
    const [members, setMembers] = useState<TradeComposerMember[]>(() => membersKey ? readPersistentCache<TradeComposerMember[]>(membersKey) ?? [] : [])
    const [membersLoaded, setMembersLoaded] = useState(() => Boolean(membersKey && readPersistentCache<TradeComposerMember[]>(membersKey)))
    const [showAnalysis, setShowAnalysis] = useState(Boolean(prefillTrade))
    const [historical, setHistorical] = useState(Boolean(prefillTrade))
    const [networkUnavailable, setNetworkUnavailable] = useState(false)
    const [membersRetryToken, setMembersRetryToken] = useState(0)
    const [multiTeamMode, setMultiTeamMode] = useState(false)
    const [editedSnapshot, setEditedSnapshot] = useState<{ routeSignature: string; value: Snapshot } | null>(null)
    const prefillRef = useRef('')
    const composer = useMultiTeamTradeComposer({
        enabled: Boolean(myMemberId && leagueId),
        myMemberId,
        leagueId,
        myTeamName: current?.team_name ?? 'Your team',
        members,
        faabEnabled: currentLeague?.waiver_mode === 'faab',
        allowInactiveTrades: currentLeague?.allow_inactive_trades,
    })
    const participantName = composer.participantName
    const resetComposer = composer.reset
    const participantIds = composer.participantIds
    const setParticipantIds = composer.setParticipantIds
    const prefillFromTrade = composer.prefillFromTrade
    const buildMultiTeamItems = composer.buildMultiTeamItems
    const items = useMemo(() => buildMultiTeamItems(), [buildMultiTeamItems])
    const networkAvailable = online && !networkUnavailable
    const teamCount = Math.max(4, members.length + 1)
    const faabBudget = currentLeague?.faab_starting_budget ?? 100
    const { analysis, calculatedAt, seasonYear, loading, error, retry: retryAnalysis } = useDynastyTradeAnalysis({
        debounceMs: 300,
        enabled: composer.assetsReady,
        leagueId,
        memberId: myMemberId,
        tradeId: historical ? prefillTrade?.id : undefined,
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
        ? dynastyAnalyzerSnapshotCacheKey(analyzerCacheScope, `${historical ? `revaluation:${prefillTrade?.id}:` : ''}${cacheRouteSignature}`)
        : null
    const storedSnapshot = snapshotKey ? readPersistentCache<Snapshot>(snapshotKey) : null
    const matchingSnapshot = editedSnapshot?.routeSignature === routeSignature ? editedSnapshot.value : storedSnapshot
    const cachedSnapshot = matchingSnapshot?.leagueId === leagueId && matchingSnapshot.memberId === myMemberId && matchingSnapshot.modelVersion === TRADE_FORMULA_VERSION ? matchingSnapshot : null

    useEffect(() => {
        const cachedMembers = membersKey ? readPersistentCache<TradeComposerMember[]>(membersKey) : null
        setMembers(cachedMembers ?? [])
        setMembersLoaded(Boolean(cachedMembers))
        setShowAnalysis(Boolean(prefillTrade))
        setHistorical(Boolean(prefillTrade))
        setNetworkUnavailable(false)
        setEditedSnapshot(null)
        prefillRef.current = ''
        resetComposer()
    }, [leagueId, membersKey, myMemberId, prefillTrade, resetComposer, user?.id])

    useEffect(() => {
        let active = true
        if (!leagueId || !online) return
        void getLeagueMembers(leagueId).then((rows) => {
            if (active) {
                const available = rows.filter((member) => member.id !== myMemberId)
                if (membersKey) writePersistentCache(membersKey, available)
                setMembers(available)
                setMembersLoaded(true)
                setNetworkUnavailable(false)
            }
        }).catch(() => {
            if (active) { setNetworkUnavailable(true); setMembersLoaded(true) }
        })
        return () => { active = false }
    }, [leagueId, membersKey, myMemberId, online, membersRetryToken, user?.id])

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
            loading || error || !analysis || analysis.assets.length === 0) return
        writePersistentCache(snapshotKey, {
            modelVersion: TRADE_FORMULA_VERSION,
            analysis,
            participantNames: Object.fromEntries(analysis.teams.map((team) => [team.memberId, participantName(team.memberId)])),
            savedAt: new Date().toISOString(),
            leagueId,
            memberId: myMemberId,
        })
        writePersistentCache(latestScopeKey, liveCacheScope)
        if (!historical) {
            writePersistentCache(latestRouteKey, routeSignature)
        }
    }, [analysis, latestRouteKey, latestScopeKey, leagueId, liveCacheScope, myMemberId, participantName,
        routeSignature, snapshotKey, loading, error, historical])

    const setMode = useCallback((nextMulti: boolean) => {
        setMultiTeamMode(nextMulti)
        composer.reset()
    }, [composer])
    const selectTeam = useCallback((memberId: string) => {
        if (multiTeamMode) composer.toggleParticipant(memberId)
        else composer.setParticipantIds(composer.selectedParticipantIds.has(memberId) ? [myMemberId] : [myMemberId, memberId])
    }, [composer, multiTeamMode, myMemberId])
    const twoTeamInvolved = new Set(items.flatMap((item) => [item.fromMemberId, item.toMemberId]))
    const participantCountReady = multiTeamMode ? composer.participantIds.length >= 3 : composer.participantIds.length === 2
    const routeIsComplete = items.length > 0 &&
        participantCountReady &&
        composer.participantIds.every((memberId) => twoTeamInvolved.has(memberId))
    const canMakeOffer = !historical && networkAvailable && !isTradingClosed(currentLeague) && composer.selectedAssetsAvailable && routeIsComplete
    const offerHelp = !online ? 'Offline'
        : networkUnavailable ? 'Reload teams.'
        : isTradingClosed(currentLeague) ? 'Trades locked.'
            : !composer.assetsReady ? 'Loading assets.'
                : !composer.selectedAssetsAvailable ? 'Remove unavailable assets.'
                : !routeIsComplete ? 'Add assets for each team.'
                    : null
    const makeOffer = useCallback(() => {
        if (!canMakeOffer) return
        const draftId = saveTradeAnalyzerDraft({
            leagueId,
            actorMemberId: myMemberId,
            participantMemberIds: composer.participantIds,
            items,
        })
        push({ pathname: '/(modals)/propose-trade', params: { analyzerDraftId: draftId } })
    }, [canMakeOffer, composer.participantIds, items, leagueId, myMemberId, push])
    const shownAnalysis = analysis ?? (!networkAvailable ? cachedSnapshot?.analysis ?? null : null)
    const assetLabels = useMemo(() => new Map([
        ...(prefillTrade?.routedItems ?? []).flatMap((item): [string, string][] => item.kind === 'player'
            ? [[`player:${item.playerId}`, item.playerName]]
            : item.kind === 'pick' ? [[`pick:${item.pickId}`, pickLabel(item.seasonYear, item.round)]] : []),
        ...(shownAnalysis?.assets ?? []).map((asset): [string, string] => [`${asset.kind}:${asset.assetId}`, asset.label]),
    ]), [prefillTrade?.routedItems, shownAnalysis?.assets])
    const analysisParticipantName = useCallback((memberId: string) => {
        const liveName = participantName(memberId)
        return liveName === 'Unnamed' ? cachedSnapshot?.participantNames?.[memberId] ?? liveName : liveName
    }, [cachedSnapshot?.participantNames, participantName])
    const builderProps = {
        participants: composer.participantViews,
        items,
        myMemberId,
        faabEnabled: currentLeague?.waiver_mode === 'faab',
        showTerms: false,
        notesError: null,
        expirationError: null,
        rosterError: composer.rosterError,
        rosterLoading: !composer.displayReady && !composer.rosterError,
        avgMap: composer.avgMap,
        avgStatsMap: composer.avgStatsMap,
        assetLabels,
        participantName,
        onRetry: () => { setMembersRetryToken((value) => value + 1); composer.retry() },
        onTogglePlayer: composer.toggleParticipantPlayer,
        onTogglePick: composer.toggleParticipantPick,
        onRemoveAsset: composer.removeParticipantAsset,
        onDestinationChange: composer.setParticipantDestination,
        onPlayerDestinationChange: composer.setParticipantPlayerDestination,
        onPickDestinationChange: composer.setParticipantPickDestination,
        onFaabChange: composer.setParticipantFaab,
    }

    const verdict = (
        <View style={styles.verdict}>
            {error || composer.rosterError || networkUnavailable ? <View style={styles.analysisError}>
                <Text accessibilityRole="alert" style={styles.offline}>{error || composer.rosterError || 'Could not load league teams.'}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Retry trade analysis"
                    onPress={() => { setMembersRetryToken((value) => value + 1); composer.retry(); retryAnalysis() }}>
                    <Text style={styles.copy}>Retry analysis</Text>
                </Pressable>
            </View> : null}
            <TradeAnalysisSummary players={Object.values(composer.participantRosters).flat()} analysis={shownAnalysis} calculatedAt={calculatedAt ?? undefined} participantName={analysisParticipantName}
                loading={loading} cached={!analysis && Boolean(shownAnalysis)} inset={!sideBySide} />
        </View>
    )

    if (showAnalysis) return <DeferredContent ready={!online || Boolean(error || composer.rosterError || networkUnavailable) || (membersLoaded && composer.assetsReady)}>
        <View style={styles.scroll}>
        <View style={styles.analysisActions}>
            <Button title="Edit assets" variant="secondary" size="sm" onPress={() => {
                setEditedSnapshot(shownAnalysis && routeSignature ? { routeSignature, value: {
                    modelVersion: TRADE_FORMULA_VERSION,
                    analysis: shownAnalysis,
                    participantNames: Object.fromEntries(shownAnalysis.teams.map(team => [team.memberId, analysisParticipantName(team.memberId)])),
                    savedAt: new Date().toISOString(), leagueId, memberId: myMemberId,
                } } : null)
                setHistorical(false)
                setShowAnalysis(false)
            }} />
            <Button title="Revalue" variant="secondary" size="sm" onPress={retryAnalysis}
                disabled={!networkAvailable || loading} accessibilityLabel="Revalue trade analysis" />
            {!historical ? <Button title="Make offer" size="sm" onPress={makeOffer} disabled={!canMakeOffer}
                accessibilityLabel="Make Offer from this analysis" /> : null}
        </View>
        <ScrollView contentContainerStyle={styles.content}>{verdict}</ScrollView>
        </View>
    </DeferredContent>

    return (
        <DeferredContent ready={membersLoaded || !online}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, sideBySide && styles.contentWide]} keyboardShouldPersistTaps="handled">
            <View style={[styles.main, sideBySide && styles.mainWide]}>
                <View style={styles.intro}>
                    {!online ? <Text style={styles.offline}>Offline</Text>
                        : networkUnavailable ? (
                            <View>
                                <Text style={styles.offline}>Could not load teams.</Text>
                                <Pressable onPress={() => setMembersRetryToken((value) => value + 1)} accessibilityRole="button"
                                    accessibilityLabel="Retry loading league teams" style={styles.cancel}>
                                    <Text style={styles.cancelText}>Retry</Text>
                                </Pressable>
                            </View>
                        ) : null}
                </View>
                <View style={styles.modeRow}>
                    <ModeButton label="2-Team" active={!multiTeamMode} onPress={() => setMode(false)} />
                    <ModeButton label="Multi-Team" active={multiTeamMode} onPress={() => setMode(true)} />
                    <Pressable style={[styles.makeOffer, !canMakeOffer && styles.disabled]} disabled={!canMakeOffer}
                        onPress={makeOffer} accessibilityRole="button" accessibilityState={{ disabled: !canMakeOffer }}
                        accessibilityLabel={networkAvailable ? 'Make Offer from this analysis' : 'Make Offer unavailable offline'} id="analyzer-make-offer">
                        <Text style={styles.makeOfferText}>Make offer</Text>
                    </Pressable>
                </View>
                {offerHelp && (items.length > 0 || !networkAvailable || isTradingClosed(currentLeague)) ? <Text style={styles.offerHelp} id="analyzer-offer-help">{offerHelp}</Text> : null}
                <NativeScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.teamTrack} contentContainerStyle={styles.teamChips}>
                    {members.map((member) => {
                        const active = composer.selectedParticipantIds.has(member.id)
                        return <Pressable key={member.id} style={[styles.teamChip, active && styles.teamChipActive]}
                            onPress={() => selectTeam(member.id)} accessibilityRole="button"
                            accessibilityState={{ selected: active }} accessibilityLabel={`${active ? 'Remove' : 'Analyze with'} ${member.team_name ?? 'Unnamed team'}`}>
                            <Text style={[styles.teamChipText, active && styles.teamChipTextActive]} numberOfLines={1}>{member.team_name ?? 'Unnamed'}</Text>
                        </Pressable>
                    })}
                </NativeScrollView>
                {(items.length > 0 || shownAnalysis) && !sideBySide ? <View style={styles.analysisActions}>
                    <Button title="View analysis" variant="secondary" size="sm" onPress={() => setShowAnalysis(true)}
                        disabled={!shownAnalysis && !error && !loading} accessibilityLabel="View trade analysis" />
                </View> : null}
                {composer.participantViews.length >= 2 ? <MultiTeamTradeBuilder {...builderProps} /> : (
                    <Text style={styles.emptyPrompt}>{multiTeamMode ? 'Choose two or more teams.' : 'Choose a team.'}</Text>
                )}
            </View>
            {sideBySide ? <View style={[styles.rail, Platform.OS === 'web' && styles.railSticky]}>{verdict}</View> : null}
        </ScrollView>
        </DeferredContent>
    )
}

function ModeButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
    return <Pressable style={[styles.modeButton, active && styles.modeButtonActive]} onPress={onPress}
        accessibilityRole="button" accessibilityState={{ selected: active }}><Text style={[styles.teamChipText, active && styles.teamChipTextActive]}>{label}</Text></Pressable>
}

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    content: { paddingBottom: spacing['4xl'] },
    contentWide: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', gap: spacing['3xl'] },
    main: { width: '100%', maxWidth: BUILDER_WIDTH, alignSelf: 'center' },
    mainWide: { flexShrink: 0, alignSelf: 'flex-start' },
    rail: { width: layout.railWidth, paddingTop: spacing.xl },
    // Keeps the verdict in view while the builder scrolls (web only).
    railSticky: { position: 'sticky', top: spacing.none } as unknown as ViewStyle,
    verdict: { gap: spacing.md },
    analysisError: { paddingHorizontal: spacing.xl, gap: spacing.sm },
    analysisActions: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.lg, gap: spacing.md },
    intro: { paddingHorizontal: spacing.lg, gap: spacing.xs },
    copy: { ...textStyles.body },
    offline: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.warningDark },
    modeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.xl, paddingTop: spacing.lg },
    modeButton: { minHeight: controlSize.minTouch, minWidth: componentTokens.tradeAnalyzer.teamTabWidth, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgMuted, borderRadius: radii.md, borderWidth: borderWidth.thin, borderColor: colors.borderLight },
    modeButtonActive: { backgroundColor: colors.primary, borderColor: colors.primary },
    teamTrack: { flexGrow: 0, minHeight: foundation.minTouch },
    teamChips: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    teamChip: { minHeight: foundation.minTouch, flexShrink: 0, justifyContent: 'center', paddingHorizontal: spacing.lg, backgroundColor: colors.bgMuted, borderRadius: radii.full },
    emptyPrompt: { ...textStyles.meta, padding: spacing.lg },
    teamChipActive: { backgroundColor: colors.primary },
    teamChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.textSecondary },
    teamChipTextActive: { color: colors.textWhite },
    makeOffer: { minHeight: foundation.minTouch, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderRadius: radii.md },
    makeOfferText: { color: colors.textWhite, fontSize: fontSize.md, fontWeight: fontWeight.bold },
    disabled: { opacity: 0.45 },
    offerHelp: { ...textStyles.meta, textAlign: 'center' },
    cancel: { minHeight: controlSize.button.md.height, minWidth: componentTokens.tradeAnalyzer.teamTabWidth, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgMuted, borderRadius: radii.md },
    cancelText: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
