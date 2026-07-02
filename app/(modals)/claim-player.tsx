import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    TextInput,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { useLeagueContext } from '@/contexts/league-context'
import { useAuth } from '@/hooks/use-auth'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { isIneligibleIR } from '@/lib/format'
import { getPlayer } from '@/lib/players'
import { submitWaiverClaim, getMyWaiverPriority } from '@/lib/waivers'
import { getMemberTransactionState, type MemberTransactionState } from '@/lib/league'
import { LoadingScreen } from '@/components/LoadingScreen'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { showAlert, showSuccess, getErrorMessage } from '@/lib/alert'

export default function ClaimPlayerScreen() {
    const { playerId } = useLocalSearchParams<{ playerId: string }>()
    const { current, currentLeague } = useLeagueContext()
    const { user } = useAuth()
    const { back } = useRouter()

    const [player, setPlayer] = useState<any>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [priority, setPriority] = useState<number | null>(null)
    const [transactionState, setTransactionState] = useState<MemberTransactionState | null>(null)
    const [bidInput, setBidInput] = useState('0')
    const [loading, setLoading] = useState(true)
    const [selectedDrop, setSelectedDrop] = useState<RosterPlayer | null>(null)
    const [submitting, setSubmitting] = useState(false)

    const rosterSize = currentLeague?.roster_size ?? 20
    const leagueId = currentLeague?.id

    useEffect(() => {
        async function load() {
            if (!current || !user || !playerId || !leagueId) return
            try {
                const [p, roster, prio, txState] = await Promise.all([
                    getPlayer(playerId),
                    getRoster(current.id, leagueId),
                    getMyWaiverPriority(current.id, leagueId),
                    getMemberTransactionState(current.id, leagueId),
                ])
                setPlayer(p)
                setMyRoster(roster)
                setPriority(prio)
                setTransactionState(txState)
            } catch (e) {
                console.error(e)
            } finally {
                setLoading(false)
            }
        }
        load()
    }, [playerId, current, user, leagueId])

    const activeRoster = myRoster.filter((p) => !p.is_on_ir && !p.is_on_taxi)
    const ineligibleIR = myRoster.filter((r) => isIneligibleIR(r))
    const rosterFull = activeRoster.length >= rosterSize
    const needsDrop = rosterFull

    async function handleSubmit() {
        if (!current || !user || !playerId || !currentLeague) return
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
            back()
        } catch (e) {
            showAlert('Error', getErrorMessage(e))
        } finally {
            setSubmitting(false)
        }
    }

    if (loading) {
        return <LoadingScreen />
    }

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const processDateStr = tomorrow.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: 'America/New_York',
    })

    return (
        <>
            <Stack.Screen options={{ title: 'Waiver Claim', presentation: 'modal' }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {ineligibleIR.length > 0 ? (
                    <>
                        <View style={styles.blockCard}>
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
                                    <Text style={styles.blockPlayerName}>{rp.players.display_name}</Text>
                                    <Text style={styles.blockPlayerStatus}>{rp.players.injury_status ?? 'Healthy'}</Text>
                                </View>
                            ))}
                        </View>
                        <Pressable
                            style={styles.blockButton}
                            onPress={() => back()}
                            accessibilityRole="button"
                            accessibilityLabel="Go to roster"
                        >
                            <Text style={styles.blockButtonText}>Go to Roster</Text>
                        </Pressable>
                    </>
                ) : (
                    <>
                        {/* Player being claimed */}
                        <View style={styles.claimCard}>
                            <Text style={styles.claimLabel}>CLAIMING</Text>
                            <Text style={styles.claimName}>{player?.display_name ?? '—'}</Text>
                            <Text style={styles.claimMeta}>
                                {[player?.nba_team, player?.position].filter(Boolean).join(' · ')}
                            </Text>
                        </View>

                        <View style={styles.infoRow}>
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

                        {transactionState?.waiverMode === 'faab' ? (
                            <View style={styles.bidCard}>
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
                                <Text style={styles.sectionTitle}>DROP A PLAYER (required)</Text>
                                <Text style={styles.sectionSub}>Your roster is full. Select one player to drop if this claim succeeds.</Text>
                                <FlashList
                                    data={activeRoster}
                                    keyExtractor={(item) => item.id}
                                    contentContainerStyle={styles.rosterList}
                                    renderItem={({ item }) => {
                                        const isSelected = selectedDrop?.id === item.id
                                        return (
                                            <Pressable
                                                style={[styles.rosterRow, isSelected && styles.rosterRowSelected]}
                                                onPress={() => setSelectedDrop(isSelected ? null : item)}
                                                accessibilityRole="button"
                                                accessibilityLabel={`Select ${item.players.display_name} to drop`}
                                                accessibilityState={{ selected: isSelected }}
                                            >
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
                                    }}
                                />
                            </>
                        ) : (
                            <View style={styles.spaceNote}>
                                <Text style={styles.spaceNoteText}>
                                    You have roster space. No drop required.
                                </Text>
                            </View>
                        )}

                        <View style={styles.footer}>
                            <Pressable
                                style={[styles.submitButton, (needsDrop && !selectedDrop) && styles.submitButtonDisabled]}
                                onPress={handleSubmit}
                                accessibilityRole="button"
                                accessibilityLabel="Submit waiver claim"
                                disabled={submitting || (needsDrop && !selectedDrop)}
                            >
                                {submitting ? (
                                    <ActivityIndicator color={colors.textWhite} />
                                ) : (
                                    <Text style={styles.submitButtonText}>Submit Claim</Text>
                                )}
                            </Pressable>
                        </View>
                    </>
                )}
            </SafeAreaView>
        </>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgSubtle },
    flex1: { flex: 1 },

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
    claimLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.info, letterSpacing: 1 },
    claimName: { fontSize: 22, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    claimMeta: { fontSize: fontSize.md, color: colors.textMuted },

    infoRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginHorizontal: spacing.xl,
        marginBottom: spacing.xl,
        gap: spacing.lg,
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
    infoLabel: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder, letterSpacing: 0.5 },
    infoValue: { fontSize: 18, fontWeight: fontWeight.extrabold, color: colors.textPrimary },

    bidCard: {
        marginHorizontal: spacing.xl,
        marginBottom: spacing.xl,
        gap: spacing.sm,
    },
    bidLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0.8,
    },
    bidInput: {
        height: 48,
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
        letterSpacing: 0.8,
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.xs,
    },
    sectionSub: {
        fontSize: fontSize.sm,
        color: colors.textMuted,
        marginHorizontal: spacing['2xl'],
        marginBottom: spacing.lg,
    },

    rosterList: { paddingHorizontal: spacing.xl, gap: spacing.md },
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
    },
    rosterRowSelected: { borderColor: colors.danger, backgroundColor: palette.red50 },
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
        backgroundColor: palette.green50,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: palette.green200,
    },
    spaceNoteText: { fontSize: fontSize.md, color: palette.green800, fontWeight: fontWeight.semibold, textAlign: 'center' },

    footer: { padding: spacing.xl, paddingBottom: spacing.md },
    submitButton: {
        backgroundColor: colors.info,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        height: 52,
        justifyContent: 'center',
        alignItems: 'center',
    },
    submitButtonDisabled: { backgroundColor: palette.purple300 },
    submitButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg },

    // IR blocking styles
    blockCard: {
        margin: spacing.xl,
        padding: spacing['2xl'],
        backgroundColor: colors.bgScreen,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: palette.maple200,
        gap: spacing.lg,
    },
    blockIconContainer: {
        width: 56,
        height: 56,
        borderRadius: 28,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.maple100,
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
        backgroundColor: palette.maple50,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
    },
    blockPlayerName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    blockPlayerStatus: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: palette.maple600,
    },
    blockButton: {
        margin: spacing.xl,
        backgroundColor: colors.primary,
        paddingVertical: spacing.lg + spacing.xxs,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        alignItems: 'center',
    },
    blockButtonText: {
        color: colors.textWhite,
        fontSize: fontSize.lg,
        fontWeight: fontWeight.bold,
    },
})
