import { View, Text, Pressable, StyleSheet, ScrollView, TextInput } from 'react-native'
import type {
    MockDraftRoom,
    MockDraftRoomKind,
    MockDraftRoomStatus,
} from '@/lib/mockDraftRooms'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { countLabel } from '@/lib/format'
import {
    DraftChips,
    DraftTimerControl,
    MOCK_ROOM_TYPE_CHIPS,
    NOMINATION_ORDER_CHIPS,
    ROOKIE_ROUND_CHIPS,
    ROOKIE_TIMER_EXPIRY_CHIPS,
    mockRoomTypeChipLabel,
    rookieRoundChipLabel,
    type DraftControlProps,
} from '@/components/league/DraftChips'
import { panelStyles } from '@/components/league/draftPanelStyles'
import { useWebViewport } from '@/hooks/use-web-viewport'

const ROOM_STATUS_LABELS: Record<MockDraftRoomStatus, string> = {
    active: 'Active',
    scheduled: 'Scheduled',
    live: 'Live',
    completed: 'Completed',
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

function roomTypeLabel(type: MockDraftRoomKind) {
    return type === 'snake' ? 'Rookie' : 'Auction'
}

function roomSectionAccessibilityLabel(status: MockDraftRoomStatus, count: number) {
    return `${ROOM_STATUS_LABELS[status]} mock rooms, ${countLabel(count, 'room')}`
}

function roomCardAccessibilityLabel(room: MockDraftRoom) {
    const participants = room.participants.map((participant) => participant.teamName).join(', ') || 'no teams joined'
    const startBlockedCopy = roomStartBlockedCopy(room)
    const parts = [
        room.roomName,
        `${ROOM_STATUS_LABELS[room.roomStatus]} ${roomTypeLabel(room.draftType)} mock room`,
        `starts ${formatRoomTime(room.scheduledAt)}`,
        `creator ${room.creatorTeamName}`,
        `joined ${participants}`,
    ]
    if (startBlockedCopy) parts.push(`${startBlockedCopy.toLowerCase()} to start`)
    return parts.join(', ')
}

function roomStartBlockedCopy(room: MockDraftRoom) {
    if (!room.isCreator || room.roomStatus !== 'active') return null
    const missing = Math.max(0, 2 - room.participants.length)
    if (missing === 0) return null
    return `Needs ${missing} more joined ${missing === 1 ? 'team' : 'teams'}`
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
    const roomName = room.roomName
    if (room.roomStatus === 'live' || room.roomStatus === 'completed') {
        const actionLabel = room.roomStatus === 'live' ? `Enter ${roomName}` : `View ${roomName}`
        return (
            <Pressable
                style={panelStyles.secondaryDraftButton}
                onPress={() => onOpen(room.id, room.draftType)}
                disabled={draftLoading}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading }}
            >
                <Text style={panelStyles.secondaryDraftButtonText}>
                    {room.roomStatus === 'live' ? 'Enter Room' : 'View Room'}
                </Text>
            </Pressable>
        )
    }
    if (!room.isJoined) {
        const actionLabel = `Join ${roomName}`
        return (
            <Pressable
                style={panelStyles.secondaryDraftButton}
                onPress={() => onJoin(room)}
                disabled={draftLoading}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading }}
            >
                <Text style={panelStyles.secondaryDraftButtonText}>Join Room</Text>
            </Pressable>
        )
    }
    if (room.isCreator && room.roomStatus === 'active') {
        const startBlockedCopy = roomStartBlockedCopy(room)
        const canStart = !startBlockedCopy
        const actionLabel = draftLoading && canStart
            ? `Starting ${roomName}`
            : startBlockedCopy
              ? `Start ${roomName} unavailable. ${startBlockedCopy}.`
              : `Start ${roomName}`
        const buttonStyle = canStart ? panelStyles.draftButton : panelStyles.secondaryDraftButton
        const buttonTextStyle = canStart ? panelStyles.draftButtonText : panelStyles.secondaryDraftButtonText
        const missing = Math.max(0, 2 - room.participants.length)
        const buttonText = draftLoading && canStart
            ? 'Starting...'
            : startBlockedCopy
              ? `Needs ${missing} ${missing === 1 ? 'Team' : 'Teams'}`
              : 'Start Room'
        return (
            <Pressable
                style={[buttonStyle, (draftLoading || !canStart) && styles.draftButtonDisabled]}
                onPress={() => onStart(room)}
                disabled={draftLoading || !canStart}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading || !canStart}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading || !canStart }}
            >
                <Text style={buttonTextStyle} numberOfLines={1}>{buttonText}</Text>
            </Pressable>
        )
    }
    if (!room.isCreator) {
        const actionLabel = `Leave ${roomName}`
        return (
            <Pressable
                style={panelStyles.secondaryDraftButton}
                onPress={() => onLeave(room)}
                disabled={draftLoading}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading }}
            >
                <Text style={panelStyles.secondaryDraftButtonText}>Leave Room</Text>
            </Pressable>
        )
    }
    return null
}

function RoomCard({
    room,
    draftLoading,
    compact,
    onOpen,
    onJoin,
    onLeave,
    onStart,
    onDelete,
}: {
    room: MockDraftRoom
    draftLoading: boolean
    compact?: boolean
    onOpen: (draftId: string, draftType: string) => void
    onJoin: (room: MockDraftRoom) => void
    onLeave: (room: MockDraftRoom) => void
    onStart: (room: MockDraftRoom) => void
    onDelete: (room: MockDraftRoom) => void
}) {
    // Live rooms cannot be deleted mid-session; abandoned ones expire daily.
    const deletable = room.isCreator && room.roomStatus !== 'live'
    const action = (
        <View style={styles.roomActionRow}>
            <RoomAction
                room={room}
                draftLoading={draftLoading}
                onOpen={onOpen}
                onJoin={onJoin}
                onLeave={onLeave}
                onStart={onStart}
            />
            {deletable ? (
                <Pressable
                    style={panelStyles.secondaryDraftButton}
                    onPress={() => onDelete(room)}
                    disabled={draftLoading}
                    role="button"
                    aria-label={`Delete ${room.roomName}`}
                    aria-disabled={draftLoading}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${room.roomName}`}
                    accessibilityState={{ disabled: draftLoading }}
                >
                    <Text style={panelStyles.secondaryDraftButtonText}>Delete</Text>
                </Pressable>
            ) : null}
        </View>
    )

    return (
        <View
            key={room.id}
            style={[styles.roomCard, compact && styles.roomCardCompact]}
            role="listitem"
            aria-label={roomCardAccessibilityLabel(room)}
            accessibilityRole="text"
            accessibilityLabel={roomCardAccessibilityLabel(room)}
        >
            <View style={[styles.roomCardTop, compact && styles.roomCardTopCompact]}>
                <View style={styles.roomTitleWrap}>
                    <Text style={styles.roomTitle} numberOfLines={1}>{room.roomName}</Text>
                    {compact ? null : (
                        <Text style={styles.roomMeta} numberOfLines={1}>
                            {room.draftType === 'snake' ? 'Rookie' : 'Auction'} - {formatRoomTime(room.scheduledAt)}
                        </Text>
                    )}
                </View>
                {compact ? <View style={styles.roomCompactActionWrap}>{action}</View> : (
                    <View style={styles.roomStatusPill}>
                        <Text style={styles.roomStatusText}>{ROOM_STATUS_LABELS[room.roomStatus]}</Text>
                    </View>
                )}
            </View>
            {compact ? null : (
                <Text style={styles.roomMeta} numberOfLines={2}>
                    Creator: {room.creatorTeamName} - Joined: {room.participants.map((p) => p.teamName).join(', ') || 'None'}
                </Text>
            )}
            {compact ? null : action}
        </View>
    )
}

function MockRoomsEmptyState({ compact }: { compact: boolean }) {
    const title = 'No mock rooms yet.'
    const fullBody = 'Create an auction or rookie room for managers to join before starting a mock draft.'
    const compactBody = 'Create one for managers to join before drafting.'
    const body = compact ? compactBody : fullBody
    const accessibilityLabel = `${title} ${fullBody}`

    return (
        <View
            style={[styles.mockRoomsEmptyState, compact && styles.mockRoomsEmptyStateCompact]}
            role="status"
            aria-label={accessibilityLabel}
            aria-live="polite"
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
        >
            <Text style={[styles.mockRoomsEmptyTitle, compact && styles.mockRoomsEmptyTitleCompact]} numberOfLines={1}>{title}</Text>
            <Text style={[styles.mockRoomsEmptyText, compact && styles.mockRoomsEmptyTextCompact]} numberOfLines={compact ? 1 : undefined}>{body}</Text>
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
    onDeleteRoom,
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
    onDeleteRoom: (room: MockDraftRoom) => void
}) {
    const { viewportHeight } = useWebViewport()
    const compactComposer = viewportHeight < 500
    const statuses: MockDraftRoomStatus[] = ['live', 'active', 'scheduled', 'completed']

    const createButton = (
        <Pressable
            style={[panelStyles.draftButton, compactComposer && styles.mockCompactCreateButton]}
            onPress={onCreateRoom}
            disabled={roomSubmitting}
            role="button"
            aria-label="Create mock draft room"
            aria-disabled={roomSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Create mock draft room"
            accessibilityState={{ disabled: roomSubmitting }}
        >
            <Text style={panelStyles.draftButtonText}>Create Room</Text>
        </Pressable>
    )

    const roomSections = () => statuses.map((status) => {
        const statusRooms = rooms.filter((room) => room.roomStatus === status)
        if (statusRooms.length === 0) return null
        return (
            <View key={status} style={styles.roomSection}>
                {compactComposer ? null : (
                    <Text
                        style={styles.sectionLabel}
                        role="heading"
                        aria-level={2}
                        accessibilityRole="header"
                        accessibilityLabel={ROOM_STATUS_LABELS[status]}
                    >
                        {ROOM_STATUS_LABELS[status]}
                    </Text>
                )}
                <View
                    style={styles.roomList}
                    role="list"
                    aria-label={roomSectionAccessibilityLabel(status, statusRooms.length)}
                    accessibilityRole="list"
                    accessibilityLabel={roomSectionAccessibilityLabel(status, statusRooms.length)}
                >
                    {statusRooms.map((room) => (
                        <RoomCard
                            key={room.id}
                            room={room}
                            draftLoading={draftLoading}
                            compact={compactComposer}
                            onOpen={onOpenRoom}
                            onJoin={onJoinRoom}
                            onLeave={onLeaveRoom}
                            onStart={onStartRoom}
                            onDelete={onDeleteRoom}
                        />
                    ))}
                </View>
            </View>
        )
    })

    const panelContent = (
        <>
            {rooms.length ? roomSections() : null}
            <View style={[panelStyles.panelCard, compactComposer && panelStyles.panelCardCompact]}>
                <Text style={panelStyles.panelTitle}>Mock Draft Room</Text>
                {compactComposer ? (
                    <View style={styles.mockCompactCreateRow}>
                        <View style={styles.mockCompactTypeWrap}>
                            <DraftChips
                                options={MOCK_ROOM_TYPE_CHIPS}
                                selectedValue={roomDraftType}
                                onSelect={onRoomDraftTypeChange}
                                groupLabel="Mock room type"
                                accessibilityLabelForOption={mockRoomTypeChipLabel}
                                compact
                            />
                        </View>
                        {createButton}
                    </View>
                ) : (
                    <>
                        <TextInput
                            style={styles.textInput}
                            value={roomName}
                            onChangeText={onRoomNameChange}
                            placeholder="Room name"
                            accessibilityLabel="Mock room name"
                        />
                        <Text style={panelStyles.nominationModeLabel}>Room type</Text>
                        <DraftChips
                            options={MOCK_ROOM_TYPE_CHIPS}
                            selectedValue={roomDraftType}
                            onSelect={onRoomDraftTypeChange}
                            groupLabel="Mock room type"
                            accessibilityLabelForOption={mockRoomTypeChipLabel}
                        />
                        {createButton}
                    </>
                )}
                {compactComposer ? null : (
                    <>
                        <Text style={panelStyles.nominationModeLabel}>Starts</Text>
                        <TextInput
                            style={styles.textInput}
                            value={roomScheduledAt}
                            onChangeText={onRoomScheduledAtChange}
                            placeholder="2026-07-01 19:30"
                            autoCapitalize="none"
                            accessibilityLabel="Mock room start time"
                        />
                        <Text style={panelStyles.nominationModeLabel}>Timer</Text>
                        <DraftTimerControl
                            selectedValue={draftTimerSeconds}
                            onSelect={onDraftTimerSecondsChange}
                            groupLabel="Mock draft timer"
                        />
                    </>
                )}
                {compactComposer ? null : roomDraftType === 'auction' ? (
                    <>
                        <Text style={panelStyles.nominationModeLabel}>Nomination order</Text>
                        <DraftChips
                            options={NOMINATION_ORDER_CHIPS}
                            selectedValue={nominationMode}
                            onSelect={onNominationModeChange}
                            groupLabel="Mock nomination order"
                        />
                    </>
                ) : (
                    <>
                        <Text style={panelStyles.nominationModeLabel}>Rookie rounds</Text>
                        <DraftChips
                            options={ROOKIE_ROUND_CHIPS}
                            selectedValue={rookieRounds}
                            onSelect={onRookieRoundsChange}
                            groupLabel="Mock rookie draft rounds"
                            accessibilityLabelForOption={rookieRoundChipLabel}
                        />
                        <Text style={panelStyles.nominationModeLabel}>Timeout behavior</Text>
                        <DraftChips
                            options={ROOKIE_TIMER_EXPIRY_CHIPS}
                            selectedValue={rookieTimerExpiryBehavior}
                            onSelect={onRookieTimerExpiryBehaviorChange}
                            groupLabel="Mock rookie timeout behavior"
                        />
                    </>
                )}
            </View>
            {rooms.length ? null : <MockRoomsEmptyState compact={compactComposer} />}
        </>
    )

    return (
        <ScrollView contentContainerStyle={compactComposer ? undefined : panelStyles.panelScroll}>
            {compactComposer ? (
                <View style={[panelStyles.panelScroll, panelStyles.panelScrollCompactLandscape, styles.mockRoomsScrollCompact]}>
                    {panelContent}
                </View>
            ) : panelContent}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    draftButtonDisabled: { opacity: 0.5 },
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
    mockCompactCreateRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    mockCompactTypeWrap: {
        flex: 1,
        minWidth: 0,
    },
    mockCompactCreateButton: {
        flexBasis: 152,
        flexShrink: 0,
    },
    mockRoomsScrollCompact: {
        paddingTop: spacing.xs,
    },
    roomSection: { gap: spacing.sm },
    roomList: { gap: spacing.sm },
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
    roomCardCompact: {
        minHeight: 44,
        paddingVertical: 0,
        paddingHorizontal: spacing.lg,
        gap: 0,
        justifyContent: 'center',
    },
    roomCardTop: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    roomCardTopCompact: { alignItems: 'center' },
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
    roomActionRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        flexWrap: 'wrap',
    },
    roomCompactActionWrap: {
        width: 148,
        flexShrink: 0,
    },
    mockRoomsEmptyState: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        gap: spacing.xs,
    },
    mockRoomsEmptyStateCompact: {
        minHeight: 44,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        gap: spacing.xxs,
        justifyContent: 'center',
    },
    mockRoomsEmptyTitle: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    mockRoomsEmptyTitleCompact: { fontSize: fontSize.sm },
    mockRoomsEmptyText: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textMuted,
    },
    mockRoomsEmptyTextCompact: {
        fontSize: fontSize.xs,
        lineHeight: 16,
    },
})
