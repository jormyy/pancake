import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    ScrollView,
    Platform,
    useWindowDimensions,
    type ViewStyle,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { isIneligibleIR, playerHeadshotUrl } from '@/lib/format'
import { getPlayer } from '@/lib/players'
import { submitWaiverClaim, getMyWaiverPriority } from '@/lib/waivers'
import { type MemberTransactionState } from '@/lib/league'
import { loadAddLimitState } from '@/lib/roster-add-flow'
import { addLimitSummary, reportPickupError } from '@/lib/pickup'
import { blockedActionProps } from '@/lib/a11y'
import { useAddLimitGate } from '@/hooks/use-add-limit-gate'
import { colors, controlSize, fontFamily, fontSize, fontWeight, layout, radii, spacing, table, textStyles, uiColors } from '@/constants/tokens'
import { usePageMetrics } from '@/components/ui'
import { showAlert, showSuccess } from '@/lib/alert'
import { Avatar } from '@/components/Avatar'

export default function ClaimPlayerScreen() {
    const { playerId } = useLocalSearchParams<{ playerId: string }>()
    const { current, currentLeague } = useLeagueContext()
    const { user } = useAuth()
    const router = useRouter()

    const [player, setPlayer] = useState<any>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [priority, setPriority] = useState<number | null>(null)
    const [transactionState, setTransactionState] = useState<MemberTransactionState | null>(null)
    const [bidInput, setBidInput] = useState('0')
    const [loading, setLoading] = useState(true)
    const [selectedDrop, setSelectedDrop] = useState<RosterPlayer | null>(null)
    const [submitting, setSubmitting] = useState(false)
    const claimLoadSeqRef = useRef(0)
    const { width, height } = useWindowDimensions()
    const [webViewport, setWebViewport] = useState({ width, height })
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return
        const syncViewport = () => setWebViewport({ width: window.innerWidth, height: window.innerHeight })
        syncViewport()
        window.addEventListener('resize', syncViewport)
        return () => window.removeEventListener('resize', syncViewport)
    }, [])
    const viewportWidth = Platform.OS === 'web' ? webViewport.width : width
    const viewportHeight = Platform.OS === 'web' ? webViewport.height : height
    const isCompactLandscape = viewportWidth > viewportHeight && viewportHeight < 520
    const { padX, usableWidth } = usePageMetrics()

    const rosterSize = currentLeague?.roster_size ?? 20
    const leagueId = currentLeague?.id
    const memberId = current?.id
    const userId = user?.id

    useEffect(() => {
        const requestId = ++claimLoadSeqRef.current
        setLoading(true)
        setPlayer(null)
        setMyRoster([])
        setPriority(null)
        setTransactionState(null)
        setSelectedDrop(null)
        setBidInput('0')
        async function load() {
            if (!memberId || !userId || !playerId || !leagueId) {
                if (claimLoadSeqRef.current === requestId) setLoading(false)
                return
            }
            const requestedPlayerId = playerId
            const requestedLeagueId = leagueId
            try {
                const [p, roster, prio, txState] = await Promise.all([
                    getPlayer(requestedPlayerId),
                    getRoster(memberId, requestedLeagueId),
                    getMyWaiverPriority(memberId, requestedLeagueId),
                    loadAddLimitState(memberId, requestedLeagueId),
                ])
                if (claimLoadSeqRef.current !== requestId) return
                setPlayer(p)
                setMyRoster(roster)
                setPriority(prio)
                setTransactionState(txState)
            } catch (e) {
                if (claimLoadSeqRef.current !== requestId) return
                console.error(e)
            } finally {
                if (claimLoadSeqRef.current === requestId) setLoading(false)
            }
        }
        load()
    }, [leagueId, memberId, playerId, userId])

    const refreshTransactionState = useCallback(async () => {
        if (!memberId || !leagueId) return
        setTransactionState(await loadAddLimitState(memberId, leagueId))
    }, [memberId, leagueId])

    const activeRoster = myRoster.filter((p) => !p.is_on_ir && !p.is_on_taxi)
    const ineligibleIR = myRoster.filter((r) => isIneligibleIR(r))
    const rosterFull = activeRoster.length >= rosterSize
    const needsDrop = rosterFull
    const { addBlockedReason, explainBlock } = useAddLimitGate({ transactionState, refresh: refreshTransactionState })

    async function handleSubmit() {
        if (!current || !user || !playerId || !currentLeague) return
        if (loading || !player) return
        if (explainBlock()) return
        if (needsDrop && !selectedDrop) {
            showAlert('Select Drop', 'Your roster is full. Select a player to drop.')
            return
        }
        const bidAmount = Math.max(0, parseInt(bidInput || '0', 10) || 0)
        if (transactionState?.waiverMode === 'faab' && bidAmount > transactionState.faabBalance) {
            showAlert('Invalid Bid', 'Your bid cannot exceed your available FAAB balance.')
            return
        }

        setSubmitting(true)
        try {
            await submitWaiverClaim(
                current.id,
                currentLeague.id,
                playerId,
                selectedDrop?.players.id,
                { bidAmount },
            )
            showSuccess(
                'Claim Submitted',
                'Your waiver claim has been submitted. Claims are processed nightly.',
            )
            router.back()
        } catch (e) {
            reportPickupError(e, { refresh: refreshTransactionState })
        } finally {
            setSubmitting(false)
        }
    }

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const processDateStr = tomorrow.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
    })
    const claimReady = !loading && !!player
    const submitDisabled = submitting || !claimReady || (needsDrop && !selectedDrop)
    const compactDropMode = isCompactLandscape && needsDrop
    const faab = transactionState?.waiverMode === 'faab'
    // Wide screens put the claim beside the drop list instead of stacking them.
    const twoColumn = needsDrop && !isCompactLandscape && usableWidth >= TWO_COLUMN_MIN
    const claimFacts = [
        `Processes ${processDateStr}`,
        transactionState ? `Adds ${transactionState.weeklyAddCount}/${transactionState.weeklyAddLimit ?? '∞'}` : null,
        faab ? null : `Priority #${priority ?? '—'}`,
    ].filter(Boolean).join(' · ')

    function setBid(value: string) {
        if (/^\d*$/.test(value)) setBidInput(value)
    }

    function renderAddLimitNotice() {
        if (!addBlockedReason) return null
        return (
            <View
                style={styles.limitCard}
                accessibilityLiveRegion="polite"
                role="status"
                testID="add-limit-notice"
            >
                <Text style={styles.limitBody}>{addBlockedReason}</Text>
                <Text style={styles.limitMeta}>{addLimitSummary(transactionState)}</Text>
            </View>
        )
    }

    function renderSubmitButton(compact: boolean) {
        return (
            <Pressable
                style={[styles.submitButton, compact && styles.compactSubmitButton, (submitDisabled || addBlockedReason != null) && styles.submitButtonDisabled]}
                onPress={handleSubmit}
                accessibilityRole="button"
                accessibilityLabel="Submit waiver claim"
                {...blockedActionProps(addBlockedReason, submitDisabled)}
                disabled={submitDisabled}
            >
                <Text style={styles.submitButtonText}>Submit Claim</Text>
            </Pressable>
        )
    }

    function renderScreenHeader() {
        return (
            <View style={[styles.screenHeader, { paddingHorizontal: padX }]}>
                <Pressable
                    onPress={() => router.back()}
                    style={styles.headerBack}
                    role="link"
                    aria-label="Back to player"
                    accessibilityRole="link"
                    accessibilityLabel="Back to player"
                >
                    <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
                </Pressable>
                <Text style={styles.screenTitle} numberOfLines={1}>
                    Waiver Claim
                </Text>
            </View>
        )
    }

    function renderClaimSummary() {
        return (
            <View style={styles.claimCard}>
                <Text style={styles.claimLabel}>Claiming</Text>
                <View style={styles.claimPlayerRow}>
                    <Avatar
                        name={player?.display_name ?? 'Player'}
                        uri={playerHeadshotUrl(player?.nba_id) ?? undefined}
                        color={colors.bgMuted}
                        textColor={colors.textSecondary}
                        size={44}
                    />
                    <View style={styles.claimPlayerCopy}>
                        <Text style={styles.claimName} numberOfLines={1}>{player?.display_name ?? '—'}</Text>
                        <Text style={styles.claimMeta} numberOfLines={1}>
                            {[player?.nba_team, player?.position].filter(Boolean).join(' · ')}
                        </Text>
                    </View>
                </View>
                <Text style={styles.claimFacts}>{claimFacts}</Text>
                {faab ? (
                    <View style={styles.bidRow}>
                        <Text style={styles.bidLabel}>FAAB bid</Text>
                        <View style={styles.bidField}>
                            <Text style={styles.bidCurrency}>$</Text>
                            <TextInput
                                style={styles.bidInput}
                                value={bidInput}
                                onChangeText={setBid}
                                keyboardType="numeric"
                                selectTextOnFocus
                                accessibilityLabel="FAAB bid amount"
                            />
                        </View>
                        <Text style={styles.bidBalance}>of ${transactionState?.faabBalance ?? 0}</Text>
                    </View>
                ) : null}
            </View>
        )
    }

    function renderDropSection() {
        if (!needsDrop) {
            return (
                <View style={styles.spaceNote}>
                    <Text style={styles.spaceNoteText}>You have roster space. No drop required.</Text>
                </View>
            )
        }
        return (
            <View style={styles.dropSection}>
                <View style={styles.dropHeading}>
                    {/* Literal casing: browser checks read this label verbatim. */}
                    <Text style={styles.sectionTitle}>
                        {compactDropMode ? 'DROP A PLAYER FOR CLAIM' : 'DROP A PLAYER (required)'}
                    </Text>
                    <Text style={styles.sectionSub}>
                        {compactDropMode
                            ? `Pick who goes if the claim for ${player?.display_name ?? 'this player'} wins.`
                            : 'Your roster is full. Pick who goes if this claim wins.'}
                    </Text>
                </View>
                <View style={styles.rosterList}>{renderRosterDropRows()}</View>
            </View>
        )
    }

    function renderRosterDropRows() {
        return activeRoster.map((item, index) => {
            const isSelected = selectedDrop?.id === item.id
            return (
                <Pressable
                    key={item.id}
                    style={[styles.rosterRow, index > 0 && styles.rosterRowDivider, isSelected && styles.rosterRowSelected]}
                    onPress={() => setSelectedDrop(isSelected ? null : item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Select ${item.players.display_name} to drop`}
                    accessibilityState={{ selected: isSelected }}
                >
                    <Avatar
                        name={item.players.display_name}
                        uri={playerHeadshotUrl(item.players.nba_id) ?? undefined}
                        color={colors.bgMuted}
                        textColor={colors.textSecondary}
                        size={32}
                    />
                    <View style={styles.rosterInfo}>
                        <Text style={styles.rosterName} numberOfLines={1}>{item.players.display_name}</Text>
                        <Text style={styles.rosterMeta} numberOfLines={1}>
                            {[item.players.nba_team, item.players.position]
                                .filter(Boolean)
                                .join(' · ')}
                        </Text>
                    </View>
                    <View style={[styles.check, isSelected && styles.checkSelected]}>
                        {isSelected && <MaterialIcons name="check" size={16} color={colors.textWhite} />}
                    </View>
                </Pressable>
            )
        })
    }

    function renderIneligibleIR() {
        return (
            <ScrollView
                style={styles.bodyScroll}
                contentContainerStyle={[styles.bodyContent, { paddingHorizontal: padX }]}
            >
                <View style={styles.blockCard}>
                    <MaterialIcons name="warning-amber" size={28} color={colors.warningDark} />
                    <Text style={styles.blockTitle}>Resolve IR Status First</Text>
                    <Text style={styles.blockSub}>
                        {ineligibleIR.length > 1
                            ? `${ineligibleIR.length} players on IR are no longer eligible. Activate or drop them before claiming.`
                            : 'A player on IR is no longer eligible. Activate or drop that player before claiming.'}
                    </Text>
                    {ineligibleIR.map((rp) => (
                        <View key={rp.id} style={styles.blockPlayerRow}>
                            <Avatar
                                name={rp.players.display_name}
                                uri={playerHeadshotUrl(rp.players.nba_id) ?? undefined}
                                color={colors.bgMuted}
                                textColor={colors.textSecondary}
                                size={32}
                            />
                            <Text style={styles.blockPlayerName}>{rp.players.display_name}</Text>
                            <Text style={styles.blockPlayerStatus}>{rp.players.injury_status ?? 'Healthy'}</Text>
                        </View>
                    ))}
                </View>
                <Pressable
                    style={styles.blockButton}
                    onPress={() => router.replace('/(tabs)/roster')}
                    accessibilityRole="button"
                    accessibilityLabel="Go to roster"
                >
                    <Text style={styles.blockButtonText}>Go to Roster</Text>
                </Pressable>
            </ScrollView>
        )
    }

    const bidFooter = faab && isCompactLandscape ? (
        <View style={styles.compactFooterRow}>
            <View style={styles.footerBidControl}>
                <Text style={styles.footerBidLabel}>FAAB</Text>
                <TextInput
                    style={styles.footerBidInput}
                    value={bidInput}
                    onChangeText={setBid}
                    keyboardType="numeric"
                    selectTextOnFocus
                    accessibilityLabel="FAAB bid amount"
                />
            </View>
            {renderSubmitButton(true)}
        </View>
    ) : renderSubmitButton(false)

    return (
        <>
            <Stack.Screen options={{ title: 'Waiver Claim', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {renderScreenHeader()}
                {ineligibleIR.length > 0 ? renderIneligibleIR() : twoColumn ? (
                    <ScrollView
                        style={styles.bodyScroll}
                        contentContainerStyle={[styles.bodyContent, styles.bodyContentWide, { paddingHorizontal: padX }]}
                        keyboardShouldPersistTaps="handled"
                    >
                        <View style={styles.columns}>
                            <View style={styles.sideColumn}>
                                {renderAddLimitNotice()}
                                {renderClaimSummary()}
                                {renderSubmitButton(false)}
                            </View>
                            <View style={styles.mainColumn}>{renderDropSection()}</View>
                        </View>
                    </ScrollView>
                ) : (
                    <>
                        <ScrollView
                            style={styles.bodyScroll}
                            contentContainerStyle={[styles.bodyContent, { paddingHorizontal: padX }]}
                            keyboardShouldPersistTaps="handled"
                        >
                            {renderAddLimitNotice()}
                            {!compactDropMode ? renderClaimSummary() : null}
                            {renderDropSection()}
                        </ScrollView>
                        <View style={[styles.footer, { paddingHorizontal: padX }]}>
                            <View style={styles.footerInner}>{bidFooter}</View>
                        </View>
                    </>
                )}
            </SafeAreaView>
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const TWO_COLUMN_MIN = 900

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        backgroundColor: colors.bgScreen,
    },
    headerBack: {
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    screenTitle: { ...textStyles.pageTitle, flex: 1 },
    bodyScroll: { flex: 1 },
    bodyContent: {
        width: '100%',
        maxWidth: layout.formMaxWidth,
        alignSelf: 'center',
        paddingTop: spacing.lg,
        paddingBottom: spacing.xl,
        gap: spacing.lg,
    },
    bodyContentWide: { maxWidth: layout.contentMaxWidth },
    columns: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing['3xl'] },
    // Sticky on web so Submit stays in view while the drop list scrolls.
    sideColumn: {
        width: 380,
        flexShrink: 0,
        gap: spacing.lg,
        ...(Platform.OS === 'web' ? ({ position: 'sticky', top: spacing.lg } as unknown as ViewStyle) : null),
    },
    mainColumn: { flex: 1, minWidth: 0 },

    limitCard: {
        padding: spacing.lg,
        backgroundColor: uiColors.brandSurfaceSoft,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        gap: spacing.xs,
    },
    limitBody: { ...textStyles.body },
    limitMeta: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: uiColors.brandText },

    claimCard: {
        padding: spacing.lg,
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        gap: spacing.md,
    },
    claimLabel: { ...textStyles.sectionLabel, color: colors.primaryDark },
    claimPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    claimPlayerCopy: { flex: 1, minWidth: 0, gap: spacing.xxs },
    claimName: { fontFamily: fontFamily.display, fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.textPrimary },
    claimMeta: { ...textStyles.meta },
    claimFacts: { ...textStyles.meta, color: colors.textSecondary },
    bidRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    bidLabel: { ...textStyles.rowTitle, flex: 1 },
    bidField: {
        flexDirection: 'row',
        alignItems: 'center',
        height: controlSize.field.md,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgInput,
    },
    bidCurrency: { fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textMuted },
    // 16px keeps iOS Safari from zooming into the field.
    bidInput: { width: 64, height: '100%', fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary, textAlign: 'right' },
    bidBalance: { ...textStyles.meta },

    dropSection: { gap: spacing.md },
    dropHeading: { gap: spacing.xs },
    sectionTitle: { ...textStyles.sectionLabel, textTransform: 'none' as const },
    sectionSub: { ...textStyles.meta },
    rosterList: {
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        overflow: 'hidden',
    },
    rosterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: table.rowHeight,
        paddingHorizontal: spacing.lg,
    },
    rosterRowDivider: { borderTopWidth: 1, borderTopColor: colors.separator },
    rosterRowSelected: { backgroundColor: uiColors.dangerSurface },
    rosterInfo: { flex: 1, minWidth: 0, gap: spacing.xxs },
    rosterName: { ...textStyles.rowTitle },
    rosterMeta: { ...textStyles.meta },
    check: {
        width: 24,
        height: 24,
        borderRadius: radii.full,
        borderWidth: 1.5,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    checkSelected: { backgroundColor: colors.danger, borderColor: colors.danger },

    spaceNote: {
        padding: spacing.lg,
        backgroundColor: uiColors.successSurface,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.successBorder,
    },
    spaceNoteText: { fontSize: fontSize.md, color: uiColors.successText, fontWeight: fontWeight.semibold, textAlign: 'center' },

    footer: {
        paddingTop: spacing.md,
        paddingBottom: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        backgroundColor: colors.bgScreen,
    },
    footerInner: { width: '100%', maxWidth: layout.formMaxWidth, alignSelf: 'center' },
    compactFooterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    footerBidControl: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        height: controlSize.field.md,
        paddingHorizontal: spacing.md,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgInput,
    },
    footerBidLabel: { ...textStyles.sectionLabel },
    footerBidInput: { width: 56, height: '100%', fontSize: fontSize.lg, fontWeight: fontWeight.bold, color: colors.textPrimary, textAlign: 'center' },
    submitButton: {
        height: controlSize.button.lg.height,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    compactSubmitButton: { flex: 1, height: controlSize.button.md.height },
    submitButtonDisabled: { opacity: 0.55 },
    submitButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },

    blockCard: {
        padding: spacing.xl,
        backgroundColor: colors.bgCard,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        alignItems: 'center',
        gap: spacing.md,
    },
    blockTitle: { fontFamily: fontFamily.display, fontSize: fontSize.xl, fontWeight: fontWeight.bold, color: colors.textPrimary, textAlign: 'center' },
    blockSub: { ...textStyles.body, textAlign: 'center' },
    blockPlayerRow: {
        alignSelf: 'stretch',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        minHeight: table.rowHeight,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
    },
    blockPlayerName: { ...textStyles.rowTitle, flex: 1, minWidth: 0 },
    blockPlayerStatus: { fontSize: fontSize.sm, fontWeight: fontWeight.bold, color: colors.dangerDark },
    blockButton: {
        height: controlSize.button.lg.height,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        justifyContent: 'center',
    },
    blockButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },
})
