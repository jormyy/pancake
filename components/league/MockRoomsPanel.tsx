import { useEffect, useState } from 'react'
import { getMockDraftRoomStatus } from '@/lib/mockDraftRooms'
import { ScreenStatusScrollView as ScrollView } from '@/components/ui/ScreenStatusOverlay'
import { View, Text, Pressable, StyleSheet, TextInput } from 'react-native'
import type {
    MockDraftRoom,
    MockDraftRoomKind,
    MockDraftRoomStatus,
} from '@/lib/mockDraftRooms'
import { controlSize, colors, fontSize, fontWeight, radii, spacing, textStyles } from '@/constants/tokens'
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
import { Button, usePageMetrics } from '@/components/ui'

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
    const startBlockedCopy = roomStartBlockedCopy(room)
    const parts = [
        room.roomName,
        `${ROOM_STATUS_LABELS[room.roomStatus]} ${roomTypeLabel(room.draftType)} mock room`,
        `starts ${formatRoomTime(room.scheduledAt)}`,
        `creator ${room.creatorTeamName}`,
        `${room.participants.length} joined`,
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
                <Text style={styles.roomMeta} numberOfLines={1}>
                    Creator: {room.creatorTeamName} · {room.participants.length} joined
                </Text>
            )}
            {compact ? null : action}
        </View>
    )
}

function MockRoomsEmptyState({ compact }: { compact: boolean }) {
    const title = 'No mock rooms yet.'
    const fullBody = 'Create an auction or rookie room for managers to join before starting a mock draft.'
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
        </View>
    )
}

export function MockRoomsPanel({
    embedded = false,
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
    embedded?: boolean
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
    const { padX } = usePageMetrics()
    const compactComposer = viewportHeight < 500
    const [creating, setCreating] = useState(false)
    const [now, setNow] = useState(Date.now)
    const renderTime = Math.max(now, Date.now())
    const currentRooms = rooms.map((room) => ({ ...room, roomStatus: getMockDraftRoomStatus(room, renderTime) }))
    useEffect(() => {
        const currentTime = Date.now()
        const nextStart = Math.min(...rooms
            .filter((room) => getMockDraftRoomStatus(room, now) === 'scheduled')
            .map((room) => Date.parse(room.scheduledAt!)))
        if (!Number.isFinite(nextStart)) return
        const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(0, nextStart - currentTime), 2_147_483_647))
        return () => clearTimeout(timer)
    }, [now, rooms])
    const statuses: MockDraftRoomStatus[] = ['live', 'active', 'scheduled', 'completed']

    const createButton = (
        <Pressable
            style={panelStyles.draftButton}
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
        const statusRooms = currentRooms.filter((room) => room.roomStatus === status)
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
            <View style={styles.mockHeader}>
                <Text style={panelStyles.panelTitle}>Mock rooms</Text>
                <Button
                    title={creating ? 'Cancel' : 'New mock room'}
                    variant="outline"
                    size="sm"
                    disabled={roomSubmitting}
                    onPress={() => setCreating(!creating)}
                />
            </View>
            {creating ? <View style={[panelStyles.panelCard, compactComposer && panelStyles.panelCardCompact]}>
                <TextInput
                    style={styles.textInput}
                    value={roomName}
                    onChangeText={onRoomNameChange}
                    placeholder="Room name"
                    placeholderTextColor={colors.inputPlaceholder}
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
                <Text style={panelStyles.nominationModeLabel}>Starts</Text>
                <TextInput
                    style={styles.textInput}
                    value={roomScheduledAt}
                    onChangeText={onRoomScheduledAtChange}
                    placeholder="YYYY-MM-DD HH:mm"
                    placeholderTextColor={colors.inputPlaceholder}
                    autoCapitalize="none"
                    accessibilityLabel="Mock room start time"
                />
                <Text style={panelStyles.nominationModeLabel}>Timer</Text>
                <DraftTimerControl
                    selectedValue={draftTimerSeconds}
                    onSelect={onDraftTimerSecondsChange}
                    groupLabel="Mock draft timer"
                    rookie={roomDraftType === 'snake'}
                />
                {roomDraftType === 'auction' ? (
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
                {createButton}
            </View> : null}
            {rooms.length ? roomSections() : null}
            {rooms.length || creating ? null : <MockRoomsEmptyState compact={compactComposer} />}
        </>
    )

    if (embedded) return <View style={styles.embedded}>{panelContent}</View>

    return (
        <ScrollView contentContainerStyle={compactComposer ? undefined : [panelStyles.panelScroll, { paddingHorizontal: padX }]}>
            {compactComposer ? (
                <View style={[panelStyles.panelScroll, { paddingHorizontal: padX }, panelStyles.panelScrollCompactLandscape, styles.mockRoomsScrollCompact]}>
                    {panelContent}
                </View>
            ) : panelContent}
        </ScrollView>
    )
}

const styles = StyleSheet.create({
    embedded: { gap: spacing.md },
    mockHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
    draftButtonDisabled: { opacity: 0.5 },
    textInput: {
        height: controlSize.minTouch,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        paddingHorizontal: spacing.lg,
        // 16px keeps iOS Safari from zooming the page when the field is focused.
        fontSize: fontSize.lg,
        color: colors.textPrimary,
        backgroundColor: colors.bgScreen,
    },
    mockRoomsScrollCompact: {
        paddingTop: spacing.xs,
    },
    roomSection: { gap: spacing.sm },
    roomList: { gap: spacing.sm },
    sectionLabel: { ...textStyles.sectionLabel, marginLeft: spacing.xs },
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
        minHeight: controlSize.minTouch,
        paddingVertical: 0,
        paddingHorizontal: spacing.lg,
        gap: 0,
        justifyContent: 'center',
    },
    roomCardTop: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
    roomCardTopCompact: { alignItems: 'center' },
    roomTitleWrap: { flex: 1, minWidth: 0 },
    roomTitle: { ...textStyles.rowTitle },
    roomMeta: { ...textStyles.meta },
    roomStatusPill: {
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
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
        minHeight: controlSize.minTouch,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        gap: spacing.xxs,
        justifyContent: 'center',
    },
    mockRoomsEmptyTitle: { ...textStyles.rowTitle },
    mockRoomsEmptyTitleCompact: { fontSize: fontSize.sm },
})
