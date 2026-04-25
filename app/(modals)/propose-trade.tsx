import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
    ScrollView,
    TextInput,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getLeagueMembers } from '@/lib/league'
import { getRoster, RosterPlayer } from '@/lib/roster'
import { proposeTrade, getCurrentSeasonId, getPicksForMember, TradePickItem } from '@/lib/trades'

import { getInitials } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import { colors, palette, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'

function yearShort(year: number): string {
    return String(year).slice(2)
}

function PlayerRow({
    player,
    selected,
    onToggle,
}: {
    player: RosterPlayer
    selected: boolean
    onToggle: () => void
}) {
    const p = player.players
    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}

        >
            <Avatar
                name={p.display_name}
                color={selected ? colors.primary : palette.gray300}
                size={40}
            />
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {p.display_name}
                </Text>
                <Text style={styles.playerMeta}>
                    {[p.position, p.nba_team].filter(Boolean).join(' · ')}
                    {player.is_on_ir ? ' · IR' : ''}
                </Text>
            </View>
            {selected && (
                <View style={styles.checkBadge}>
                    <Text style={styles.checkBadgeText}>+</Text>
                </View>
            )}
        </Pressable>
    )
}

function PickRow({
    pick,
    selected,
    onToggle,
}: {
    pick: TradePickItem
    selected: boolean
    onToggle: () => void
}) {
    return (
        <Pressable
            style={[styles.playerRow, selected && styles.playerRowSelected]}
            onPress={onToggle}

        >
            <View style={[styles.pickCircle, selected && styles.pickCircleSelected]}>
                <Text style={styles.pickCircleText}>{yearShort(pick.seasonYear)}</Text>
            </View>
            <View style={styles.playerInfo}>
                <Text style={[styles.playerName, selected && styles.playerNameSelected]}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                <Text style={styles.playerMeta}>via {pick.originalTeamName}</Text>
            </View>
            {selected && (
                <View style={styles.checkBadge}>
                    <Text style={styles.checkBadgeText}>+</Text>
                </View>
            )}
        </Pressable>
    )
}

export default function ProposeTradeScreen() {
    const { user } = useAuth()
    const { current, currentLeague } = useLeagueContext()
    const params = useLocalSearchParams<{ recipientMemberId?: string }>()
    const { back } = useRouter()

    const myMemberId = current?.id ?? ''
    const leagueId = currentLeague?.id ?? ''

    const [members, setMembers] = useState<any[]>([])
    const [selectedRecipientId, setSelectedRecipientId] = useState<string | null>(
        params.recipientMemberId ?? null,
    )
    const [theirRoster, setTheirRoster] = useState<RosterPlayer[]>([])
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [myPicks, setMyPicks] = useState<TradePickItem[]>([])
    const [theirPicks, setTheirPicks] = useState<TradePickItem[]>([])
    const [requestIds, setRequestIds] = useState<Set<string>>(new Set())
    const [offerIds, setOfferIds] = useState<Set<string>>(new Set())
    const [offerPickIds, setOfferPickIds] = useState<Set<string>>(new Set())
    const [requestPickIds, setRequestPickIds] = useState<Set<string>>(new Set())
    const [notes, setNotes] = useState('')
    const [loading, setLoading] = useState(true)
    const [rosterLoading, setRosterLoading] = useState(false)
    const [submitting, setSubmitting] = useState(false)

    // Load league members (excluding self)
    useEffect(() => {
        if (!leagueId) return
        getLeagueMembers(leagueId)
            .then((all) => {
                setMembers(all.filter((m) => m.id !== myMemberId))
            })
            .catch(console.error)
            .finally(() => setLoading(false))
    }, [leagueId, myMemberId])

    // Load rosters and picks when recipient changes
    const loadRosters = useCallback(async () => {
        if (!selectedRecipientId || !leagueId || !myMemberId) return
        setRosterLoading(true)
        setRequestIds(new Set())
        setOfferIds(new Set())
        setOfferPickIds(new Set())
        setRequestPickIds(new Set())
        try {
            const [theirData, myData, theirPicksData, myPicksData] = await Promise.all([
                getRoster(selectedRecipientId, leagueId),
                getRoster(myMemberId, leagueId),
                getPicksForMember(selectedRecipientId, leagueId),
                getPicksForMember(myMemberId, leagueId),
            ])
            setTheirRoster(theirData)
            setMyRoster(myData)
            setTheirPicks(theirPicksData)
            setMyPicks(myPicksData)
        } catch (e) {
            console.error(e)
        } finally {
            setRosterLoading(false)
        }
    }, [selectedRecipientId, leagueId, myMemberId])

    useEffect(() => {
        loadRosters()
    }, [loadRosters])

    function toggleRequest(playerId: string) {
        setRequestIds((prev) => {
            const next = new Set(prev)
            if (next.has(playerId)) next.delete(playerId)
            else next.add(playerId)
            return next
        })
    }

    function toggleOffer(playerId: string) {
        setOfferIds((prev) => {
            const next = new Set(prev)
            if (next.has(playerId)) next.delete(playerId)
            else next.add(playerId)
            return next
        })
    }

    function toggleOfferPick(pickId: string) {
        setOfferPickIds((prev) => {
            const next = new Set(prev)
            if (next.has(pickId)) next.delete(pickId)
            else next.add(pickId)
            return next
        })
    }

    function toggleRequestPick(pickId: string) {
        setRequestPickIds((prev) => {
            const next = new Set(prev)
            if (next.has(pickId)) next.delete(pickId)
            else next.add(pickId)
            return next
        })
    }

    async function handleSubmit() {
        if (!selectedRecipientId) return
        const hasOffer = offerIds.size > 0 || offerPickIds.size > 0
        const hasRequest = requestIds.size > 0 || requestPickIds.size > 0
        if (!hasOffer || !hasRequest) return
        setSubmitting(true)
        try {
            const seasonId = await getCurrentSeasonId(leagueId)
            if (!seasonId) throw new Error('No active season found.')

            await proposeTrade(
                myMemberId,
                leagueId,
                seasonId,
                selectedRecipientId,
                Array.from(offerIds),
                Array.from(requestIds),
                Array.from(offerPickIds),
                Array.from(requestPickIds),
                notes.trim() || undefined,
            )

            Alert.alert('Trade Proposed', 'Your trade offer has been sent.', [
                { text: 'OK', onPress: () => back() },
            ])
        } catch (e: any) {
            Alert.alert('Error', e.message ?? 'Could not propose trade.')
        } finally {
            setSubmitting(false)
        }
    }

    const recipientTeamName =
        members.find((m) => m.id === selectedRecipientId)?.team_name ?? 'Opponent'

    const hasOffer = offerIds.size > 0 || offerPickIds.size > 0
    const hasRequest = requestIds.size > 0 || requestPickIds.size > 0
    const canSubmit = selectedRecipientId !== null && hasOffer && hasRequest && !submitting

    if (!current) {
        return (
            <SafeAreaView style={styles.container} edges={['top']}>
                <View style={styles.emptyCenter}>
                    <Text style={styles.emptyText}>No active league.</Text>
                </View>
            </SafeAreaView>
        )
    }

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            {/* Header */}
            <View style={styles.header}>
                <Pressable onPress={() => back()} style={styles.cancelBtn}>
                    <Text style={styles.cancelBtnText}>Cancel</Text>
                </Pressable>
                <Text style={styles.headerTitle}>Propose Trade</Text>
                <Pressable
                    onPress={handleSubmit}
                    style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
                    disabled={!canSubmit}
                >
                    {submitting ? (
                        <ActivityIndicator size="small" color={colors.textWhite} />
                    ) : (
                        <Text style={styles.submitBtnText}>Send</Text>
                    )}
                </Pressable>
            </View>

            <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                {/* Team picker */}
                <Text style={styles.sectionLabel}>TRADE WITH</Text>
                {loading ? (
                    <ActivityIndicator color={colors.primary} style={{ margin: spacing.xl }} />
                ) : (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.teamChips}
                    >
                        {members.map((m) => {
                            const active = selectedRecipientId === m.id
                            return (
                                <Pressable
                                    key={m.id}
                                    style={[styles.teamChip, active && styles.teamChipActive]}
                                    onPress={() => setSelectedRecipientId(m.id)}
                                >
                                    <Text
                                        style={[
                                            styles.teamChipText,
                                            active && styles.teamChipTextActive,
                                        ]}
                                    >
                                        {m.team_name ?? 'Unnamed'}
                                    </Text>
                                </Pressable>
                            )
                        })}
                    </ScrollView>
                )}

                {selectedRecipientId && (
                    <>
                        {rosterLoading ? (
                            <ActivityIndicator color={colors.primary} style={{ margin: spacing['3xl'] }} />
                        ) : (
                            <>
                                {/* YOU RECEIVE section */}
                                <Text style={styles.sectionLabel}>
                                    YOU RECEIVE — from {recipientTeamName}
                                </Text>
                                {theirRoster.length === 0 ? (
                                    <Text style={styles.emptyRowText}>No players on their roster.</Text>
                                ) : (
                                    theirRoster.map((rp) => (
                                        <PlayerRow
                                            key={rp.id}
                                            player={rp}
                                            selected={requestIds.has(rp.players.id)}
                                            onToggle={() => toggleRequest(rp.players.id)}
                                        />
                                    ))
                                )}

                                {theirPicks.length > 0 && (
                                    <>
                                        <Text style={styles.subSectionLabel}>DRAFT PICKS</Text>
                                        {theirPicks.map((pick) => (
                                            <PickRow
                                                key={pick.pickId}
                                                pick={pick}
                                                selected={requestPickIds.has(pick.pickId)}
                                                onToggle={() => toggleRequestPick(pick.pickId)}
                                            />
                                        ))}
                                    </>
                                )}

                                {/* YOU GIVE section */}
                                <Text style={styles.sectionLabel}>YOU GIVE</Text>
                                {myRoster.length === 0 ? (
                                    <Text style={styles.emptyRowText}>No players on your roster.</Text>
                                ) : (
                                    myRoster.map((rp) => (
                                        <PlayerRow
                                            key={rp.id}
                                            player={rp}
                                            selected={offerIds.has(rp.players.id)}
                                            onToggle={() => toggleOffer(rp.players.id)}
                                        />
                                    ))
                                )}

                                {myPicks.length > 0 && (
                                    <>
                                        <Text style={styles.subSectionLabel}>DRAFT PICKS</Text>
                                        {myPicks.map((pick) => (
                                            <PickRow
                                                key={pick.pickId}
                                                pick={pick}
                                                selected={offerPickIds.has(pick.pickId)}
                                                onToggle={() => toggleOfferPick(pick.pickId)}
                                            />
                                        ))}
                                    </>
                                )}

                                {/* Notes */}
                                <Text style={styles.sectionLabel}>NOTES (optional)</Text>
                                <TextInput
                                    style={styles.notesInput}
                                    placeholder="Add a message to your trade offer..."
                                    placeholderTextColor={colors.textDisabled}
                                    value={notes}
                                    onChangeText={setNotes}
                                    multiline
                                    numberOfLines={3}
                                />
                            </>
                        )}
                    </>
                )}

                {!selectedRecipientId && !loading && (
                    <View style={styles.emptyCenter}>
                        <Text style={styles.emptyText}>Select a team to trade with.</Text>
                    </View>
                )}

                <View style={{ height: 40 }} />
            </ScrollView>
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    scroll: { flex: 1 },

    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
    },
    headerTitle: { fontSize: 17, fontWeight: fontWeight.bold },
    cancelBtn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.xs },
    cancelBtnText: { fontSize: fontSize.lg, color: colors.textSecondary },
    submitBtn: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 52,
        alignItems: 'center',
    },
    submitBtnDisabled: { backgroundColor: colors.border },
    submitBtnText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },

    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textPlaceholder,
        letterSpacing: 0.5,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing['2xl'],
        paddingBottom: spacing.md,
    },
    subSectionLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textDisabled,
        letterSpacing: 0.5,
        paddingHorizontal: spacing.xl,
        paddingTop: spacing.lg,
        paddingBottom: spacing.sm,
    },

    teamChips: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.xs,
        gap: spacing.md,
        flexDirection: 'row',
    },
    teamChip: {
        paddingHorizontal: 14,
        paddingVertical: spacing.md,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    teamChipActive: { backgroundColor: colors.primary },
    teamChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamChipTextActive: { color: colors.textWhite },

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
    },
    playerRowSelected: { backgroundColor: colors.primaryLight },

    pickCircle: {
        width: 40,
        height: 40,
        borderRadius: 20,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.gray300,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: palette.gray400,
    },
    pickCircleSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 12 },

    playerInfo: { flex: 1 },
    playerName: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    playerNameSelected: { color: colors.primary },
    playerMeta: { fontSize: 12, color: colors.textMuted, marginTop: spacing.xxs },
    checkBadge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        justifyContent: 'center',
        alignItems: 'center',
    },
    checkBadgeText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.lg, lineHeight: 22 },

    notesInput: {
        marginHorizontal: spacing.xl,
        borderWidth: 1,
        borderColor: palette.gray300,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: 10,
        fontSize: fontSize.md,
        color: colors.textPrimary,
        minHeight: 80,
        textAlignVertical: 'top',
    },

    emptyRowText: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        color: colors.textPlaceholder,
        fontSize: fontSize.md,
    },
    emptyCenter: {
        alignItems: 'center',
        padding: spacing['5xl'],
    },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder, textAlign: 'center' },
})
