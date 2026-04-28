import {
    View,
    Text,
    TextInput,
    Pressable,
    StyleSheet,
    ActivityIndicator,
    Alert,
    Modal,
    ScrollView,
    Image,
    Dimensions,
    Platform,
} from 'react-native'
import { FlashList } from '@shopify/flash-list'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { searchPlayers, PlayerRow, getEligiblePositions } from '@/lib/players'
import { playerHeadshotUrl, isIneligibleIR } from '@/lib/format'
import {
    getOwnedPlayerMap,
    addFreeAgent,
    dropPlayer,
    toggleIR,
    getRoster,
    isIREligible,
    RosterPlayer,
    OwnedEntry,
} from '@/lib/roster'
import { getWaiverPlayerIds, submitWaiverClaim } from '@/lib/waivers'
import { useAuth } from '@/hooks/use-auth'
import { useLeagueContext } from '@/contexts/league-context'
import { getPositionColor } from "@/constants/positions"
import {
    INJURY_COLORS,
    colors,
    palette,
    fontSize,
    fontWeight,
    radii,
    spacing,
} from '@/constants/tokens'
import { ItemSeparator } from '@/components/ItemSeparator'
import { Avatar } from '@/components/Avatar'
import { Badge } from '@/components/Badge'
import { PosTag } from '@/components/PosTag'
import { EmptyState } from '@/components/EmptyState'
import { IRResolutionModal } from '@/components/IRResolutionModal'
import { DropPlayerPickerModal } from '@/components/DropPlayerPickerModal'
import { ScheduleGrid } from '@/components/ScheduleGrid'
import { useFocusAsyncData } from '@/hooks/use-focus-async-data'
import { getWeekDays, WeekDay, getStartedTeams } from '@/lib/lineup'
import { getCurrentWeekNumber } from '@/lib/shared/week'
import { currentSeasonYear } from '@/lib/shared/season'
import { todayDateString } from '@/lib/shared/dates'

const POSITIONS = ['ALL', 'PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']
const TEAMS = ['ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GSW', 'HOU', 'IND', 'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NOP', 'NYK', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SAC', 'SAS', 'TOR', 'UTA', 'WAS']

type SortMode = 'fpts' | 'gamesLeft' | 'name' | 'team' | 'yearsExp'
const SORT_OPTIONS: { key: SortMode; label: string }[] = [
    { key: 'fpts', label: 'FPts' },
    { key: 'gamesLeft', label: 'G Left' },
    { key: 'name', label: 'Name' },
    { key: 'team', label: 'Team' },
    { key: 'yearsExp', label: 'Exp' },
]


// ── Extracted list item component ────────────────────────────────

function PlayerSearchItem({
    item,
    currentMemberId,
    ownedMap,
    waiverIds,
    adding,
    gamesLeft,
    onAdd,
    onPress,
}: {
    item: PlayerRow
    currentMemberId: string | undefined
    ownedMap: Map<string, OwnedEntry>
    waiverIds: Set<string>
    adding: string | null
    gamesLeft: Map<string, number>
    onAdd: (player: PlayerRow) => void
    onPress: () => void
}) {
    const owned = ownedMap.get(item.id)
    const isMe = owned?.memberId === currentMemberId
    const isOther = owned && !isMe
    const isWaiver = !owned && waiverIds.has(item.id)
    const isFA = !owned && !isWaiver
    const canAdd = currentMemberId && (isFA || isWaiver)
    const isAdding = adding === item.id
    const [headshotError, setHeadshotError] = useState(false)
    const headshotUri = playerHeadshotUrl(item.nba_id)

    return (
        <View style={styles.playerRow}>
            {/* Plus button */}
            <View style={styles.addCol}>
                {canAdd ? (
                    <Pressable
                        style={styles.addBtn}
                        onPress={() => onAdd(item)}
                        disabled={isAdding}
                    >
                        {isAdding
                            ? <ActivityIndicator size="small" color={colors.primary} />
                            : <Text style={styles.addBtnText}>+</Text>}
                    </Pressable>
                ) : null}
            </View>

            {/* Player card (tappable → detail) */}
            <Pressable style={styles.playerCard} onPress={onPress}>
                {headshotUri && !headshotError ? (
                    <Image
                        source={{ uri: headshotUri }}
                        style={styles.headshot}
                        onError={() => setHeadshotError(true)}
                    />
                ) : (
                    <Avatar
                        name={item.display_name}
                        color={getPositionColor(item.eligible_positions?.[0] ?? item.position)}
                    />
                )}

                <View style={styles.playerInfo}>
                    <Text style={styles.playerName}>{item.display_name}</Text>
                    <View style={styles.playerMetaRow}>
                        {item.nba_team && <Text style={styles.playerMeta}>{item.nba_team}</Text>}
                        {getEligiblePositions(item).map((pos: string) => <PosTag key={pos} position={pos} />)}
                        {item.years_exp != null && (
                            <Text style={[styles.gamesLeftText, item.years_exp === 0 && { color: colors.success }]}>
                                {item.years_exp === 0 ? 'Rookie' : `Yr ${item.years_exp + 1}`}
                            </Text>
                        )}
                        {item.nba_team != null && (
                            <Text style={styles.gamesLeftText}>
                                {gamesLeft.get(item.nba_team) ?? 0}G left
                            </Text>
                        )}
                    </View>
                </View>

                {/* Injury badge */}
                {item.injury_status ? (
                    <Badge
                        label={item.injury_status}
                        color={INJURY_COLORS[item.injury_status] ?? colors.textMuted}
                        variant="solid"
                    />
                ) : null}

                {/* Status badge */}
                {currentMemberId ? (
                    <View style={[
                        styles.statusBadge,
                        isMe && styles.statusBadgeMe,
                        isWaiver && styles.statusBadgeWaiver,
                        isFA && styles.statusBadgeFA,
                    ]}>
                        <Text
                            style={[
                                styles.statusBadgeText,
                                isMe && styles.statusBadgeTextMe,
                                isWaiver && styles.statusBadgeTextWaiver,
                            ]}
                            numberOfLines={1}
                        >
                            {isMe ? 'Mine'
                                : isOther ? owned!.teamName
                                : isWaiver ? 'W'
                                : 'FA'}
                        </Text>
                    </View>
                ) : null}
            </Pressable>
        </View>
    )
}

// ── Main screen ──────────────────────────────────────────────────

export default function PlayersScreen() {
    const { push } = useRouter()
    const { current, currentLeague } = useLeagueContext()
    const { user } = useAuth()
    const router = useRouter()
    const [query, setQuery] = useState('')
    const [position, setPosition] = useState('ALL')
    const [selectedTeams, setSelectedTeams] = useState<string[]>([])
    const [teamPopover, setTeamPopover] = useState<{ top: number; right: number } | null>(null)
    const teamBtnRef = useRef<View>(null)
    const [selectedDays, setSelectedDays] = useState<string[]>([])
    const [weekDays, setWeekDays] = useState<WeekDay[]>([])
    const [startedTeams, setStartedTeams] = useState<Set<string>>(new Set())
    const [sortMode, setSortMode] = useState<SortMode>('fpts')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
    const [availableOnly, setAvailableOnly] = useState(true)
    const [rookiesOnly, setRookiesOnly] = useState(false)
    const [players, setPlayers] = useState<PlayerRow[]>([])
    const [loading, setLoading] = useState(true)

    // Quick-add state
    const [adding, setAdding] = useState<string | null>(null)
    const [dropPickerPlayer, setDropPickerPlayer] = useState<PlayerRow | null>(null)
    const [myRoster, setMyRoster] = useState<RosterPlayer[]>([])
    const [dropping, setDropping] = useState<string | null>(null)

    // IR resolution state
    const [irModal, setIrModal] = useState<{
        ineligible: RosterPlayer[]
        roster: RosterPlayer[]
        pendingPlayer: PlayerRow
    } | null>(null)

    const listRef = useRef<FlashList<PlayerRow>>(null)
    const leagueId = currentLeague?.id ?? null

    const {
        data: ownedData,
        refresh: refreshOwned,
    } = useFocusAsyncData(async () => {
        if (!leagueId) return { ownedMap: new Map<string, OwnedEntry>(), waiverIds: new Set<string>() }
        const [om, wIds] = await Promise.all([
            getOwnedPlayerMap(leagueId),
            getWaiverPlayerIds(leagueId),
        ])
        return { ownedMap: om, waiverIds: wIds }
    }, [leagueId])

    const ownedMap = ownedData?.ownedMap ?? new Map<string, OwnedEntry>()
    const waiverIds = ownedData?.waiverIds ?? new Set<string>()

    const gamesLeft = useMemo(() => {
        const today = todayDateString()
        const map = new Map<string, number>()
        for (const day of weekDays) {
            if (day.date < today) continue
            for (const team of day.playingTeams) {
                if (day.date === today && startedTeams.has(team)) continue
                map.set(team, (map.get(team) ?? 0) + 1)
            }
        }
        return map
    }, [weekDays, startedTeams])

    const displayedPlayers = useMemo(() => {
        const list = availableOnly ? players.filter((p) => !ownedMap.has(p.id)) : players
        const sorted = [...list].sort((a, b) => {
            let cmp = 0
            switch (sortMode) {
                case 'fpts':
                    cmp = 0 // already sorted by server
                    break
                case 'gamesLeft': {
                    const ga = gamesLeft.get(a.nba_team ?? '') ?? 0
                    const gb = gamesLeft.get(b.nba_team ?? '') ?? 0
                    cmp = gb - ga
                    break
                }
                case 'name':
                    cmp = (a.display_name ?? '').localeCompare(b.display_name ?? '')
                    break
                case 'team':
                    cmp = (a.nba_team ?? '').localeCompare(b.nba_team ?? '')
                    break
                case 'yearsExp':
                    cmp = (a.years_exp ?? 99) - (b.years_exp ?? 99)
                    break
            }
            return sortDir === 'asc' ? cmp : -cmp
        })
        return sorted
    }, [players, availableOnly, ownedMap, sortMode, sortDir, gamesLeft])

    // Scroll to top after sort changes (after re-render)
    useEffect(() => {
        listRef.current?.scrollToOffset({ offset: 0, animated: false })
    }, [sortMode, sortDir])

    // Load current matchup week days once on mount
    useEffect(() => {
        let cancelled = false
        const seasonYear = currentSeasonYear()
        const today = todayDateString()
        getCurrentWeekNumber(seasonYear).then((weekNum) => {
            if (cancelled) return
            return getWeekDays(weekNum ?? 1, seasonYear)
        }).then((days) => {
            if (!cancelled && days) setWeekDays(days)
        }).catch(console.error)
        getStartedTeams(today).then((teams) => {
            if (!cancelled) setStartedTeams(teams)
        }).catch(console.error)
        return () => { cancelled = true }
    }, [])

    // Compute playing teams as the intersection of teams playing on all selected days
    const playingTeams = useMemo<string[] | null>(() => {
        if (selectedDays.length === 0) return null
        const sets = selectedDays.map((date) => {
            const day = weekDays.find((d) => d.date === date)
            return new Set(day?.playingTeams ?? [])
        })
        const [first, ...rest] = sets
        if (!first) return []
        const intersection = new Set(first)
        for (const s of rest) {
            for (const team of intersection) {
                if (!s.has(team)) intersection.delete(team)
            }
        }
        return Array.from(intersection)
    }, [selectedDays, weekDays])

    const load = useCallback(async (q: string, pos: string, teams: string[], lgId: string | null, playing: string[] | null, rookies: boolean) => {
        setLoading(true)
        try {
            setPlayers(await searchPlayers(q, pos, teams, lgId, playing, rookies))
        } catch (e) {
            console.error(e)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        const timer = setTimeout(() => load(query, position, selectedTeams, leagueId, playingTeams, rookiesOnly), 300)
        return () => clearTimeout(timer)
    }, [query, position, selectedTeams, leagueId, playingTeams, rookiesOnly, load])

    function toggleTeam(t: string) {
        setSelectedTeams((prev) =>
            prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]
        )
    }

    function toggleDay(date: string) {
        setSelectedDays((prev) =>
            prev.includes(date) ? prev.filter((x) => x !== date) : [...prev, date]
        )
    }

    function clearAllFilters() {
        setQuery('')
        setPosition('ALL')
        setSelectedTeams([])
        setSelectedDays([])
        setAvailableOnly(true)
        setRookiesOnly(false)
        setSortMode('fpts')
        setSortDir('desc')
    }

    // Count active filters for badge display
    const activeFilterCount = useMemo(() => {
        let count = 0
        if (query.trim()) count++
        if (position !== 'ALL') count++
        if (selectedTeams.length > 0) count++
        if (selectedDays.length > 0) count++
        if (!availableOnly) count++
        if (rookiesOnly) count++
        if (sortMode !== 'fpts') count++
        return count
    }, [query, position, selectedTeams, selectedDays, availableOnly, rookiesOnly, sortMode])

    function openTeamPicker() {
        teamBtnRef.current?.measure((_x, _y, width, _height, pageX, pageY) => {
            const screenWidth = Dimensions.get('window').width
            setTeamPopover({ top: pageY, right: screenWidth - pageX })
        })
    }

    async function handleAdd(player: PlayerRow) {
        if (!current || !currentLeague) return
        const lid = currentLeague.id

        if (waiverIds.has(player.id)) {
            // Check for ineligible IR players before allowing waiver claim
            const roster = await getRoster(current.id, lid)
            const ineligible = roster.filter((r) => isIneligibleIR(r))

            if (ineligible.length > 0) {
                setIrModal({ ineligible, roster, pendingPlayer: player })
                return
            }

            Alert.alert(
                'Place Waiver Claim',
                `You sure you wanna put in a waiver claim for ${player.display_name}? Claims process nightly.`,
                [
                    { text: 'Nah', style: 'cancel' },
                    {
                        text: 'Claim',
                        onPress: async () => {
                            setAdding(player.id)
                            try {
                                await submitWaiverClaim(current.id, lid, player.id)
                                Alert.alert('Claimed', 'Waiver claim submitted.')
                            } catch (e: any) {
                                Alert.alert('Error', e.message)
                            } finally {
                                setAdding(null)
                                refreshOwned()
                            }
                        },
                    },
                ],
            )
            return
        }

        // Free-agent add — may require a drop if roster is full
        const roster = await getRoster(current.id, lid)
        const active = roster.filter((r) => !r.is_on_ir)
        const ineligible = roster.filter((r) => isIneligibleIR(r))
        if (ineligible.length > 0) {
            setIrModal({ ineligible, roster, pendingPlayer: player })
            return
        }
        if (active.length >= currentLeague.roster_size) {
            setDropPickerPlayer(player)
            setMyRoster(roster)
            return
        }

        setAdding(player.id)
        try {
            await addFreeAgent(current.id, lid, player.id)
            Alert.alert('Added', `${player.display_name} added to your roster.`)
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setAdding(null)
            refreshOwned()
        }
    }

    async function tryAddFreeAgent(player: PlayerRow, leagueId: string) {
        if (!current) return
        setAdding(player.id)
        try {
            await addFreeAgent(current.id, leagueId, player.id)
            await refreshOwned()
        } catch (e: any) {
            if (e.message?.includes('full')) {
                const roster = await getRoster(current.id, leagueId)
                setMyRoster(roster.filter((r) => !r.is_on_ir))
                setDropPickerPlayer(player)
            } else {
                Alert.alert('Error', e.message)
            }
        } finally {
            setAdding(null)
        }
    }

    async function handleDropAndAdd(rosterPlayer: RosterPlayer) {
        if (!current || !dropPickerPlayer || !currentLeague) return
        const lid = currentLeague.id

        // Check for ineligible IR players before dropping (excluding the one being dropped)
        const roster = await getRoster(current.id, lid)
        const ineligible = roster.filter(
            (r) => isIneligibleIR(r) && r.id !== rosterPlayer.id
        )

        if (ineligible.length > 0) {
            // Show IR resolution modal
            const fullRoster = await getRoster(current.id, lid)
            setIrModal({ ineligible, roster: fullRoster, pendingPlayer: dropPickerPlayer })
            return
        }

        setDropping(rosterPlayer.id)
        try {
            await dropPlayer(rosterPlayer.id)
            await addFreeAgent(current.id, lid, dropPickerPlayer.id)
            setDropPickerPlayer(null)
            await refreshOwned()
        } catch (e: any) {
            Alert.alert('Error', e.message)
        } finally {
            setDropping(null)
        }
    }

    async function handleIRActivate(rp: RosterPlayer) {
        if (!current || !currentLeague) return
        await toggleIR(rp.id, false)
        const lid = currentLeague.id
        const roster = await getRoster(current.id, lid)
        const remaining = roster.filter((r) => isIneligibleIR(r))
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            const pending = irModal!.pendingPlayer
            setIrModal(null)
            await proceedAfterIRResolved(pending, lid)
        }
    }

    async function handleDropAndIRActivate(toDrop: RosterPlayer, activatePlayer: RosterPlayer) {
        if (!current || !currentLeague) return
        const lid = currentLeague.id
        await dropPlayer(toDrop.id)
        await toggleIR(activatePlayer.id, false)
        const roster = await getRoster(current.id, lid)
        const remaining = roster.filter((r) => isIneligibleIR(r))
        if (remaining.length > 0) {
            setIrModal((prev) => prev ? { ...prev, ineligible: remaining, roster } : null)
        } else {
            const pending = irModal!.pendingPlayer
            setIrModal(null)
            await proceedAfterIRResolved(pending, lid)
        }
    }

    async function proceedAfterIRResolved(player: PlayerRow, leagueId: string) {
        if (!current) return
        if (waiverIds.has(player.id)) {
            Alert.alert(
                'Place Waiver Claim',
                `You sure you wanna put in a waiver claim for ${player.display_name}? Claims process nightly.`,
                [
                    { text: 'Nah', style: 'cancel' },
                    {
                        text: 'Claim',
                        onPress: async () => {
                            setAdding(player.id)
                            try {
                                await submitWaiverClaim(current!.id, leagueId, player.id)
                                await refreshOwned()
                            } catch (e: any) {
                                Alert.alert('Error', e.message)
                            } finally {
                                setAdding(null)
                            }
                        },
                    },
                ],
            )
        } else {
            await tryAddFreeAgent(player, leagueId)
        }
    }

    return (
        <SafeAreaView style={styles.container}>
            {/* Search bar */}
            <View style={styles.searchRow}>
                <TextInput
                    style={styles.searchInput}
                    placeholder="Search players..."
                    placeholderTextColor={colors.textPlaceholder}
                    value={query}
                    onChangeText={setQuery}
                    autoCorrect={false}
                    clearButtonMode="while-editing"
                />
                <Pressable
                    style={[styles.availableChip, availableOnly && styles.availableChipActive]}
                    onPress={() => setAvailableOnly((v) => !v)}
                >
                    <Text style={[styles.availableChipText, availableOnly && styles.availableChipTextActive]}>
                        Available
                    </Text>
                </Pressable>
                <Pressable
                    style={[styles.availableChip, rookiesOnly && styles.rookieChipActive]}
                    onPress={() => setRookiesOnly((v) => !v)}
                >
                    <Text style={[styles.availableChipText, rookiesOnly && styles.rookieChipTextActive]}>
                        Rookie
                    </Text>
                </Pressable>
            </View>

            {/* Position + Team filters */}
            <View style={styles.filterRow}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={styles.positionScrollView}
                    contentContainerStyle={styles.positionChips}
                >
                    {POSITIONS.map((item) => (
                        <Pressable
                            key={item}
                            style={[styles.posChip, position === item && styles.posChipActive]}
                            onPress={() => setPosition(item)}
                        >
                            <Text style={[styles.posChipText, position === item && styles.posChipTextActive]}>
                                {item}
                            </Text>
                        </Pressable>
                    ))}
                </ScrollView>

                <Pressable
                    ref={teamBtnRef}
                    style={[styles.teamDropdown, selectedTeams.length > 0 && styles.teamDropdownActive]}
                    onPress={openTeamPicker}
                >
                    <Text style={[styles.teamDropdownText, selectedTeams.length > 0 && styles.teamDropdownTextActive]}>
                        {selectedTeams.length === 0 ? 'Team'
                            : selectedTeams.length === 1 ? selectedTeams[0]
                            : `${selectedTeams.length} teams`}
                    </Text>
                    <Text style={[styles.teamDropdownCaret, selectedTeams.length > 0 && styles.teamDropdownTextActive]}>▾</Text>
                </Pressable>
            </View>

            {/* Sort chips */}
            <View style={styles.sortRow}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.sortChips}
                >
                    {SORT_OPTIONS.map((opt) => {
                        const active = sortMode === opt.key
                        return (
                            <Pressable
                                key={opt.key}
                                style={[styles.sortChip, active && styles.sortChipActive]}
                                onPress={() => {
                                    if (active) {
                                        setSortDir((d) => d === 'asc' ? 'desc' : 'asc')
                                    } else {
                                        setSortMode(opt.key)
                                        setSortDir(opt.key === 'name' || opt.key === 'team' ? 'asc' : 'desc')
                                    }
                                }}
                            >
                                <Text style={[styles.sortChipText, active && styles.sortChipTextActive]}>
                                    {opt.label}
                                    {active ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                                </Text>
                            </Pressable>
                        )
                    })}
                </ScrollView>
            </View>

            {/* Day filter */}
            <View style={styles.dayFilterRow}>
                <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.dayChips}
                >
                    {weekDays.filter((day) => day.date >= todayDateString()).map((day) => {
                        const active = selectedDays.includes(day.date)
                        const label = new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short' })
                        return (
                            <Pressable
                                key={day.date}
                                style={[styles.dayChip, active && styles.dayChipActive]}
                                onPress={() => toggleDay(day.date)}
                            >
                                <Text style={[styles.dayChipLabel, active && styles.dayChipTextActive]}>{label}</Text>
                                <Text style={[styles.dayChipNum, active && styles.dayChipTextActive]}>{day.dateNum}</Text>
                            </Pressable>
                        )
                    })}
                    {selectedDays.length > 0 && (
                        <Pressable style={styles.dayClearBtn} onPress={() => setSelectedDays([])}>
                            <Text style={styles.dayClearText}>Clear</Text>
                        </Pressable>
                    )}
                </ScrollView>
            </View>

            {/* Filter status: result count, active badges, clear all */}
            <View style={styles.filterStatusRow}>
                <Text style={styles.filterCountText}>
                    {loading ? 'Searching...' : `${displayedPlayers.length} player${displayedPlayers.length !== 1 ? 's' : ''}`}
                </Text>
                {activeFilterCount > 0 && (
                    <Pressable style={styles.clearAllChip} onPress={clearAllFilters}>
                        <Text style={styles.clearAllChipText}>Clear all ({activeFilterCount})</Text>
                    </Pressable>
                )}
            </View>

            {/* Team picker popover */}
            <Modal
                visible={teamPopover !== null}
                transparent
                animationType="none"
                onRequestClose={() => setTeamPopover(null)}
            >
                <Pressable style={styles.popoverBackdrop} onPress={() => setTeamPopover(null)}>
                    <View
                        style={[styles.teamPopover, teamPopover ? { top: teamPopover.top, right: teamPopover.right } : {}]}
                        onStartShouldSetResponder={() => true}
                    >
                        {selectedTeams.length > 0 && (
                            <Pressable onPress={() => setSelectedTeams([])} style={styles.popoverClear}>
                                <Text style={styles.popoverClearText}>Clear</Text>
                            </Pressable>
                        )}
                        <View style={styles.teamGrid}>
                            {TEAMS.map((t) => {
                                const active = selectedTeams.includes(t)
                                return (
                                    <Pressable
                                        key={t}
                                        style={[styles.teamCell, active && styles.teamCellActive]}
                                        onPress={() => toggleTeam(t)}
                                    >
                                        <Text style={[styles.teamCellText, active && styles.teamCellTextActive]}>{t}</Text>
                                    </Pressable>
                                )
                            })}
                        </View>
                    </View>
                </Pressable>
            </Modal>

            {weekDays.length > 0 && (
                <ScheduleGrid
                    weekDays={weekDays}
                    selectedTeams={selectedTeams}
                    onToggleTeam={toggleTeam}
                />
            )}

            {/* Results */}
            {loading ? (
                <ActivityIndicator style={styles.flex1} color={colors.primary} />
            ) : (
                <FlashList
                    ref={listRef}
                    data={displayedPlayers}
                    keyExtractor={(p) => p.id}
                    contentContainerStyle={displayedPlayers.length === 0 ? styles.emptyContainer : undefined}
                    ItemSeparatorComponent={ItemSeparator}
                    renderItem={({ item }) => (
                        <PlayerSearchItem
                            item={item}
                            currentMemberId={current?.id}
                            ownedMap={ownedMap}
                            waiverIds={waiverIds}
                            adding={adding}
                            gamesLeft={gamesLeft}
                            onAdd={handleAdd}
                            onPress={() => push(`/player/${item.id}`)}
                        />
                    )}
                    ListEmptyComponent={<EmptyState message="No players found." fullScreen={false} />}
                />
            )}

            <DropPlayerPickerModal
                visible={dropPickerPlayer !== null}
                title={`Drop a player to add\n${dropPickerPlayer?.display_name ?? ''}`}
                subtitle="Your roster is full. Pick someone to release."
                roster={myRoster}
                dropping={dropping}
                onDrop={handleDropAndAdd}
                onCancel={() => setDropPickerPlayer(null)}
            />

            {/* IR resolution modal */}
            <IRResolutionModal
                visible={irModal !== null}
                ineligibleIR={irModal?.ineligible ?? []}
                activeRoster={(irModal?.roster ?? []).filter((r) => !r.is_on_ir)}
                rosterSize={currentLeague?.roster_size ?? 20}
                pendingPlayerName={irModal?.pendingPlayer.display_name ?? ''}
                onActivate={handleIRActivate}
                onDropAndActivate={handleDropAndIRActivate}
                onCancel={() => setIrModal(null)}
            />
        </SafeAreaView>
    )
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgScreen },
    flex1: { flex: 1 },

    searchRow: { paddingHorizontal: spacing.xl, paddingVertical: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    searchInput: {
        flex: 1,
        height: 44,
        backgroundColor: colors.bgMuted,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg + spacing.xxs,
        fontSize: fontSize.lg,
    },

    availableChip: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        flexShrink: 0,
    },
    availableChipActive: { backgroundColor: colors.primary },
    availableChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    availableChipTextActive: { color: colors.textWhite },
    rookieChipActive: { backgroundColor: colors.success },
    rookieChipTextActive: { color: colors.textWhite },

    filterRow: { flexDirection: 'row', alignItems: 'center', paddingRight: spacing.xl, marginBottom: spacing.lg },
    positionScrollView: { flexGrow: 1, flexShrink: 1 },
    positionChips: { paddingLeft: spacing.xl, paddingRight: spacing.md, gap: spacing.md },
    teamDropdown: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        flexShrink: 0,
    },
    teamDropdownActive: { backgroundColor: colors.primary },
    teamDropdownText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamDropdownTextActive: { color: colors.textWhite },
    teamDropdownCaret: { fontSize: 11, color: colors.textSecondary },
    popoverBackdrop: { flex: 1 },
    teamPopover: {
        position: 'absolute',
        backgroundColor: colors.bgScreen,
        borderRadius: radii['2xl'],
        borderCurve: 'continuous' as const,
        padding: spacing.md,
        ...(Platform.OS === 'web'
            ? { boxShadow: '0px 4px 12px rgba(0,0,0,0.18)' }
            : {
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.18,
                  shadowRadius: 12,
                  elevation: 8,
              }),
    },
    popoverClear: { alignItems: 'flex-end', paddingHorizontal: spacing.xs, paddingBottom: spacing.sm },
    popoverClearText: { fontSize: fontSize.sm, color: colors.primary, fontWeight: fontWeight.semibold },
    teamGrid: { flexDirection: 'row', flexWrap: 'wrap', width: 6 * 44 },
    teamCell: {
        width: 44,
        height: 36,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
    },
    teamCellActive: { backgroundColor: colors.primary },
    teamCellText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    teamCellTextActive: { color: colors.textWhite },
    posChip: {
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    posChipActive: { backgroundColor: colors.primary },
    posChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    posChipTextActive: { color: colors.textWhite },

    dayFilterRow: { marginBottom: spacing.md },
    dayChips: { paddingHorizontal: spacing.xl, gap: spacing.sm },
    dayChip: {
        alignItems: 'center',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
        minWidth: 46,
    },
    dayChipActive: { backgroundColor: colors.primary },
    dayChipLabel: { fontSize: 10, fontWeight: fontWeight.bold, color: colors.textMuted, textTransform: 'uppercase' as const },
    dayChipNum: { fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textPrimary },
    dayChipTextActive: { color: colors.textWhite },
    dayClearBtn: {
        alignSelf: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
    },
    dayClearText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.primary },

    sortRow: { marginBottom: spacing.md },
    sortChips: { paddingHorizontal: spacing.xl, gap: spacing.sm },
    sortChip: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },
    sortChipActive: { backgroundColor: colors.primary },
    sortChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    sortChipTextActive: { color: colors.textWhite },

    filterStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.xl,
        paddingBottom: spacing.sm,
    },
    filterCountText: { fontSize: fontSize.sm, color: colors.textMuted },
    clearAllChip: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.dangerLight,
    },
    clearAllChipText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.danger },

    playerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingLeft: spacing.lg,
        gap: 0,
    },
    addCol: { width: 36, alignItems: 'center' },
    addBtn: {
        width: 28,
        height: 28,
        borderRadius: 14,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    addBtnText: { color: colors.textWhite, fontSize: fontSize.xl, fontWeight: fontWeight.light, lineHeight: 24, marginTop: -1 },

    playerCard: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        paddingRight: spacing.xl,
        paddingVertical: spacing.lg,
        paddingLeft: spacing.md,
        gap: spacing.lg,
    },
    headshot: {
        width: 44,
        height: 44,
        borderRadius: 22,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgMuted,
    },

    playerInfo: { flex: 1 },
    playerName: { fontSize: fontSize.lg, fontWeight: fontWeight.semibold },
    playerMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.xxs },
    playerMeta: { fontSize: fontSize.sm, color: colors.textMuted },
    gamesLeftText: { fontSize: fontSize.xs, fontWeight: fontWeight.semibold, color: colors.textMuted },

    statusBadge: {
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: radii.sm,
        borderCurve: 'continuous' as const,
        backgroundColor: palette.gray250,
        maxWidth: 90,
    },
    statusBadgeMe: { backgroundColor: palette.green300 },
    statusBadgeWaiver: { backgroundColor: palette.purple100 },
    statusBadgeFA: { backgroundColor: palette.gray250 },
    statusBadgeText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textPlaceholder },
    statusBadgeTextMe: { color: palette.green600 },
    statusBadgeTextWaiver: { color: '#7C3AED' },

    emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

    // Drop picker modal
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    modalCard: {
        backgroundColor: colors.bgScreen,
        borderTopLeftRadius: radii['3xl'],
        borderTopRightRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        paddingTop: spacing['3xl'],
        paddingHorizontal: spacing['2xl'],
        paddingBottom: 36,
        maxHeight: '80%',
    },
    modalTitle: {
        fontSize: 17,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
        textAlign: 'center',
        marginBottom: spacing.xs,
    },
    modalPlayerName: { color: colors.primary },
    modalSub: { fontSize: fontSize.sm, color: colors.textPlaceholder, textAlign: 'center', marginBottom: spacing.xl },

    dropList: { maxHeight: 360 },
    dropRow: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.lg,
        borderBottomWidth: 1,
        borderBottomColor: colors.separator,
        gap: spacing.lg,
    },
    dropInfo: { flex: 1 },
    dropName: { fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    dropMeta: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
    dropBtn: {
        backgroundColor: colors.danger,
        paddingHorizontal: spacing.lg + spacing.xxs,
        paddingVertical: 7,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        minWidth: 60,
        alignItems: 'center',
    },
    dropBtnText: { color: colors.textWhite, fontSize: fontSize.sm, fontWeight: fontWeight.bold },

    modalCancel: {
        marginTop: spacing.xl,
        paddingVertical: spacing.lg + spacing.xxs,
        alignItems: 'center',
        borderRadius: radii.xl,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
    },
    modalCancelText: { fontSize: 15, fontWeight: fontWeight.semibold, color: colors.textSecondary },
})
