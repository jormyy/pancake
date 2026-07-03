import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native'
import {
    NOMINATION_ORDER_MODES,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIORS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    type Draft,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import type { LeaguePickItem } from '@/lib/rookieDraft'
import type { WaiverPriorityRow } from '@/lib/waivers'
import type {
    MockDraftRoom,
    MockDraftRoomKind,
    MockDraftRoomStatus,
} from '@/lib/mockDraftRooms'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { EmptyState } from '@/components/EmptyState'
import { PicksBankList } from '@/components/league/LeagueSections'

type ChipValue = string | number
type ChipOption<T extends ChipValue> = {
    value: T
    label: string
}

export const DRAFT_TIMER_OPTIONS = [30, 60, 120] as const
export const ROOKIE_ROUND_OPTIONS = [2, 3, 4] as const
export type DraftTimerOption = (typeof DRAFT_TIMER_OPTIONS)[number]
export type RookieRoundOption = (typeof ROOKIE_ROUND_OPTIONS)[number]

const MOCK_ROOM_TYPE_CHIPS: readonly ChipOption<MockDraftRoomKind>[] = [
    { value: 'auction', label: 'Auction' },
    { value: 'snake', label: 'Rookie' },
]
const DRAFT_TIMER_CHIPS: readonly ChipOption<DraftTimerOption>[] =
    DRAFT_TIMER_OPTIONS.map((value) => ({ value, label: `${value}s` }))
const ROOKIE_ROUND_CHIPS: readonly ChipOption<RookieRoundOption>[] =
    ROOKIE_ROUND_OPTIONS.map((value) => ({ value, label: String(value) }))
const NOMINATION_ORDER_CHIPS: readonly ChipOption<NominationOrderMode>[] =
    NOMINATION_ORDER_MODES.map((value) => ({ value, label: NOMINATION_ORDER_MODE_LABELS[value] }))
const ROOKIE_TIMER_EXPIRY_CHIPS: readonly ChipOption<RookieTimerExpiryBehavior>[] =
    ROOKIE_TIMER_EXPIRY_BEHAVIORS.map((value) => ({ value, label: ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[value] }))

const OPEN_DRAFT_STATUSES = new Set(['pending', 'in_progress', 'paused'])
const ROOM_STATUS_LABELS: Record<MockDraftRoomStatus, string> = {
    active: 'Active',
    scheduled: 'Scheduled',
    live: 'Live',
    completed: 'Completed',
}

type DraftControlProps = {
    nominationMode: NominationOrderMode
    onNominationModeChange: (value: NominationOrderMode) => void
    draftTimerSeconds: DraftTimerOption
    onDraftTimerSecondsChange: (value: DraftTimerOption) => void
    rookieRounds: RookieRoundOption
    onRookieRoundsChange: (value: RookieRoundOption) => void
    rookieTimerExpiryBehavior: RookieTimerExpiryBehavior
    onRookieTimerExpiryBehaviorChange: (value: RookieTimerExpiryBehavior) => void
}

type ActiveDraftProps = {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    isCommissioner: boolean
    draftLoading: boolean
    filterType?: 'auction' | 'snake'
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
}

type ActiveDraftErrorProps = {
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
}

function formatRoomTime(value: string | null): string {
    if (!value) return 'Now'
    return new Date(value).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    })
}

function DraftChips<T extends ChipValue>({
    options,
    selectedValue,
    onSelect,
}: {
    options: readonly ChipOption<T>[]
    selectedValue: T
    onSelect: (value: T) => void
}) {
    return (
        <View style={styles.nominationModeRow}>
            {options.map((option) => {
                const selected = selectedValue === option.value
                return (
                    <Pressable
                        key={String(option.value)}
                        style={[styles.nominationModeChip, selected && styles.nominationModeChipOn]}
                        onPress={() => onSelect(option.value)}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                    >
                        <Text style={[styles.nominationModeChipText, selected && styles.nominationModeChipTextOn]}>
                            {option.label}
                        </Text>
                    </Pressable>
                )
            })}
        </View>
    )
}

function activeDraftButtonLabel(draft: Draft) {
    const mock = draft.isMock ? 'Mock ' : ''
    const kind = draft.draftType === 'snake' ? 'Rookie Draft' : 'Auction Draft'
    if (draft.status === 'completed' && draft.draftType === 'snake') return 'Resolve Rookie Draft'
    return `${draft.status === 'paused' ? 'Resume' : 'Join'} ${mock}${kind}`
}

function ActiveDraftEntry({
    activeDraft,
    activeDraftLoading,
    isCommissioner,
    draftLoading,
    filterType,
    onJoinDraft,
    onReseedRookiePicks,
}: ActiveDraftProps) {
    if (activeDraftLoading || !activeDraft || (filterType && activeDraft.draftType !== filterType)) {
        return null
    }

    return (
        <View style={styles.panelCard}>
            <Text style={styles.panelTitle}>Live Draft</Text>
            <Pressable style={styles.draftButton} onPress={onJoinDraft} disabled={draftLoading}>
                <Text style={styles.draftButtonText}>{activeDraftButtonLabel(activeDraft)}</Text>
            </Pressable>
            {OPEN_DRAFT_STATUSES.has(activeDraft.status) && activeDraft.draftType === 'snake' && !activeDraft.isMock && isCommissioner ? (
                <View style={styles.syncWrap}>
                    <Pressable style={styles.secondaryDraftButton} onPress={onReseedRookiePicks} disabled={draftLoading}>
                        <Text style={styles.secondaryDraftButtonText}>Sync Traded Picks</Text>
                    </Pressable>
                    <Text style={styles.syncHint}>Commissioner only - pull in picks acquired via trade so the draft board is current.</Text>
                </View>
            ) : null}
        </View>
    )
}

function ActiveDraftErrorNotice({ activeDraftError, onRetryActiveDraft }: ActiveDraftErrorProps) {
    if (!activeDraftError) return null
    return (
        <Pressable style={styles.errorNotice} onPress={onRetryActiveDraft}>
            <Text style={styles.errorNoticeText}>Active draft could not refresh. Tap to retry.</Text>
        </Pressable>
    )
}

export function AuctionPanel({
    activeDraft,
    activeDraftLoading,
    currentLeagueStatus,
    isCommissioner,
    draftLoading,
    activeDraftError,
    onRetryActiveDraft,
    nominationMode,
    onNominationModeChange,
    draftTimerSeconds,
    onDraftTimerSecondsChange,
    onStartDraft,
    onJoinDraft,
    onReseedRookiePicks,
}: Pick<DraftControlProps, 'nominationMode' | 'onNominationModeChange' | 'draftTimerSeconds' | 'onDraftTimerSecondsChange'> & {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    currentLeagueStatus?: string
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    onStartDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
}) {
    const hasActiveAuction = !activeDraftLoading && activeDraft?.draftType === 'auction'
    const canStartAuction = currentLeagueStatus === 'setup' && isCommissioner

    return (
        <ScrollView contentContainerStyle={styles.panelScroll}>
            <ActiveDraftErrorNotice activeDraftError={activeDraftError} onRetryActiveDraft={onRetryActiveDraft} />
            <ActiveDraftEntry
                activeDraft={activeDraft}
                activeDraftLoading={activeDraftLoading}
                isCommissioner={isCommissioner}
                draftLoading={draftLoading}
                filterType="auction"
                onJoinDraft={onJoinDraft}
                onReseedRookiePicks={onReseedRookiePicks}
            />
            {canStartAuction ? (
                <View style={styles.panelCard}>
                    <Text style={styles.panelTitle}>Auction</Text>
                    <Text style={styles.nominationModeLabel}>Timer</Text>
                    <DraftChips options={DRAFT_TIMER_CHIPS} selectedValue={draftTimerSeconds} onSelect={onDraftTimerSecondsChange} />
                    <Text style={styles.nominationModeLabel}>Nomination order</Text>
                    <DraftChips options={NOMINATION_ORDER_CHIPS} selectedValue={nominationMode} onSelect={onNominationModeChange} />
                    <Pressable style={styles.draftButton} onPress={onStartDraft} disabled={draftLoading}>
                        <Text style={styles.draftButtonText}>Start Auction Draft</Text>
                    </Pressable>
                </View>
            ) : null}
            {!hasActiveAuction && !canStartAuction ? (
                <EmptyState message="No auction draft is available right now." fullScreen={false} />
            ) : null}
        </ScrollView>
    )
}

export function DraftBoardPanel({
    activeDraft,
    activeDraftLoading,
    currentLeagueStatus,
    isCommissioner,
    draftLoading,
    activeDraftError,
    onRetryActiveDraft,
    picks,
    myMemberId,
    draftTimerSeconds,
    onDraftTimerSecondsChange,
    rookieRounds,
    onRookieRoundsChange,
    rookieTimerExpiryBehavior,
    onRookieTimerExpiryBehaviorChange,
    onStartRookieDraft,
    onJoinDraft,
    onReseedRookiePicks,
}: Pick<DraftControlProps, 'draftTimerSeconds' | 'onDraftTimerSecondsChange' | 'rookieRounds' | 'onRookieRoundsChange' | 'rookieTimerExpiryBehavior' | 'onRookieTimerExpiryBehaviorChange'> & {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    currentLeagueStatus?: string
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    picks: LeaguePickItem[]
    myMemberId?: string
    onStartRookieDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
}) {
    return (
        <View style={styles.boardWrap}>
            <View style={styles.boardTop}>
                <ActiveDraftErrorNotice activeDraftError={activeDraftError} onRetryActiveDraft={onRetryActiveDraft} />
                <ActiveDraftEntry
                    activeDraft={activeDraft}
                    activeDraftLoading={activeDraftLoading}
                    isCommissioner={isCommissioner}
                    draftLoading={draftLoading}
                    filterType="snake"
                    onJoinDraft={onJoinDraft}
                    onReseedRookiePicks={onReseedRookiePicks}
                />
                {currentLeagueStatus === 'offseason' && isCommissioner ? (
                    <View style={styles.panelCard}>
                        <Text style={styles.panelTitle}>Rookie Draft</Text>
                        <Text style={styles.nominationModeLabel}>Timer</Text>
                        <DraftChips options={DRAFT_TIMER_CHIPS} selectedValue={draftTimerSeconds} onSelect={onDraftTimerSecondsChange} />
                        <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                        <DraftChips options={ROOKIE_ROUND_CHIPS} selectedValue={rookieRounds} onSelect={onRookieRoundsChange} />
                        <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                        <DraftChips options={ROOKIE_TIMER_EXPIRY_CHIPS} selectedValue={rookieTimerExpiryBehavior} onSelect={onRookieTimerExpiryBehaviorChange} />
                        <Pressable style={styles.draftButton} onPress={onStartRookieDraft} disabled={draftLoading}>
                            <Text style={styles.draftButtonText}>Start Rookie Draft</Text>
                        </Pressable>
                    </View>
                ) : null}
            </View>
            <View style={styles.boardList}>
                <PicksBankList picks={picks} myMemberId={myMemberId} />
            </View>
        </View>
    )
}

function RoomAction({
    room,
    draftLoading,
    onOpen,
    onJoin,
    onLeave,
    onStart,
}: {
    room: MockDraftRoom
    draftLoading: boolean
    onOpen: (draftId: string, draftType: string) => void
    onJoin: (room: MockDraftRoom) => void
    onLeave: (room: MockDraftRoom) => void
    onStart: (room: MockDraftRoom) => void
}) {
    if (room.roomStatus === 'live' || room.roomStatus === 'completed') {
        return (
            <Pressable
                style={styles.secondaryDraftButton}
                onPress={() => onOpen(room.id, room.draftType)}
                disabled={draftLoading}
            >
                <Text style={styles.secondaryDraftButtonText}>
                    {room.roomStatus === 'live' ? 'Enter Room' : 'View Room'}
                </Text>
            </Pressable>
        )
    }
    if (!room.isJoined) {
        return (
            <Pressable
                style={styles.secondaryDraftButton}
                onPress={() => onJoin(room)}
                disabled={draftLoading}
            >
                <Text style={styles.secondaryDraftButtonText}>Join Room</Text>
            </Pressable>
        )
    }
    if (room.isCreator && room.roomStatus === 'active') {
        const canStart = room.participants.length >= 2
        return (
            <Pressable
                style={[styles.draftButton, !canStart && styles.draftButtonDisabled]}
                onPress={() => onStart(room)}
                disabled={draftLoading || !canStart}
            >
                <Text style={styles.draftButtonText}>Start Room</Text>
            </Pressable>
        )
    }
    if (!room.isCreator) {
        return (
            <Pressable
                style={styles.secondaryDraftButton}
                onPress={() => onLeave(room)}
                disabled={draftLoading}
            >
                <Text style={styles.secondaryDraftButtonText}>Leave Room</Text>
            </Pressable>
        )
    }
    return null
}

function RoomCard({
    room,
    draftLoading,
    onOpen,
    onJoin,
    onLeave,
    onStart,
}: {
    room: MockDraftRoom
    draftLoading: boolean
    onOpen: (draftId: string, draftType: string) => void
    onJoin: (room: MockDraftRoom) => void
    onLeave: (room: MockDraftRoom) => void
    onStart: (room: MockDraftRoom) => void
}) {
    return (
        <View key={room.id} style={styles.roomCard}>
            <View style={styles.roomCardTop}>
                <View style={styles.roomTitleWrap}>
                    <Text style={styles.roomTitle} numberOfLines={1}>{room.roomName}</Text>
                    <Text style={styles.roomMeta} numberOfLines={1}>
                        {room.draftType === 'snake' ? 'Rookie' : 'Auction'} - {formatRoomTime(room.scheduledAt)}
                    </Text>
                </View>
                <View style={styles.roomStatusPill}>
                    <Text style={styles.roomStatusText}>{ROOM_STATUS_LABELS[room.roomStatus]}</Text>
                </View>
            </View>
            <Text style={styles.roomMeta} numberOfLines={2}>
                Creator: {room.creatorTeamName} - Joined: {room.participants.map((p) => p.teamName).join(', ') || 'None'}
            </Text>
            <RoomAction
                room={room}
                draftLoading={draftLoading}
                onOpen={onOpen}
                onJoin={onJoin}
                onLeave={onLeave}
                onStart={onStart}
            />
        </View>
    )
}

export function MockRoomsPanel({
    roomName,
    onRoomNameChange,
    roomDraftType,
    onRoomDraftTypeChange,
    roomScheduledAt,
    onRoomScheduledAtChange,
    roomSubmitting,
    draftLoading,
    rooms,
    nominationMode,
    onNominationModeChange,
    draftTimerSeconds,
    onDraftTimerSecondsChange,
    rookieRounds,
    onRookieRoundsChange,
    rookieTimerExpiryBehavior,
    onRookieTimerExpiryBehaviorChange,
    onCreateRoom,
    onOpenRoom,
    onJoinRoom,
    onLeaveRoom,
    onStartRoom,
}: DraftControlProps & {
    roomName: string
    onRoomNameChange: (value: string) => void
    roomDraftType: MockDraftRoomKind
    onRoomDraftTypeChange: (value: MockDraftRoomKind) => void
    roomScheduledAt: string
    onRoomScheduledAtChange: (value: string) => void
    roomSubmitting: boolean
    draftLoading: boolean
    rooms: MockDraftRoom[]
    onCreateRoom: () => void
    onOpenRoom: (draftId: string, draftType: string) => void
    onJoinRoom: (room: MockDraftRoom) => void
    onLeaveRoom: (room: MockDraftRoom) => void
    onStartRoom: (room: MockDraftRoom) => void
}) {
    const statuses: MockDraftRoomStatus[] = ['active', 'scheduled', 'live', 'completed']

    return (
        <ScrollView contentContainerStyle={styles.panelScroll}>
            <View style={styles.panelCard}>
                <Text style={styles.panelTitle}>Mock Draft Room</Text>
                <TextInput
                    style={styles.textInput}
                    value={roomName}
                    onChangeText={onRoomNameChange}
                    placeholder="Room name"
                />
                <Text style={styles.nominationModeLabel}>Room type</Text>
                <DraftChips options={MOCK_ROOM_TYPE_CHIPS} selectedValue={roomDraftType} onSelect={onRoomDraftTypeChange} />
                <Text style={styles.nominationModeLabel}>Starts</Text>
                <TextInput
                    style={styles.textInput}
                    value={roomScheduledAt}
                    onChangeText={onRoomScheduledAtChange}
                    placeholder="2026-07-01 19:30"
                    autoCapitalize="none"
                />
                <Text style={styles.nominationModeLabel}>Timer</Text>
                <DraftChips options={DRAFT_TIMER_CHIPS} selectedValue={draftTimerSeconds} onSelect={onDraftTimerSecondsChange} />
                {roomDraftType === 'auction' ? (
                    <>
                        <Text style={styles.nominationModeLabel}>Nomination order</Text>
                        <DraftChips options={NOMINATION_ORDER_CHIPS} selectedValue={nominationMode} onSelect={onNominationModeChange} />
                    </>
                ) : (
                    <>
                        <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                        <DraftChips options={ROOKIE_ROUND_CHIPS} selectedValue={rookieRounds} onSelect={onRookieRoundsChange} />
                        <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                        <DraftChips options={ROOKIE_TIMER_EXPIRY_CHIPS} selectedValue={rookieTimerExpiryBehavior} onSelect={onRookieTimerExpiryBehaviorChange} />
                    </>
                )}
                <Pressable style={styles.draftButton} onPress={onCreateRoom} disabled={roomSubmitting}>
                    <Text style={styles.draftButtonText}>Create Room</Text>
                </Pressable>
            </View>

            {statuses.map((status) => {
                const statusRooms = rooms.filter((room) => room.roomStatus === status)
                return (
                    <View key={status} style={styles.roomSection}>
                        <Text style={styles.sectionLabel}>{ROOM_STATUS_LABELS[status]}</Text>
                        {statusRooms.length ? statusRooms.map((room) => (
                            <RoomCard
                                key={room.id}
                                room={room}
                                draftLoading={draftLoading}
                                onOpen={onOpenRoom}
                                onJoin={onJoinRoom}
                                onLeave={onLeaveRoom}
                                onStart={onStartRoom}
                            />
                        )) : (
                            <Text style={styles.emptySectionText}>No {ROOM_STATUS_LABELS[status].toLowerCase()} rooms.</Text>
                        )}
                    </View>
                )
            })}
        </ScrollView>
    )
}

export function SettingsPanel({
    inviteCode,
    isCommissioner,
    waiverOrder,
    onShareInviteCode,
    onOpenBracket,
    onOpenCommissionerSettings,
}: {
    inviteCode?: string | null
    isCommissioner: boolean
    waiverOrder: WaiverPriorityRow[]
    onShareInviteCode: () => void
    onOpenBracket: () => void
    onOpenCommissionerSettings: () => void
}) {
    return (
        <ScrollView contentContainerStyle={styles.panelScroll}>
            <Pressable style={styles.inviteRow} onPress={onShareInviteCode}>
                <Text style={styles.inviteLabel}>Invite Code</Text>
                <Text style={styles.inviteCode}>{inviteCode}</Text>
                <Text style={styles.inviteCopy}>Share</Text>
            </Pressable>
            <View style={styles.settingsActionRow}>
                <Pressable style={styles.secondaryDraftButton} onPress={onOpenBracket}>
                    <Text style={styles.secondaryDraftButtonText}>Bracket</Text>
                </Pressable>
                {isCommissioner ? (
                    <Pressable style={styles.secondaryDraftButton} onPress={onOpenCommissionerSettings}>
                        <Text style={styles.secondaryDraftButtonText}>Commissioner Settings</Text>
                    </Pressable>
                ) : null}
            </View>
            {waiverOrder.length ? (
                <View style={styles.panelCard}>
                    <Text style={styles.panelTitle}>Waiver Priority</Text>
                    {waiverOrder.map((row, index) => (
                        <View key={row.memberId} style={styles.settingListRow}>
                            <Text style={styles.settingListRank}>{index + 1}</Text>
                            <Text style={styles.settingListTeam} numberOfLines={1}>{row.teamName}</Text>
                            <Text style={styles.settingListName} numberOfLines={1}>{row.displayName}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    draftButton: {
        backgroundColor: colors.primary,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    draftButtonDisabled: { opacity: 0.5 },
    draftButtonText: { color: colors.textWhite, fontWeight: fontWeight.bold, fontSize: 15 },
    secondaryDraftButton: {
        backgroundColor: colors.bgSubtle,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        height: 44,
        justifyContent: 'center',
        alignItems: 'center',
    },
    secondaryDraftButtonText: { color: colors.textSecondary, fontWeight: fontWeight.bold, fontSize: 15 },
    errorNotice: {
        backgroundColor: colors.dangerLight,
        borderWidth: 1,
        borderColor: colors.danger,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        alignItems: 'center',
    },
    errorNoticeText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },
    syncWrap: { gap: spacing.xs, marginTop: spacing.md },
    syncHint: { fontSize: fontSize.xs, color: colors.textMuted, paddingHorizontal: spacing.xs, lineHeight: 15 },
    nominationModeLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
        marginBottom: spacing.xs,
    },
    nominationModeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
    nominationModeChip: {
        flexGrow: 1,
        flexBasis: 78,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgCard,
        alignItems: 'center',
    },
    nominationModeChipOn: { borderColor: colors.primary, backgroundColor: colors.bgSubtle },
    nominationModeChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    nominationModeChipTextOn: { color: colors.primaryDark },

    panelScroll: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
        paddingBottom: spacing['3xl'],
    },
    panelCard: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.xl,
        gap: spacing.md,
    },
    panelTitle: {
        fontSize: fontSize.lg,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    textInput: {
        height: 44,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        fontSize: fontSize.md,
        color: colors.textPrimary,
        backgroundColor: colors.bgScreen,
    },
    boardWrap: { flex: 1 },
    boardTop: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
    boardList: { flex: 1 },
    roomSection: { gap: spacing.sm },
    sectionLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
        marginLeft: spacing.xs,
    },
    roomCard: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        gap: spacing.md,
    },
    roomCardTop: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    roomTitleWrap: { flex: 1, minWidth: 0 },
    roomTitle: { fontSize: fontSize.md, fontWeight: fontWeight.extrabold, color: colors.textPrimary },
    roomMeta: { fontSize: fontSize.sm, color: colors.textMuted, lineHeight: 18 },
    roomStatusPill: {
        paddingHorizontal: spacing.md,
        paddingVertical: 4,
        borderRadius: radii['3xl'],
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgSubtle,
        borderWidth: 1,
        borderColor: colors.borderLight,
    },
    roomStatusText: { fontSize: fontSize.xs, fontWeight: fontWeight.bold, color: colors.textSecondary },
    emptySectionText: {
        fontSize: fontSize.sm,
        color: colors.textPlaceholder,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xs,
    },
    settingsActionRow: { gap: spacing.md },
    settingListRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
    },
    settingListRank: { width: 28, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    settingListTeam: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    settingListName: { width: 120, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: spacing.md,
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        paddingHorizontal: 14,
        paddingVertical: spacing.lg,
    },
    inviteLabel: { fontSize: fontSize.sm, color: colors.textMuted, flex: 1 },
    inviteCode: { flexShrink: 1, fontSize: fontSize.sm, fontWeight: fontWeight.extrabold, color: colors.textPrimary, letterSpacing: 0 },
    inviteCopy: { fontSize: fontSize.sm, color: colors.primaryDark, fontWeight: fontWeight.semibold },
})
