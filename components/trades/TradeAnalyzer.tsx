import { TRADE_FORMULA_VERSION } from '@/core/src/dynasty/tradeScoring'
import { ScreenStatusScrollView as ScrollView } from '@/components/ui/ScreenStatusOverlay'
import { DeferredContent } from '@/components/ui/DeferredContent'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { DynastyTradeAnalysis } from '@pancake/core'
import { TradeAnalysisSummary } from '@/components/trades/TradeAnalysisSummary'
import { TradeValueCard } from '@/components/trades/TradeValueCard'
import { colors, controlSize, fontWeight, radii, spacing, textStyles, typeScale } from '@/constants/tokens'
import { usePageMetrics } from '@/components/ui/Page'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { useDynastyTradeAnalysis } from '@/hooks/use-dynasty-trade-analysis'
import { useMultiTeamTradeComposer } from '@/hooks/use-multi-team-trade-composer'
import { useOnlineStatus } from '@/hooks/use-online-status'
import { getLeagueMembers } from '@/lib/league'
import {
    dynastyAnalyzerLatestScopeCacheKey,
    dynastyAnalyzerRouteSignature,
    dynastyAnalyzerSnapshotCacheKey,
    dynastyScoringSignature,
    type DynastyAnalyzerCacheScope,
} from '@/lib/dynasty-decisions'
import { readPersistentCache, writePersistentCache } from '@/lib/persistent-cache'
import type { Trade } from '@/lib/trades'
import type { TradeComposerMember } from '@/lib/trade-ui-model'

type Snapshot = {
    modelVersion: string
    analysis: DynastyTradeAnalysis
    participantNames: Record<string, string>
    savedAt: string
    leagueId: string
    memberId: string
}

export default function TradeAnalyzer({ prefillTrade }: { prefillTrade: Trade }) {
    const { user } = useAuth()
    const { padX } = usePageMetrics()
    const { current, currentLeague } = useLeagueContext()
    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''
    const online = useOnlineStatus()
    const membersKey = user?.id && myMemberId && leagueId ? `pancake:analyzer-members:v1:${user.id}:${myMemberId}:${leagueId}` : null
    const [members, setMembers] = useState<TradeComposerMember[]>(() => membersKey ? readPersistentCache<TradeComposerMember[]>(membersKey) ?? [] : [])
    const [membersLoaded, setMembersLoaded] = useState(() => Boolean(membersKey && readPersistentCache<TradeComposerMember[]>(membersKey)))
    const [networkUnavailable, setNetworkUnavailable] = useState(false)
    const [membersRetryToken, setMembersRetryToken] = useState(0)
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
        tradeId: prefillTrade.id,
        scoringSettings: currentLeague?.scoring_settings,
        teams: teamCount,
        faabBudget,
        participants: composer.participantViews,
        historicalPicks: prefillTrade.routedItems.filter(item => item.kind === 'pick'),
        items,
    })
    const latestScopeKey = user?.id && myMemberId && leagueId
        ? dynastyAnalyzerLatestScopeCacheKey({ userId: user.id, memberId: myMemberId, leagueId })
        : null
    const lastCompleteScope = latestScopeKey ? readPersistentCache<DynastyAnalyzerCacheScope>(latestScopeKey) : null
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
    const cacheScope = liveCacheScope ?? lastCompleteScope
    const routeSignature = dynastyAnalyzerRouteSignature(items)
    const snapshotKey = cacheScope && routeSignature
        ? dynastyAnalyzerSnapshotCacheKey(cacheScope, `revaluation:${prefillTrade.id}:${routeSignature}`)
        : null
    const storedSnapshot = snapshotKey ? readPersistentCache<Snapshot>(snapshotKey) : null
    const cachedSnapshot = storedSnapshot?.leagueId === leagueId && storedSnapshot.memberId === myMemberId &&
        storedSnapshot.modelVersion === TRADE_FORMULA_VERSION ? storedSnapshot : null

    useEffect(() => {
        const cachedMembers = membersKey ? readPersistentCache<TradeComposerMember[]>(membersKey) : null
        setMembers(cachedMembers ?? [])
        setMembersLoaded(Boolean(cachedMembers))
        setNetworkUnavailable(false)
        prefillRef.current = ''
        resetComposer()
    }, [leagueId, membersKey, myMemberId, prefillTrade, resetComposer, user?.id])

    useEffect(() => {
        let active = true
        if (!leagueId || !online) return
        void getLeagueMembers(leagueId).then((rows) => {
            if (!active) return
            const available = rows.filter((member) => member.id !== myMemberId)
            if (membersKey) writePersistentCache(membersKey, available)
            setMembers(available)
            setMembersLoaded(true)
            setNetworkUnavailable(false)
        }).catch(() => {
            if (active) { setNetworkUnavailable(true); setMembersLoaded(true) }
        })
        return () => { active = false }
    }, [leagueId, membersKey, myMemberId, online, membersRetryToken, user?.id])

    useEffect(() => {
        if (prefillRef.current === prefillTrade.id) return
        prefillRef.current = prefillTrade.id
        prefillFromTrade(prefillTrade, myMemberId)
    }, [myMemberId, prefillFromTrade, prefillTrade])

    useEffect(() => {
        if (!liveCacheScope || !latestScopeKey || !snapshotKey || loading || error || !analysis || analysis.assets.length === 0) return
        writePersistentCache(snapshotKey, {
            modelVersion: TRADE_FORMULA_VERSION,
            analysis,
            participantNames: Object.fromEntries(analysis.teams.map((team) => [team.memberId, participantName(team.memberId)])),
            savedAt: new Date().toISOString(),
            leagueId,
            memberId: myMemberId,
        })
        writePersistentCache(latestScopeKey, liveCacheScope)
    }, [analysis, latestScopeKey, leagueId, liveCacheScope, myMemberId, participantName, snapshotKey, loading, error])

    const shownAnalysis = analysis ?? (!networkAvailable ? cachedSnapshot?.analysis ?? null : null)
    const analysisParticipantName = useCallback((memberId: string) => {
        const liveName = participantName(memberId)
        return liveName === 'Unnamed' ? cachedSnapshot?.participantNames?.[memberId] ?? liveName : liveName
    }, [cachedSnapshot?.participantNames, participantName])
    const failure = error || composer.rosterError || (networkUnavailable ? 'Could not load league teams.' : null)
    const retry = () => { setMembersRetryToken((value) => value + 1); composer.retry(); retryAnalysis() }

    return (
        <DeferredContent ready={!online || Boolean(failure) || (membersLoaded && composer.assetsReady)}>
            <ScrollView contentContainerStyle={[styles.content, { paddingHorizontal: padX }]}>
                <View style={styles.actions}>
                    <Text style={styles.caption} numberOfLines={1}>
                        {online ? 'Valued with current inputs' : 'Offline. Showing the last saved value.'}
                    </Text>
                    <Pressable
                        style={[styles.revalue, (!networkAvailable || loading) && styles.disabled]}
                        onPress={retryAnalysis}
                        disabled={!networkAvailable || loading}
                        accessibilityRole="button"
                        accessibilityLabel="Revalue trade analysis"
                        accessibilityState={{ disabled: !networkAvailable || loading }}
                    >
                        <Text style={styles.revalueText} numberOfLines={1}>Revalue</Text>
                    </Pressable>
                </View>
                {failure ? (
                    <Pressable style={styles.errorRow} onPress={retry} accessibilityRole="button" accessibilityLabel="Retry trade analysis">
                        <Text accessibilityRole="alert" style={styles.errorText} numberOfLines={2}>{failure} Tap to retry.</Text>
                    </Pressable>
                ) : null}
                <TradeValueCard
                    analysis={shownAnalysis}
                    loading={loading}
                    empty={false}
                    myMemberId={myMemberId}
                    participantIds={composer.participantIds}
                    participantName={analysisParticipantName}
                />
                <TradeAnalysisSummary players={Object.values(composer.participantRosters).flat()} analysis={shownAnalysis}
                    calculatedAt={calculatedAt ?? undefined} participantName={analysisParticipantName}
                    loading={loading} cached={!analysis && Boolean(shownAnalysis)} inset={false} />
            </ScrollView>
        </DeferredContent>
    )
}

const styles = StyleSheet.create({
    content: { width: '100%', alignSelf: 'center', gap: spacing.md, paddingTop: spacing.md, paddingBottom: spacing['3xl'] },
    actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
    caption: { ...textStyles.meta, flex: 1, minWidth: 0 },
    revalue: {
        flexShrink: 0,
        minHeight: controlSize.minTouch,
        minWidth: controlSize.minTouch + spacing['3xl'],
        paddingHorizontal: spacing.lg,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    revalueText: { ...typeScale.small, fontWeight: fontWeight.semibold, color: colors.primaryDark },
    disabled: { opacity: 0.5 },
    errorRow: { minHeight: controlSize.minTouch, justifyContent: 'center' },
    errorText: { ...typeScale.small, fontWeight: fontWeight.bold, color: colors.warningDark },
})
