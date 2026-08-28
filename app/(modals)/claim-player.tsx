import {
    View,
    Text,
    Pressable,
    StyleSheet,
    TextInput,
    ScrollView,
    Platform,
    useWindowDimensions,
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
import { colors, fontSize, fontWeight, radii, spacing, uiColors } from '@/constants/tokens'
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
        // Claims count as adds when they process, and the server rejects a
        // claim submitted after this week's adds are used up.
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

    function renderAddLimitNotice() {
        if (!addBlockedReason) return null
        return (
            <View
                style={[styles.limitCard, isCompactLandscape && styles.compactLimitCard]}
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
            <View style={styles.screenHeader}>
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

    function renderRosterDropRows() {
        return activeRoster.map((item) => {
            const isSelected = selectedDrop?.id === item.id
            return (
                <Pressable
                    key={item.id}
                    style={[styles.rosterRow, compactDropMode && styles.compactRosterRow, isSelected && styles.rosterRowSelected]}
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
                        size={38}
                    />
                    <View style={styles.rosterInfo}>
                        <Text style={styles.rosterName}>{item.players.display_name}</Text>
                        <Text style={styles.rosterMeta}>
                            {[item.players.nba_team, item.players.position]
                                .filter(Boolean)
                                .join(' · ')}
                        </Text>
                    </View>
                    <View style={[styles.check, isSelected && styles.checkSelected]}>
                        {isSelected && <Text style={styles.checkText}>✓</Text>}
                    </View>
                </Pressable>
            )
        })
    }

    return (
        <>
            <Stack.Screen options={{ title: 'Waiver Claim', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {renderScreenHeader()}
                {ineligibleIR.length > 0 ? (
                    <ScrollView
                        style={styles.bodyScroll}
                        contentContainerStyle={[styles.bodyContent, isCompactLandscape && styles.compactBodyContent]}
                    >
                        <View style={[styles.blockCard, isCompactLandscape && styles.compactBlockCard]}>
                            <View style={styles.blockIconContainer}>
                                <Text style={styles.blockIcon}>⚠️</Text>
                            </View>
                            <Text style={styles.blockTitle}>Resolve IR Status First</Text>
                            <Text style={styles.blockSub}>
                                You have {ineligibleIR.length} player{ineligibleIR.length > 1 ? 's' : ''} on IR who {' '}
                                {ineligibleIR.length > 1 ? 'are' : 'is'} not eligible. You must activate or drop
                                them before placing waiver claims.
                            </Text>
                            {ineligibleIR.map((rp) => (
                                <View key={rp.id} style={styles.blockPlayerRow}>
                                    <Avatar
                                        name={rp.players.display_name}
                                        uri={playerHeadshotUrl(rp.players.nba_id) ?? undefined}
                                        color={colors.bgMuted}
                                        textColor={colors.textSecondary}
                                        size={34}
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
                ) : (
                    <>
                        <ScrollView
                            style={styles.bodyScroll}
                            contentContainerStyle={[styles.bodyContent, isCompactLandscape && styles.compactBodyContent]}
                            keyboardShouldPersistTaps="handled"
                        >
                            {renderAddLimitNotice()}
                            {!compactDropMode ? (
                                <>
                                    <View style={[styles.claimCard, isCompactLandscape && styles.compactClaimCard]}>
                                <Text style={styles.claimLabel}>CLAIMING</Text>
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
                                        <Text style={styles.claimMeta}>
                                            {[player?.nba_team, player?.position].filter(Boolean).join(' · ')}
                                        </Text>
                                    </View>
                                </View>
                            </View>

                            <View style={[styles.infoRow, isCompactLandscape && styles.compactInfoRow]}>
                            <View style={styles.infoCell}>
                                <Text style={styles.infoLabel}>
                                    {transactionState?.waiverMode === 'faab' ? 'FAAB Balance' : 'Your Priority'}
                                </Text>
                                <Text style={styles.infoValue}>
                                    {transactionState?.waiverMode === 'faab' ? `$${transactionState.faabBalance}` : `#${priority ?? '—'}`}
                                </Text>
                            </View>
                            <View style={styles.infoCell}>
                                <Text style={styles.infoLabel}>Process Date</Text>
                                <Text style={styles.infoValue}>{processDateStr}</Text>
                            </View>
                            <View style={styles.infoCell}>
                                <Text style={styles.infoLabel}>Weekly Adds</Text>
                                <Text style={styles.infoValue}>
                                    {transactionState
                                        ? `${transactionState.weeklyAddCount}/${transactionState.weeklyAddLimit ?? '∞'}`
                                    : '—'}
                                </Text>
                            </View>
                            </View>
                                </>
                            ) : null}

                            {transactionState?.waiverMode === 'faab' && !isCompactLandscape ? (
                                <View style={[styles.bidCard, isCompactLandscape && styles.compactBidCard]}>
                                <Text style={styles.bidLabel}>FAAB BID</Text>
                                <TextInput
                                    style={styles.bidInput}
                                    value={bidInput}
                                    onChangeText={(value) => {
                                        if (/^\d*$/.test(value)) setBidInput(value)
                                    }}
                                    keyboardType="numeric"
                                    selectTextOnFocus
                                    accessibilityLabel="FAAB bid amount"
                                />
                            </View>
                            ) : null}

                            {needsDrop ? (
                                <>
                                <Text style={[styles.sectionTitle, compactDropMode && styles.compactSectionTitle]}>
                                    {compactDropMode ? 'DROP A PLAYER FOR CLAIM' : 'DROP A PLAYER (required)'}
                                </Text>
                                <Text style={[styles.sectionSub, compactDropMode && styles.compactSectionSub]}>
                                    {compactDropMode
                                        ? `Select one player to drop if your claim for ${player?.display_name ?? 'this player'} succeeds.`
                                        : 'Your roster is full. Select one player to drop if this claim succeeds.'}
                                </Text>
                                    <View style={[styles.rosterList, compactDropMode && styles.compactRosterList]}>{renderRosterDropRows()}</View>
                                </>
                            ) : (
                                <View style={[styles.spaceNote, isCompactLandscape && styles.compactSpaceNote]}>
                                <Text style={styles.spaceNoteText}>
                                    You have roster space. No drop required.
                                </Text>
                            </View>
                            )}
                        </ScrollView>

                        <View style={styles.footer}>
                            {transactionState?.waiverMode === 'faab' && isCompactLandscape ? (
                                <View style={styles.compactFooterRow}>
                                    <View style={styles.footerBidControl}>
                                        <Text style={styles.footerBidLabel}>FAAB</Text>
                                        <TextInput
                                            style={styles.footerBidInput}
                                            value={bidInput}
                                            onChangeText={(value) => {
                                                if (/^\d*$/.test(value)) setBidInput(value)
                                            }}
                                            keyboardType="numeric"
                                            selectTextOnFocus
                                            accessibilityLabel="FAAB bid amount"
                                        />
                                    </View>
                                    {renderSubmitButton(true)}
                                </View>
                            ) : renderSubmitButton(false)}
                        </View>
                    </>
                )}
            </SafeAreaView>
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    screenHeader: {
        minHeight: 56,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.md,
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
    screenTitle: {
        flex: 1,
        color: colors.textPrimary,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
    },
    bodyScroll: { flex: 1 },
    bodyContent: { paddingBottom: spacing.md },
    compactBodyContent: { width: '100%', maxWidth: 680, alignSelf: 'center', paddingBottom: spacing.sm },

    claimCard: {
        margin: spacing.xl,
        padding: spacing['2xl'],
        backgroundColor: colors.bgScreen,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        gap: spacing.xs,
    },
    compactClaimCard: {
        marginHorizontal: spacing['2xl'],
        marginVertical: spacing.md,
        padding: spacing.lg,
    },
    limitCard: {
        marginHorizontal: spacing.xl,
        marginTop: spacing.xl,
        padding: spacing.lg,
        backgroundColor: uiColors.brandSurfaceSoft,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.brandBorder,
        gap: spacing.xs,
    },
    compactLimitCard: {
        marginHorizontal: spacing['2xl'],
        marginTop: spacing.md,
        padding: spacing.md,
    },
    limitBody: { fontSize: fontSize.sm, color: colors.textSecondary, lineHeight: 20 },
    limitMeta: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: uiColors.brandText },
    claimLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.primaryDark, letterSpacing: 0 },
    claimPlayerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    claimPlayerCopy: { flex: 1, minWidth: 0 },
    claimName: { fontSize: 22, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    claimMeta: { fontSize: fontSize.md, color: colors.textMuted },

    infoRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginHorizontal: spacing.xl,
        marginBottom: spacing.xl,
        gap: spacing.lg,
    },
    compactInfoRow: {
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.md,
        gap: spacing.md,
    },
    infoCell: {
        flex: 1,
        minWidth: 104,
        backgroundColor: colors.bgScreen,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: 14,
        alignItems: 'center',
        gap: spacing.xs,
    },
    infoLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder, letterSpacing: 0 },
    infoValue: { fontSize: 18, fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    bidCard: {
        marginHorizontal: spacing.xl,
        marginBottom: spacing.xl,
        gap: spacing.sm,
    },
    compactBidCard: {
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.md,
    },
    bidLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
    },
    bidInput: {
        height: 50,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgScreen,
        paddingHorizontal: spacing.lg,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },

    sectionTitle: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0,
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.xs,
    },
    compactSectionTitle: {
        marginHorizontal: spacing['2xl'],
        marginTop: spacing.md,
        marginBottom: spacing.xxs,
    },
    sectionSub: {
        fontSize: fontSize.sm,
        color: colors.textMuted,
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.lg,
    },
    compactSectionSub: {
        fontSize: fontSize.sm,
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.sm,
    },

    rosterList: { paddingHorizontal: spacing.xl, gap: spacing.md },
    compactRosterList: { paddingHorizontal: spacing['2xl'], gap: spacing.sm },
    rosterRow: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.bgScreen,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.borderLight,
        padding: 14,
        gap: spacing.lg,
        minHeight: 56,
    },
    compactRosterRow: {
        minHeight: 50,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
    },
    rosterRowSelected: { borderColor: colors.danger, backgroundColor: uiColors.dangerSurface },
    rosterInfo: { flex: 1, gap: spacing.xxs },
    rosterName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    rosterMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    check: {
        width: 24,
        height: 24,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1.5,
        borderColor: colors.border,
        justifyContent: 'center',
        alignItems: 'center',
    },
    checkSelected: { backgroundColor: colors.danger, borderColor: colors.danger },
    checkText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },

    spaceNote: {
        margin: spacing.xl,
        padding: spacing.xl,
        backgroundColor: uiColors.successSurface,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.successBorder,
    },
    compactSpaceNote: {
        marginHorizontal: spacing['2xl'],
        marginVertical: spacing.md,
        padding: spacing.lg,
    },
    spaceNoteText: { fontSize: fontSize.md, color: uiColors.successText, fontWeight: fontWeight.semibold, textAlign: 'center' },

    footer: {
        padding: spacing.xl,
        paddingBottom: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.borderLight,
        backgroundColor: colors.bgScreen,
    },
    compactFooterRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    footerBidControl: {
        width: 178,
        height: 52,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgInput,
    },
    footerBidLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
    },
    footerBidInput: {
        flex: 1,
        minWidth: 44,
        height: 50,
        paddingHorizontal: 0,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    submitButton: {
        backgroundColor: colors.primary,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    compactSubmitButton: { flex: 1 },
    submitButtonDisabled: { opacity: 0.55 },
    submitButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },

    // IR blocking styles
    blockCard: {
        margin: spacing.xl,
        padding: spacing['2xl'],
        backgroundColor: colors.bgScreen,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: uiColors.brandBorder,
        gap: spacing.lg,
    },
    compactBlockCard: {
        marginHorizontal: spacing['2xl'],
        marginVertical: spacing.md,
        padding: spacing.lg,
        gap: spacing.md,
    },
    blockIconContainer: {
        width: 56,
        height: 56,
        borderRadius: 28,
        borderCurve: 'continuous' as const,
        backgroundColor: uiColors.brandSurface,
        justifyContent: 'center',
        alignItems: 'center',
        alignSelf: 'center',
        marginBottom: spacing.md,
    },
    blockIcon: { fontSize: 28 },
    blockTitle: {
        fontSize: 18,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
        textAlign: 'center',
    },
    blockSub: {
        fontSize: fontSize.md,
        color: colors.textSecondary,
        textAlign: 'center',
        lineHeight: 22,
    },
    blockPlayerRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: uiColors.brandSurfaceSoft,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        minHeight: 44,
    },
    blockPlayerName: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    blockPlayerStatus: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: uiColors.brandText,
    },
    blockButton: {
        margin: spacing.xl,
        backgroundColor: colors.primary,
        paddingVertical: spacing.lg + spacing.xxs,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
        minHeight: 50,
        justifyContent: 'center',
    },
    blockButtonText: {
        color: colors.textWhite,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
    },
})
