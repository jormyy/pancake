import {
    View,
    Text,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useState, useMemo } from 'react'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getRoster, toggleIR, RosterPlayer } from '@/lib/roster'
import { getPicksForMember, TradePickItem } from '@/lib/trades'
import { getMyWaiverClaims, cancelWaiverClaim, WaiverClaim } from '@/lib/waivers'
import { POSITION_COLORS } from '@/constants/positions'
import { INJURY_COLORS, colors, fontSize, fontWeight, radii, spacing, palette } from '@/constants/tokens'
import { bgStyle } from '@/lib/style-cache'
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
    | (RosterPlayer & { _isHeader?: false; _section: 'active' | 'ir' })
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
                    style={styles.cancelButton}
                    onPress={() => onCancel(claim.id)}
                    disabled={cancellingId === claim.id}
                >
                    {cancellingId === claim.id ? (
                        <ActivityIndicator size="small" color={colors.textMuted} />
                    ) : (
                        <Text style={styles.cancelButtonText}>Cancel</Text>
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
    onPress,
    onToggleIR,
}: {
    item: RosterPlayer
    togglingId: string | null
    onPress: () => void
    onToggleIR: (item: RosterPlayer) => void
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

            {(item.is_on_ir || player.injury_status) ? (
                <Pressable
                    style={[styles.irButton, item.is_on_ir && styles.irButtonActive]}
                    onPress={() => onToggleIR(item)}
                    disabled={togglingId === item.id}
                >
                    {togglingId === item.id ? (
                        <ActivityIndicator size="small" color={item.is_on_ir ? colors.textWhite : colors.textMuted} />
                    ) : (
                        <Text style={[styles.irButtonText, item.is_on_ir && styles.irButtonTextActive]}>
                            {item.is_on_ir ? 'Active' : 'IR'}
                        </Text>
                    )}
                </Pressable>
            ) : null}
        </Pressable>
    )
}

// ── Main screen ──────────────────────────────────────────────────

export default function RosterScreen() {
    const { push } = useRouter()
    const { user } = useAuth()
    const { current, loading: leagueLoading } = useLeagueContext()
    const [togglingId, setTogglingId] = useState<string | null>(null)
    const [cancellingId, setCancellingId] = useState<string | null>(null)

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

    const active = useMemo(() => roster.filter((p) => !p.is_on_ir), [roster])
    const ir = useMemo(() => roster.filter((p) => p.is_on_ir), [roster])

    const listData = useMemo<RosterListItem[]>(() => {
        const result: RosterListItem[] = []
        for (const p of active) result.push({ ...p, _section: 'active' as const })
        if (ir.length > 0) result.push({ _isHeader: true, _section: 'ir' })
        for (const p of ir) result.push({ ...p, _section: 'ir' as const })
        result.push({ _isHeader: true, _section: 'picks' })
        for (const p of picks) result.push({ ...p, _section: 'picks' as const })
        if (claims.length > 0) result.push({ _isHeader: true, _section: 'claims' })
        for (const c of claims) result.push({ ...c, _section: 'claims' as const })
        return result
    }, [active, ir, picks, claims])

    async function handleToggleIR(item: RosterPlayer) {
        const league = current?.leagues as any
        const irSlots = league?.ir_slots ?? 2
        const activeSlots = league?.roster_size ?? 20

        if (!item.is_on_ir) {
            const currentIR = roster.filter((p) => p.is_on_ir).length
            if (currentIR >= irSlots) {
                Alert.alert('IR Full', `You only have ${irSlots} IR slot${irSlots > 1 ? 's' : ''}.`)
                return
            }
        } else {
            const activeCount = roster.filter((p) => !p.is_on_ir).length
            if (activeCount >= activeSlots) {
                Alert.alert('Roster Full', `Your active roster is full (${activeSlots} players).`)
                return
            }
        }

        setTogglingId(item.id)
        try {
            await toggleIR(item.id, !item.is_on_ir)
            await load()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setTogglingId(null)
        }
    }

    async function handleCancelClaim(claimId: string) {
        if (!user) return
        setCancellingId(claimId)
        try {
            await cancelWaiverClaim(claimId, user.id)
            await load()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setCancellingId(null)
        }
    }

    if (leagueLoading || (!current && loading)) return <LoadingScreen />
    if (!current) return <EmptyState message="Join or create a league first." />

    const league = current.leagues as any

    return (
        <SafeAreaView style={styles.container}>
            {/* Header */}
            <View style={styles.header}>
                <View style={styles.flex1}>
                    <Text style={styles.leagueName}>{league?.name}</Text>
                    <Text style={styles.teamName}>{current.team_name}</Text>
                    <Text style={styles.rosterCount}>
                        {active.length}/{league?.roster_size ?? 20} active · {ir.length}/
                        {league?.ir_slots ?? 2} IR
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
                        item._isHeader ? `header-${item._section}` : ((item as any).id ?? (item as any).pickId)
                    }
                    ItemSeparatorComponent={ItemSeparator}
                    getItemType={(item) => item._isHeader ? 'header' : item._section}
                    renderItem={({ item }) => {
                        if (item._isHeader) {
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
                        const rosterItem = item as RosterPlayer
                        return (
                            <RosterPlayerItem
                                item={rosterItem}
                                togglingId={togglingId}
                                onPress={() => push(`/player/${rosterItem.players.id}`)}
                                onToggleIR={handleToggleIR}
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

    irButton: {
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
    irButtonText: { fontSize: 12, fontWeight: fontWeight.bold, color: colors.textMuted },
    irButtonTextActive: { color: colors.textWhite },

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
    cancelButton: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        minWidth: 60,
        alignItems: 'center',
    },
    cancelButtonText: { fontSize: 12, fontWeight: fontWeight.bold, color: colors.textMuted },

    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: spacing.md },
    emptyTitle: { fontSize: 18, fontWeight: fontWeight.bold },
    emptyText: { fontSize: fontSize.md, color: colors.textPlaceholder },
})
