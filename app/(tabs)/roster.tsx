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
import { supabase } from '@/lib/supabase'
import { currentSeasonYear } from '@/lib/shared/season'
import { colors, fontSize, fontWeight, radii, spacing, palette } from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { LoadingScreen } from '@/components/LoadingScreen'
import { EmptyState } from '@/components/EmptyState'
import { SectionHeader } from '@/components/SectionHeader'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { RosterClaimItem, RosterPickItem, RosterPlayerItem, TaxiPlayerItem } from '@/components/roster/RosterItems'

type RosterListItem =
    | { _isHeader: true; _section: string }
    | { _isHeader: false; _isEmpty: true; _section: 'taxi' }
    | (RosterPlayer & { _isHeader: false; _isEmpty: false; _section: 'active' | 'ir' | 'taxi' })
    | (TradePickItem & { _isHeader: false; _isEmpty: false; _section: 'picks' })
    | (WaiverClaim & { _isHeader: false; _isEmpty: false; _section: 'claims' })

// ── Main screen ──────────────────────────────────────────────────

export default function RosterScreen() {
    const { push } = useRouter()
    const { user } = useAuth()
    const { current, currentLeague, loading: leagueLoading } = useLeagueContext()
    const [togglingId, setTogglingId] = useState<string | null>(null)
    const [taxiingId, setTaxiingId] = useState<string | null>(null)
    const [cancellingId, setCancellingId] = useState<string | null>(null)
    const [droppingId, setDroppingId] = useState<string | null>(null)

    const { data, loading, refresh: load } = useFocusAsyncData(async () => {
        if (!current || !user) return null
        const leagueId = currentLeague?.id
        if (!leagueId) return null
        const [roster, picks, claims] = await Promise.all([
            getRoster(current.id, leagueId),
            getPicksForMember(current.id, leagueId),
            getMyWaiverClaims(current.id, leagueId),
        ])
        const playerIds = roster.map((r) => r.players.id)
        const { data: avgData } = await supabase
            .from('v_player_avg_fantasy_points')
            .select('player_id, avg_fantasy_points')
            .eq('league_id', leagueId)
            .eq('season_year', currentSeasonYear())
            .in('player_id', playerIds)
        const avgMap = new Map<string, number>()
        for (const row of avgData ?? []) avgMap.set(row.player_id, Number(row.avg_fantasy_points))
        return { roster, picks, claims, avgMap }
    }, [current, user])

    const roster = data?.roster ?? []
    const picks = data?.picks ?? []
    const claims = data?.claims ?? []
    const avgMap = data?.avgMap ?? new Map<string, number>()

    const active = useMemo(() => {
        return roster
            .filter((p) => !p.is_on_ir && !p.is_on_taxi)
            .sort((a, b) => (avgMap.get(b.players.id) ?? -1) - (avgMap.get(a.players.id) ?? -1))
    }, [roster, avgMap])
    const ir = useMemo(() => roster.filter((p) => p.is_on_ir), [roster])
    const taxi = useMemo(() => roster.filter((p) => p.is_on_taxi), [roster])

    const listData = useMemo<RosterListItem[]>(() => {
        const result: RosterListItem[] = []
        for (const p of active) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'active' as const })
        if (ir.length > 0) {
            result.push({ _isHeader: true, _section: 'ir' })
            for (const p of ir) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'ir' as const })
        }
        result.push({ _isHeader: true, _section: 'taxi' })
        if (taxi.length === 0) {
            result.push({ _isHeader: false, _isEmpty: true, _section: 'taxi' })
        } else {
            for (const p of taxi) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'taxi' as const })
        }
        result.push({ _isHeader: true, _section: 'picks' })
        for (const p of picks) result.push({ ...p, _isHeader: false, _isEmpty: false, _section: 'picks' as const })
        if (claims.length > 0) {
            result.push({ _isHeader: true, _section: 'claims' })
            for (const c of claims) result.push({ ...c, _isHeader: false, _isEmpty: false, _section: 'claims' as const })
        }
        return result
    }, [active, ir, taxi, picks, claims])

    async function handleToggleIR(item: RosterPlayer) {
        const irSlots = currentLeague?.ir_slots ?? 2
        const activeSlots = currentLeague?.roster_size ?? 20

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
        const taxiSlots = currentLeague?.taxi_slots ?? 3
        const activeSlots = currentLeague?.roster_size ?? 20

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

    const league = currentLeague
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
                        : item._isEmpty ? `empty-${item._section}`
                        : ('pickId' in item ? item.pickId : item.id)
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
                        if (item._section === 'taxi' && item._isEmpty) {
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
