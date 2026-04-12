import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
} from 'react-native'
import { showAlert, confirmAction } from '@/lib/alert'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useState, useMemo } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getRoster, toggleIR, toggleTaxi, dropPlayer, isIREligible, isTaxiEligible, RosterPlayer } from '@/lib/roster'
import { getPicksForMember, TradePickItem } from '@/lib/trades'
import { getMyWaiverClaims, cancelWaiverClaim, WaiverClaim } from '@/lib/waivers'
import { POSITION_COLORS } from '@/constants/positions'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing, palette } from '@/constants/tokens'
import { shortDateFmt } from '@/lib/format'
import { ItemSeparator } from '@/components/ItemSeparator'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'

type RosterListItem =
    | { _isHeader: true; _section: string }
    | { _isEmpty: true; _section: 'taxi' }
    | (RosterPlayer & { _isHeader?: false; _isEmpty?: false; _section: 'active' | 'ir' | 'taxi' })
    | (TradePickItem & { _isHeader?: false; _section: 'picks' })
    | (WaiverClaim & { _isHeader?: false; _section: 'claims' })

// ── Extracted list item components ───────────────────────────────

function RosterClaimItem({
    claim,
    cancellingId,
    onCancel,
}: {
    claim: WaiverClaim
    cancellingId: string | null
    onCancel: (id: string) => void
}) {
    const isPending = claim.status === 'pending'
    const statusColor =
        claim.status === 'succeeded' ? colors.success
        : claim.status === 'pending' ? colors.info
        : colors.danger
    return (
        <View style={styles.claimRow}>
            <View style={styles.info}>
                <Text style={styles.playerName}>{claim.playerName}</Text>
                {claim.dropPlayerName ? (
                    <Text style={styles.playerMeta}>Drop: {claim.dropPlayerName}</Text>
                ) : null}
                <Text style={[styles.playerMeta, { color: statusColor }]}>
                    {claim.status === 'pending'
                        ? `Processes ${shortDateFmt.format(new Date(claim.processDate))}`
                        : claim.status === 'succeeded'
                          ? 'Succeeded'
                          : claim.status === 'failed_roster'
                            ? 'Failed: roster full'
                            : 'Failed: outbid'}
                </Text>
            </View>
            {isPending ? (
                <Pressable
                    style={styles.actionButton}
                    onPress={() => onCancel(claim.id)}
                    disabled={cancellingId === claim.id}
                >
                    {cancellingId === claim.id ? (
                        <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                        <Text style={styles.actionButtonText}>Cancel</Text>
                    )}
                </Pressable>
            ) : null}
        </View>
    )
}

function RosterPickItem({
    pick,
    myTeamName,
}: {
    pick: TradePickItem
    myTeamName: string
}) {
    const isOwn = pick.originalTeamName === myTeamName
    return (
        <View style={styles.pickRow}>
            <View style={styles.pickCircle}>
                <Text style={styles.pickCircleText}>
                    {String(pick.seasonYear).slice(2)}
                </Text>
            </View>
            <View style={styles.info}>
                <Text style={styles.playerName}>
                    {pick.seasonYear} Round {pick.round}
                </Text>
                {!isOwn ? (
                    <Text style={styles.playerMeta}>via {pick.originalTeamName}</Text>
                ) : null}
            </View>
        </View>
    )
}

function RosterPlayerItem({
    item,
    togglingId,
    taxiingId,
    droppingId,
    taxiSlotsAvailable,
    onPress,
    onLongPress,
    onToggleIR,
    onToggleTaxi,
}: {
    item: RosterPlayer
    togglingId: string | null
    taxiingId: string | null
    droppingId: string | null
    taxiSlotsAvailable: boolean
    onPress: () => void
    onLongPress: () => void
    onToggleIR: (item: RosterPlayer) => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const player = item.players
    const pos = player.position ?? ''
    const isBusy = togglingId === item.id || taxiingId === item.id || droppingId === item.id
    const [headshotError, setHeadshotError] = useState(false)
    const headshotUri = player.nba_id
        ? `https://cdn.nba.com/headshots/nba/latest/260x190/${player.nba_id}.png`
        : null
    return (
        <Pressable style={styles.playerRow} onPress={onPress} onLongPress={onLongPress} delayLongPress={400}>
            <Avatar
                name={player.display_name}
                color={POSITION_COLORS[pos] ?? palette.gray500}
                uri={headshotUri && !headshotError ? headshotUri : undefined}
            />

            <View style={styles.info}>
                <Text style={styles.playerName}>{player.display_name}</Text>
                <Text style={styles.playerMeta}>
                    {[player.nba_team, pos].filter(Boolean).join(' · ')}
                </Text>
                {player.injury_status ? (
                    <View style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                        <Badge
                            label={player.injury_status}
                            color={INJURY_COLORS[player.injury_status] ?? colors.textMuted}
                            variant="solid"
                        />
                    </View>
                ) : null}
            </View>

            <View style={styles.rowActions}>
                {(item.is_on_ir || isIREligible(player.injury_status)) ? (
                    <Pressable
                        style={[styles.actionButton, item.is_on_ir && styles.irButtonActive]}
                        onPress={() => onToggleIR(item)}
                        disabled={isBusy}
                    >
                        {togglingId === item.id ? (
                            <ActivityIndicator size="small" color={item.is_on_ir ? colors.textWhite : colors.textMuted} />
                        ) : (
                            <Text style={[styles.actionButtonText, item.is_on_ir && styles.actionButtonTextActive]}>
                                {item.is_on_ir ? 'Active' : 'IR'}
                            </Text>
                        )}
                    </Pressable>
                ) : null}
                {!item.is_on_ir && taxiSlotsAvailable && isTaxiEligible(player) ? (
                    <Pressable
                        style={[styles.actionButton, styles.taxiButtonOutline]}
                        onPress={() => onToggleTaxi(item)}
                        disabled={isBusy}
                    >
                        {taxiingId === item.id ? (
                            <ActivityIndicator size="small" color={palette.indigo500} />
                        ) : (
                            <Text style={styles.taxiButtonOutlineText}>Taxi</Text>
                        )}
                    </Pressable>
                ) : null}
            </View>
        </Pressable>
    )
}

function TaxiPlayerItem({
    item,
    taxiingId,
    onPress,
    onToggleTaxi,
}: {
    item: RosterPlayer
    taxiingId: string | null
    onPress: () => void
    onToggleTaxi: (item: RosterPlayer) => void
}) {
    const player = item.players
    const pos = player.position ?? ''
    return (
        <Pressable style={styles.playerRow} onPress={onPress}>
            <Avatar
                name={player.display_name}
                color={POSITION_COLORS[pos] ?? palette.gray500}
            />

            <View style={styles.info}>
                <Text style={styles.playerName}>{player.display_name}</Text>
                <Text style={styles.playerMeta}>
                    {[player.nba_team, pos].filter(Boolean).join(' · ')}
                </Text>
            </View>

            <Pressable
                style={[styles.actionButton, styles.taxiButtonActive]}
                onPress={() => onToggleTaxi(item)}
                disabled={taxiingId === item.id}
            >
                {taxiingId === item.id ? (
                    <ActivityIndicator size="small" color={colors.textWhite} />
                ) : (
                    <Text style={[styles.actionButtonText, styles.actionButtonTextActive]}>Activate</Text>
                )}
            </Pressable>
        </Pressable>
    )
}

// ── Main screen ──────────────────────────────────────────────────

export default function RosterScreen() {
    const { push } = useRouter()
    const { user } = useAuth()
    const { current, loading: leagueLoading } = useLeagueContext()
    const [togglingId, setTogglingId] = useState<string | null>(null)
    const [taxiingId, setTaxiingId] = useState<string | null>(null)
    const [cancellingId, setCancellingId] = useState<string | null>(null)
    const [droppingId, setDroppingId] = useState<string | null>(null)

    const { data, loading, refresh: load } = useFocusAsyncData(async () => {
        if (!current || !user) return null
        const leagueId = (current.leagues as any).id
        const [roster, picks, claims] = await Promise.all([
            getRoster(current.id, leagueId),
            getPicksForMember(current.id, leagueId),
            getMyWaiverClaims(current.id, leagueId),
        ])
        return { roster, picks, claims }
    }, [current, user])

    const roster = data?.roster ?? []
    const picks = data?.picks ?? []
    const claims = data?.claims ?? []

    const active = useMemo(() => roster.filter((p) => !p.is_on_ir && !p.is_on_taxi), [roster])
    const ir = useMemo(() => roster.filter((p) => p.is_on_ir), [roster])
    const taxi = useMemo(() => roster.filter((p) => p.is_on_taxi), [roster])

    const listData = useMemo<RosterListItem[]>(() => {
        const result: RosterListItem[] = []
        for (const p of active) result.push({ ...p, _section: 'active' as const })
        if (ir.length > 0) {
            result.push({ _isHeader: true, _section: 'ir' })
            for (const p of ir) result.push({ ...p, _section: 'ir' as const })
        }
        result.push({ _isHeader: true, _section: 'taxi' })
        if (taxi.length === 0) {
            result.push({ _isEmpty: true, _section: 'taxi' })
        } else {
            for (const p of taxi) result.push({ ...p, _section: 'taxi' as const })
        }
        result.push({ _isHeader: true, _section: 'picks' })
        for (const p of picks) result.push({ ...p, _section: 'picks' as const })
        if (claims.length > 0) {
            result.push({ _isHeader: true, _section: 'claims' })
            for (const c of claims) result.push({ ...c, _section: 'claims' as const })
        }
        return result
    }, [active, ir, taxi, picks, claims])

    async function handleToggleIR(item: RosterPlayer) {
        const league = current?.leagues as any
        const irSlots = league?.ir_slots ?? 2
        const activeSlots = league?.roster_size ?? 20

        if (!item.is_on_ir) {
            if (!isIREligible(item.players.injury_status)) {
                showAlert('Not IR Eligible', 'Only players with Out or IR designations can be placed on IR.')
                return
            }
            const currentIR = roster.filter((p) => p.is_on_ir).length
            if (currentIR >= irSlots) {
                showAlert('IR Full', `You only have ${irSlots} IR slot${irSlots > 1 ? 's' : ''}.`)
                return
            }
        } else {
            const activeCount = roster.filter((p) => !p.is_on_ir && !p.is_on_taxi).length
            if (activeCount >= activeSlots) {
                showAlert('Roster Full', `Your active roster is full (${activeSlots} players).`)
                return
            }
        }

        setTogglingId(item.id)
        try {
            await toggleIR(item.id, !item.is_on_ir)
            await load()
        } catch (e: any) {
            showAlert('Error', e.message)
        } finally {
            setTogglingId(null)
        }
    }

    async function handleToggleTaxi(item: RosterPlayer) {
        const league = current?.leagues as any
        const taxiSlots = league?.taxi_slots ?? 3
        const activeSlots = league?.roster_size ?? 20

        if (!item.is_on_taxi) {
            if (!isTaxiEligible(item.players)) {
                showAlert('Not Eligible', 'Only rookies (NBA draft picks) can be placed on the taxi squad.')
                return
            }
            const currentTaxi = roster.filter((p) => p.is_on_taxi).length
            if (currentTaxi >= taxiSlots) {
                showAlert('Taxi Full', `You only have ${taxiSlots} taxi squad slot${taxiSlots > 1 ? 's' : ''}.`)
                return
            }
        } else {
            const activeCount = roster.filter((p) => !p.is_on_ir && !p.is_on_taxi).length
            if (activeCount >= activeSlots) {
                showAlert('Roster Full', `Your active roster is full (${activeSlots} players).`)
                return
            }
        }

        setTaxiingId(item.id)
        try {
            await toggleTaxi(item.id, !item.is_on_taxi)
            await load()
        } catch (e: any) {
            showAlert('Error', e.message)
        } finally {
            setTaxiingId(null)
        }
    }

    function handleDropPrompt(item: RosterPlayer) {
        confirmAction(
            `Drop ${item.players.display_name}?`,
            'They will be placed on waivers for 48 hours.',
            async () => {
                setDroppingId(item.id)
                try {
                    await dropPlayer(item.id)
                    await load()
                } catch (e: any) {
                    showAlert('Error', e.message)
                } finally {
                    setDroppingId(null)
                }
            },
            'Drop',
        )
    }

    async function handleCancelClaim(claimId: string) {
        if (!user) return
        setCancellingId(claimId)
        try {
            await cancelWaiverClaim(claimId, user.id)
            await load()
        } catch (e: any) {
            showAlert('Error', e.message)
        } finally {
            setCancellingId(null)
        }
    }

    if (leagueLoading || (!current && loading)) return <LoadingScreen />
    if (!current) return <EmptyState message="Join or create a league first." />

    const league = current.leagues as any
    const taxiSlots = league?.taxi_slots ?? 3

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.flex1}>
                    <Text style={styles.leagueName}>{league?.name}</Text>
                    <Text style={styles.teamName}>{current.team_name}</Text>
                    <Text style={styles.rosterCount}>
                        {active.length}/{league?.roster_size ?? 20} active · {ir.length}/{league?.ir_slots ?? 2} IR · {taxi.length}/{taxiSlots} taxi
                    </Text>
                </View>
                <Pressable
                    style={styles.lineupButton}
                    onPress={() => push('/(modals)/lineup')}
                >
                    <Text style={styles.lineupButtonText}>Set Lineup</Text>
                </Pressable>
            </View>

            {loading ? (
                <ActivityIndicator style={styles.flex1} color={colors.primary} />
            ) : roster.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>Your roster is empty</Text>
                    <Text style={styles.emptyText}>Players will appear here after the draft.</Text>
                </View>
            ) : (
                <FlashList
                    data={listData}
                    keyExtractor={(item) =>
                        item._isHeader ? `header-${item._section}`
                        : (item as any)._isEmpty ? `empty-${item._section}`
                        : ((item as any).id ?? (item as any).pickId)
                    }
                    ItemSeparatorComponent={ItemSeparator}
                    getItemType={(item) => item._isHeader ? 'header' : item._section}
                    renderItem={({ item }) => {
                        if (item._isHeader) {
                            if (item._section === 'taxi') {
                                return (
                                    <View style={styles.taxiHeader}>
                                        <Text style={styles.taxiHeaderText}>Taxi Squad</Text>
                                        <Text style={styles.taxiHeaderSub}>Exempt from roster limits · Cannot play in lineups</Text>
                                    </View>
                                )
                            }
                            const label =
                                item._section === 'picks' ? 'Draft Picks'
                                : item._section === 'claims' ? 'Waiver Claims'
                                : 'IR'
                            return <SectionHeader label={label} />
                        }
                        if (item._section === 'claims') {
                            return (
                                <RosterClaimItem
                                    claim={item as WaiverClaim}
                                    cancellingId={cancellingId}
                                    onCancel={handleCancelClaim}
                                />
                            )
                        }
                        if (item._section === 'picks') {
                            return (
                                <RosterPickItem
                                    pick={item as TradePickItem}
                                    myTeamName={current?.team_name ?? ''}
                                />
                            )
                        }
                        if (item._section === 'taxi' && (item as any)._isEmpty) {
                            return (
                                <View style={styles.taxiEmpty}>
                                    <Text style={styles.taxiEmptyText}>No players on taxi squad</Text>
                                </View>
                            )
                        }
                        if (item._section === 'taxi') {
                            return (
                                <TaxiPlayerItem
                                    item={item as RosterPlayer}
                                    taxiingId={taxiingId}
                                    onPress={() => push(`/player/${(item as RosterPlayer).players.id}`)}
                                    onToggleTaxi={handleToggleTaxi}
                                />
                            )
                        }
                        const rosterItem = item as RosterPlayer
                        return (
                            <RosterPlayerItem
                                item={rosterItem}
                                togglingId={togglingId}
                                taxiingId={taxiingId}
                                droppingId={droppingId}
                                taxiSlotsAvailable={taxi.length < taxiSlots}
                                onPress={() => push(`/player/${rosterItem.players.id}`)}
                                onLongPress={() => handleDropPrompt(rosterItem)}
                                onToggleIR={handleToggleIR}
                                onToggleTaxi={handleToggleTaxi}
                            />
                        )
                    }}
                />
            )}
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    flex1: { flex: 1 },

    header: {
        padding: spacing['2xl'],
        borderBottomWidth: 1,
        borderBottomColor: colors.borderLight,
        gap: 2,
        flexDirection: 'row',
        alignItems: 'center',
    },
    lineupButton: {
        paddingHorizontal: 14,
        paddingVertical: spacing.md,
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        marginLeft: spacing.lg,
    },
    lineupButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },
    leagueName: { fontSize: 18, fontWeight: fontWeight.extrabold },
    teamName: { fontSize: fontSize.md, color: colors.textSecondary },
    rosterCount: { fontSize: 12, color: colors.textPlaceholder, marginTop: spacing.xs },

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },

    info: { flex: 1, gap: 2 },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },

    rowActions: { flexDirection: 'row', gap: spacing.sm },

    actionButton: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        minWidth: 52,
        alignItems: 'center',
    },
    irButtonActive: { backgroundColor: colors.danger, borderColor: colors.danger },
    taxiButtonActive: { backgroundColor: palette.indigo500, borderColor: palette.indigo500 },
    taxiButtonOutline: { borderColor: palette.indigo500 },
    taxiButtonOutlineText: { fontSize: 12, fontWeight: fontWeight.bold, color: palette.indigo500 },
    actionButtonText: { fontSize: 12, fontWeight: fontWeight.bold, color: colors.textMuted },
    actionButtonTextActive: { color: colors.textWhite },

    pickRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },
    pickCircle: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.indigo500,
        justifyContent: 'center',
        alignItems: 'center',
    },
    pickCircleText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: fontSize.sm },

    claimRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
        gap: spacing.lg,
    },

    taxiHeader: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        backgroundColor: '#EEF2FF',
        borderLeftWidth: 3,
        borderLeftColor: palette.indigo500,
        gap: 2,
    },
    taxiHeaderText: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: palette.indigo500,
        letterSpacing: 0.5,
        textTransform: 'uppercase' as const,
    },
    taxiEmpty: {
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.lg,
    },
    taxiEmptyText: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        fontStyle: 'italic',
    },
    taxiHeaderSub: {
        fontSize: fontSize.xs,
        color: palette.indigo500,
        opacity: 0.7,
    },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
    emptyTitle: { fontSize: 18, fontWeight: fontWeight.bold },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },
})
