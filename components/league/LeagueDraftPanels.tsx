import { useCallback, useEffect, useId, useRef } from 'react'
import { View, Text, Pressable, StyleSheet, ScrollView, TextInput, useWindowDimensions, Platform } from 'react-native'
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
import { PicksBankList } from '@/components/league/LeagueSections'
import { useWebViewport } from '@/hooks/use-web-viewport'
import type { LeagueStatus } from '@/types/database'

type ChipValue = string | number
type ChipOption<T extends ChipValue> = {
    value: T
    label: string
}
type WebKeyboardEvent = {
    key: string
    preventDefault?: () => void
}
type WebKeyDownProps = {
    onKeyDown?: (event: WebKeyboardEvent) => void
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
const FOCUS_RECOVERY_DELAYS = [0, 50, 150, 350, 700, 1200, 2000, 3000] as const
const INTERACTIVE_ROLES = new Set([
    'alertdialog',
    'button',
    'checkbox',
    'combobox',
    'dialog',
    'link',
    'menuitem',
    'radio',
    'switch',
    'tab',
    'textbox',
])
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

function roomCountLabel(count: number) {
    return `${count} ${count === 1 ? 'room' : 'rooms'}`
}

function roomTypeLabel(type: MockDraftRoomKind) {
    return type === 'snake' ? 'Rookie' : 'Auction'
}

function roomSectionAccessibilityLabel(status: MockDraftRoomStatus, count: number) {
    return `${ROOM_STATUS_LABELS[status]} mock rooms, ${roomCountLabel(count)}`
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

function nextChipIndex(currentIndex: number, key: string, count: number): number | null {
    if (key === 'ArrowRight' || key === 'ArrowDown') return (currentIndex + 1) % count
    if (key === 'ArrowLeft' || key === 'ArrowUp') return (currentIndex - 1 + count) % count
    if (key === 'Home') return 0
    if (key === 'End') return count - 1
    return null
}

function draftChipId(idBase: string, value: ChipValue) {
    return `${idBase}-${String(value).replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

function shouldRecoverDraftChipFocus(target: HTMLElement) {
    const active = document.activeElement
    if (!active || active === target || active === document.body) return true
    if (!(active instanceof HTMLElement)) return false

    const role = active.getAttribute('role')
    if (role === 'radio') return true
    if (role && INTERACTIVE_ROLES.has(role)) return false
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return false
    return !active.isContentEditable
}

function focusDraftChip(idBase: string, value: ChipValue, shouldFocus: () => boolean) {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return
    const focus = () => {
        if (!shouldFocus()) return
        const target = document.getElementById(draftChipId(idBase, value))
        if (target instanceof HTMLElement && shouldRecoverDraftChipFocus(target)) target.focus()
    }
    for (const delay of FOCUS_RECOVERY_DELAYS) {
        if (delay === 0) requestAnimationFrame(focus)
        else setTimeout(focus, delay)
    }
}

function DraftChips<T extends ChipValue>({
    options,
    selectedValue,
    onSelect,
    groupLabel,
    accessibilityLabelForOption,
    compact = false,
}: {
    options: readonly ChipOption<T>[]
    selectedValue: T
    onSelect: (value: T) => void
    groupLabel: string
    accessibilityLabelForOption?: (option: ChipOption<T>) => string
    compact?: boolean
}) {
    const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
    const idBase = `draft-chip-${generatedId}`
    const pendingFocusValue = useRef<T | null>(null)
    const focusRequestId = useRef(0)

    const scheduleChipFocus = useCallback((value: T) => {
        const requestId = ++focusRequestId.current
        focusDraftChip(idBase, value, () => focusRequestId.current === requestId)
    }, [idBase])

    useEffect(() => {
        if (pendingFocusValue.current !== selectedValue) return
        pendingFocusValue.current = null
        scheduleChipFocus(selectedValue)
    }, [scheduleChipFocus, selectedValue])

    function selectValue(value: T) {
        pendingFocusValue.current = value
        onSelect(value)
        scheduleChipFocus(value)
    }

    function handleKeyDown(event: WebKeyboardEvent, index: number) {
        const nextIndex = nextChipIndex(index, event.key, options.length)
        if (nextIndex == null) return

        event.preventDefault?.()
        selectValue(options[nextIndex].value)
    }

    return (
        <View
            style={[styles.nominationModeRow, compact && styles.nominationModeRowCompact]}
            role="radiogroup"
            aria-label={groupLabel}
            aria-orientation="horizontal"
            accessibilityRole="radiogroup"
            accessibilityLabel={groupLabel}
        >
            {options.map((option, index) => {
                const selected = selectedValue === option.value
                const accessibilityLabel = accessibilityLabelForOption?.(option) ?? option.label
                const webKeyProps: WebKeyDownProps = Platform.OS === 'web'
                    ? { onKeyDown: (event) => handleKeyDown(event, index) }
                    : {}
                return (
                    <Pressable
                        key={String(option.value)}
                        nativeID={draftChipId(idBase, option.value)}
                        style={[styles.nominationModeChip, selected && styles.nominationModeChipOn]}
                        onPress={() => selectValue(option.value)}
                        role="radio"
                        aria-label={accessibilityLabel}
                        aria-checked={selected}
                        tabIndex={selected ? 0 : -1}
                        accessibilityRole="radio"
                        accessibilityLabel={accessibilityLabel}
                        accessibilityState={{ checked: selected }}
                        {...webKeyProps}
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

const draftTimerChipLabel = (option: ChipOption<DraftTimerOption>) => `${option.value} seconds`
const rookieRoundChipLabel = (option: ChipOption<RookieRoundOption>) => `${option.value} rounds`
const mockRoomTypeChipLabel = (option: ChipOption<MockDraftRoomKind>) => `${option.label} room`

function auctionStartButtonLabel(draftTimerSeconds: DraftTimerOption, nominationMode: NominationOrderMode) {
    return `Start auction draft, ${draftTimerSeconds} second timer, ${NOMINATION_ORDER_MODE_LABELS[nominationMode]} nomination order`
}

function rookieStartButtonLabel(
    rookieRounds: RookieRoundOption,
    draftTimerSeconds: DraftTimerOption,
    rookieTimerExpiryBehavior: RookieTimerExpiryBehavior,
) {
    return `Start rookie draft, ${rookieRounds} rounds, ${draftTimerSeconds} second timer, ${ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[rookieTimerExpiryBehavior]} timeout behavior`
}

function activeDraftButtonLabel(draft: Draft) {
    const mock = draft.isMock ? 'Mock ' : ''
    const kind = draft.draftType === 'snake' ? 'Rookie Draft' : 'Auction Draft'
    if (draft.status === 'completed' && draft.draftType === 'snake') return 'Resolve Rookie Draft'
    return `${draft.status === 'paused' ? 'Resume' : 'Join'} ${mock}${kind}`
}

function roomStartBlockedCopy(room: MockDraftRoom) {
    if (!room.isCreator || room.roomStatus !== 'active') return null
    const missing = Math.max(0, 2 - room.participants.length)
    if (missing === 0) return null
    return `Needs ${missing} more joined ${missing === 1 ? 'team' : 'teams'}`
}

function roomStartBlockedButtonText(room: MockDraftRoom) {
    const missing = Math.max(0, 2 - room.participants.length)
    return `Needs ${missing} ${missing === 1 ? 'Team' : 'Teams'}`
}

function activeDraftLoadingLabel(filterType?: 'auction' | 'snake') {
    if (filterType === 'snake') return 'Checking for live rookie draft'
    if (filterType === 'auction') return 'Checking for live auction draft'
    return 'Checking for live draft'
}

function activeDraftLoadingDescription() {
    return 'Looking for an active draft room before showing draft setup controls.'
}

function ActiveDraftLoadingNotice({
    compact,
    filterType,
}: {
    compact: boolean
    filterType?: 'auction' | 'snake'
}) {
    const label = activeDraftLoadingLabel(filterType)
    const description = activeDraftLoadingDescription()
    const accessibilityLabel = `${label}. ${description}`
    return (
        <View
            style={[styles.draftLoadingNotice, compact && styles.draftLoadingNoticeCompact]}
            role="status"
            aria-label={accessibilityLabel}
            aria-live="polite"
            aria-busy
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
            accessibilityState={{ busy: true }}
        >
            <Text style={styles.draftLoadingTitle}>{label}</Text>
            {compact ? null : (
                <Text style={styles.draftLoadingText}>
                    {description}
                </Text>
            )}
        </View>
    )
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
    const { height } = useWindowDimensions()
    const compactActiveDraft = height < 500

    if (activeDraftLoading) {
        return <ActiveDraftLoadingNotice compact={compactActiveDraft} filterType={filterType} />
    }

    if (!activeDraft || (filterType && activeDraft.draftType !== filterType)) {
        return null
    }

    const showSyncPicks = OPEN_DRAFT_STATUSES.has(activeDraft.status) && activeDraft.draftType === 'snake' && !activeDraft.isMock && isCommissioner
    const joinButton = (
        <Pressable
            style={[styles.draftButton, compactActiveDraft && styles.activeDraftCompactButton]}
            onPress={onJoinDraft}
            disabled={draftLoading}
            role="button"
            aria-label={activeDraftButtonLabel(activeDraft)}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={activeDraftButtonLabel(activeDraft)}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={styles.draftButtonText} numberOfLines={1}>{activeDraftButtonLabel(activeDraft)}</Text>
        </Pressable>
    )
    const syncButton = showSyncPicks ? (
        <Pressable
            style={[styles.secondaryDraftButton, compactActiveDraft && styles.activeDraftCompactButton]}
            onPress={onReseedRookiePicks}
            disabled={draftLoading}
            role="button"
            aria-label="Sync traded picks"
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel="Sync traded picks"
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={styles.secondaryDraftButtonText} numberOfLines={1}>Sync Traded Picks</Text>
        </Pressable>
    ) : null

    if (compactActiveDraft) {
        return (
            <View style={[styles.panelCard, styles.panelCardCompact, styles.activeDraftCardCompact]}>
                <View style={styles.activeDraftCompactRow}>
                    <Text style={[styles.panelTitle, styles.activeDraftCompactTitle]} numberOfLines={1}>Live Draft</Text>
                    {joinButton}
                    {syncButton}
                </View>
            </View>
        )
    }

    return (
        <View style={styles.panelCard}>
            <Text style={styles.panelTitle}>Live Draft</Text>
            {joinButton}
            {showSyncPicks ? (
                <View style={styles.syncWrap}>
                    {syncButton}
                    <Text style={styles.syncHint}>Commissioner only - pull in picks acquired via trade so the draft board is current.</Text>
                </View>
            ) : null}
        </View>
    )
}

function ActiveDraftErrorNotice({ activeDraftError, onRetryActiveDraft }: ActiveDraftErrorProps) {
    if (!activeDraftError) return null
    const message = 'Live draft status could not refresh. Select to retry.'
    return (
        <Pressable
            style={styles.errorNotice}
            onPress={onRetryActiveDraft}
            role="button"
            aria-label={message}
            aria-live="polite"
            accessibilityRole="button"
            accessibilityLabel={message}
            accessibilityLiveRegion="polite"
        >
            <Text style={styles.errorNoticeText}>{message}</Text>
        </Pressable>
    )
}

function DraftPrepNotice({
    kind,
    status,
    compact = false,
    onOpenDraftBoard,
}: {
    kind: 'auction' | 'rookie'
    status?: LeagueStatus
    compact?: boolean
    onOpenDraftBoard?: () => void
}) {
    const auctionFinished = kind === 'auction' && (status === 'active' || status === 'playoffs')
    const title = kind === 'rookie'
        ? 'Rookie draft prep'
        : auctionFinished ? 'Auction complete' : 'Startup auction'
    const body = (() => {
        if (status === 'drafting') {
            return kind === 'auction'
                ? 'The league is drafting now. If the room is missing, refresh the active draft card above.'
                : 'A draft is in progress. Pick ownership below remains available while rosters update.'
        }
        if (status === 'active' || status === 'playoffs') {
            return kind === 'auction'
                ? "The startup auction finished before the season. Draft results live on each team's roster."
                : 'Future rookie picks remain visible during the live season for trades and long-term planning.'
        }
        if (status === 'offseason') {
            return kind === 'auction'
                ? 'The league is past the startup auction.'
                : 'Pick ownership below is the source of truth before the rookie draft clock starts.'
        }
        if (status === 'archived') {
            return kind === 'auction'
                ? 'This league is archived, so the startup auction is preserved as league history.'
                : 'Future pick ownership is preserved with league history, including traded picks.'
        }
        return kind === 'auction'
            ? 'Commissioners can start the auction from setup; managers can still review league state before the clock starts.'
            : 'Future pick ownership is visible before the draft room opens, including traded picks.'
    })()
    const accessibilityLabel = `${title}. ${body}`
    const showDraftBoardAction = auctionFinished && !compact && Boolean(onOpenDraftBoard)

    return (
        <View
            style={[styles.prepNotice, compact && styles.prepNoticeCompact]}
            role="status"
            aria-label={accessibilityLabel}
            aria-live="polite"
            accessibilityRole="summary"
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
        >
            <Text style={[styles.prepNoticeTitle, compact && styles.prepNoticeTitleCompact]} numberOfLines={compact ? 1 : undefined}>
                {title}
            </Text>
            <Text style={[styles.prepNoticeText, compact && styles.prepNoticeTextCompact]} numberOfLines={compact ? 1 : undefined}>
                {body}
            </Text>
            {showDraftBoardAction ? (
                <Pressable
                    style={[styles.secondaryDraftButton, styles.prepNoticeAction]}
                    onPress={onOpenDraftBoard}
                    role="button"
                    aria-label="View Draft Board"
                    accessibilityRole="button"
                    accessibilityLabel="View Draft Board"
                >
                    <Text style={styles.secondaryDraftButtonText}>View Draft Board</Text>
                </Pressable>
            ) : null}
        </View>
    )
}

function draftBoardSetupMaxHeight(width: number, height: number) {
    if (height < 500) return 64
    if (width < 600) return 144
    return 188
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
    onOpenDraftBoard,
}: Pick<DraftControlProps, 'nominationMode' | 'onNominationModeChange' | 'draftTimerSeconds' | 'onDraftTimerSecondsChange'> & {
    activeDraft: Draft | null
    activeDraftLoading: boolean
    currentLeagueStatus?: LeagueStatus
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    onStartDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
    onOpenDraftBoard?: () => void
}) {
    const { height } = useWindowDimensions()
    const compactSetup = height < 500
    const activeDraftReady = !activeDraftLoading && !activeDraftError
    const hasActiveAuction = activeDraftReady && activeDraft?.draftType === 'auction'
    const canStartAuction = activeDraftReady && currentLeagueStatus === 'setup' && isCommissioner
    const startAuctionAccessibilityLabel = auctionStartButtonLabel(draftTimerSeconds, nominationMode)

    const startButton = (
        <Pressable
            style={[styles.draftButton, compactSetup && styles.auctionCompactStartButton]}
            onPress={onStartDraft}
            disabled={draftLoading}
            role="button"
            aria-label={startAuctionAccessibilityLabel}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={startAuctionAccessibilityLabel}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={styles.draftButtonText}>Start Auction Draft</Text>
        </Pressable>
    )

    return (
        <ScrollView contentContainerStyle={[
            styles.panelScroll,
            compactSetup && styles.panelScrollCompactLandscape,
            compactSetup && (hasActiveAuction || canStartAuction) && styles.activeDraftPanelScrollCompact,
        ]}>
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
                <View style={[styles.panelCard, compactSetup && styles.panelCardCompact, compactSetup && styles.auctionPanelCardCompact]}>
                    {compactSetup ? null : <Text style={styles.panelTitle}>Auction</Text>}
                    {compactSetup ? (
                        <>
                            <View style={styles.auctionCompactStartRow}>
                                <View style={styles.auctionCompactTimerWrap}>
                                    <DraftChips
                                        options={DRAFT_TIMER_CHIPS}
                                        selectedValue={draftTimerSeconds}
                                        onSelect={onDraftTimerSecondsChange}
                                        groupLabel="Auction draft timer"
                                        accessibilityLabelForOption={draftTimerChipLabel}
                                        compact
                                    />
                                </View>
                                {startButton}
                            </View>
                            <Text style={[styles.nominationModeLabel, styles.auctionCompactLabel]}>Nomination order</Text>
                            <DraftChips
                                options={NOMINATION_ORDER_CHIPS}
                                selectedValue={nominationMode}
                                onSelect={onNominationModeChange}
                                groupLabel="Nomination order"
                                compact
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.nominationModeLabel}>Timer</Text>
                            <DraftChips
                                options={DRAFT_TIMER_CHIPS}
                                selectedValue={draftTimerSeconds}
                                onSelect={onDraftTimerSecondsChange}
                                groupLabel="Auction draft timer"
                                accessibilityLabelForOption={draftTimerChipLabel}
                            />
                            <Text style={styles.nominationModeLabel}>Nomination order</Text>
                            <DraftChips
                                options={NOMINATION_ORDER_CHIPS}
                                selectedValue={nominationMode}
                                onSelect={onNominationModeChange}
                                groupLabel="Nomination order"
                            />
                            {startButton}
                        </>
                    )}
                </View>
            ) : null}
            {activeDraftReady && !hasActiveAuction && !canStartAuction ? (
                <DraftPrepNotice kind="auction" status={currentLeagueStatus} compact={compactSetup} onOpenDraftBoard={onOpenDraftBoard} />
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
    picksLoading,
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
    currentLeagueStatus?: LeagueStatus
    isCommissioner: boolean
    draftLoading: boolean
    activeDraftError?: string | null
    onRetryActiveDraft: () => void
    picks: LeaguePickItem[]
    picksLoading?: boolean
    myMemberId?: string
    onStartRookieDraft: () => void
    onJoinDraft: () => void
    onReseedRookiePicks: () => void
}) {
    const { width, height } = useWindowDimensions()
    const compactRookieSetup = height < 500
    const constrainBoardTop = width < 600 || height < 500
    const compactRookiePrepNotice = constrainBoardTop
    const boardTopMaxHeight = draftBoardSetupMaxHeight(width, height)
    const activeDraftReady = !activeDraftLoading && !activeDraftError
    const hasActiveRookieDraft = activeDraftReady && activeDraft?.draftType === 'snake'
    const canStartRookieDraft = activeDraftReady && currentLeagueStatus === 'offseason' && isCommissioner
    const showRookiePrepNotice = !picksLoading && activeDraftReady && activeDraft?.draftType !== 'snake' && picks.length === 0
    const showBoardTop = activeDraftLoading || Boolean(activeDraftError) || hasActiveRookieDraft || canStartRookieDraft || showRookiePrepNotice
    const startRookieAccessibilityLabel = rookieStartButtonLabel(rookieRounds, draftTimerSeconds, rookieTimerExpiryBehavior)

    const startRookieButton = (
        <Pressable
            style={[styles.draftButton, compactRookieSetup && styles.rookieCompactStartButton]}
            onPress={onStartRookieDraft}
            disabled={draftLoading}
            role="button"
            aria-label={startRookieAccessibilityLabel}
            aria-disabled={draftLoading}
            accessibilityRole="button"
            accessibilityLabel={startRookieAccessibilityLabel}
            accessibilityState={{ disabled: draftLoading }}
        >
            <Text style={styles.draftButtonText}>Start Rookie Draft</Text>
        </Pressable>
    )

    const boardTop = (
        <>
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
            {canStartRookieDraft ? (
                <View style={[styles.panelCard, compactRookieSetup && styles.panelCardCompact]}>
                    {compactRookieSetup ? null : <Text style={styles.panelTitle}>Rookie Draft</Text>}
                    {compactRookieSetup ? (
                        <>
                            <View style={styles.rookieCompactStartRow}>
                                <View style={styles.rookieCompactRoundsWrap}>
                                    <DraftChips
                                        options={ROOKIE_ROUND_CHIPS}
                                        selectedValue={rookieRounds}
                                        onSelect={onRookieRoundsChange}
                                        groupLabel="Rookie draft rounds"
                                        accessibilityLabelForOption={rookieRoundChipLabel}
                                        compact
                                    />
                                </View>
                                {startRookieButton}
                            </View>
                            <Text style={styles.nominationModeLabel}>Timer</Text>
                            <DraftChips
                                options={DRAFT_TIMER_CHIPS}
                                selectedValue={draftTimerSeconds}
                                onSelect={onDraftTimerSecondsChange}
                                groupLabel="Rookie draft timer"
                                accessibilityLabelForOption={draftTimerChipLabel}
                                compact
                            />
                            <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                            <DraftChips
                                options={ROOKIE_TIMER_EXPIRY_CHIPS}
                                selectedValue={rookieTimerExpiryBehavior}
                                onSelect={onRookieTimerExpiryBehaviorChange}
                                groupLabel="Rookie timeout behavior"
                                compact
                            />
                        </>
                    ) : (
                        <>
                            <Text style={styles.nominationModeLabel}>Timer</Text>
                            <DraftChips
                                options={DRAFT_TIMER_CHIPS}
                                selectedValue={draftTimerSeconds}
                                onSelect={onDraftTimerSecondsChange}
                                groupLabel="Rookie draft timer"
                                accessibilityLabelForOption={draftTimerChipLabel}
                            />
                            <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                            <DraftChips
                                options={ROOKIE_ROUND_CHIPS}
                                selectedValue={rookieRounds}
                                onSelect={onRookieRoundsChange}
                                groupLabel="Rookie draft rounds"
                                accessibilityLabelForOption={rookieRoundChipLabel}
                            />
                            <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
                            <DraftChips
                                options={ROOKIE_TIMER_EXPIRY_CHIPS}
                                selectedValue={rookieTimerExpiryBehavior}
                                onSelect={onRookieTimerExpiryBehaviorChange}
                                groupLabel="Rookie timeout behavior"
                            />
                            {startRookieButton}
                        </>
                    )}
                </View>
            ) : null}
            {showRookiePrepNotice ? (
                <DraftPrepNotice kind="rookie" status={currentLeagueStatus} compact={compactRookiePrepNotice} />
            ) : null}
        </>
    )

    return (
        <View style={styles.boardWrap}>
            {showBoardTop ? (
                constrainBoardTop ? (
                    <ScrollView
                        style={[styles.boardTopScroll, { maxHeight: boardTopMaxHeight }]}
                        showsVerticalScrollIndicator
                    >
                        <View style={[styles.boardTop, styles.boardTopConstrained]}>
                            {boardTop}
                        </View>
                    </ScrollView>
                ) : (
                    <View style={styles.boardTop}>
                        {boardTop}
                    </View>
                )
            ) : null}
            <View style={styles.boardList}>
                <PicksBankList
                    picks={picks}
                    myMemberId={myMemberId}
                    loading={picksLoading}
                    leagueStatus={currentLeagueStatus}
                />
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
    const roomName = room.roomName
    if (room.roomStatus === 'live' || room.roomStatus === 'completed') {
        const actionLabel = room.roomStatus === 'live' ? `Enter ${roomName}` : `View ${roomName}`
        return (
            <Pressable
                style={styles.secondaryDraftButton}
                onPress={() => onOpen(room.id, room.draftType)}
                disabled={draftLoading}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading }}
            >
                <Text style={styles.secondaryDraftButtonText}>
                    {room.roomStatus === 'live' ? 'Enter Room' : 'View Room'}
                </Text>
            </Pressable>
        )
    }
    if (!room.isJoined) {
        const actionLabel = `Join ${roomName}`
        return (
            <Pressable
                style={styles.secondaryDraftButton}
                onPress={() => onJoin(room)}
                disabled={draftLoading}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading }}
            >
                <Text style={styles.secondaryDraftButtonText}>Join Room</Text>
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
        const buttonStyle = canStart ? styles.draftButton : styles.secondaryDraftButton
        const buttonTextStyle = canStart ? styles.draftButtonText : styles.secondaryDraftButtonText
        const buttonText = draftLoading && canStart
            ? 'Starting...'
            : startBlockedCopy
              ? roomStartBlockedButtonText(room)
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
                style={styles.secondaryDraftButton}
                onPress={() => onLeave(room)}
                disabled={draftLoading}
                role="button"
                aria-label={actionLabel}
                aria-disabled={draftLoading}
                accessibilityRole="button"
                accessibilityLabel={actionLabel}
                accessibilityState={{ disabled: draftLoading }}
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
    compact,
    onOpen,
    onJoin,
    onLeave,
    onStart,
}: {
    room: MockDraftRoom
    draftLoading: boolean
    compact?: boolean
    onOpen: (draftId: string, draftType: string) => void
    onJoin: (room: MockDraftRoom) => void
    onLeave: (room: MockDraftRoom) => void
    onStart: (room: MockDraftRoom) => void
}) {
    const action = (
        <RoomAction
            room={room}
            draftLoading={draftLoading}
            onOpen={onOpen}
            onJoin={onJoin}
            onLeave={onLeave}
            onStart={onStart}
        />
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
    const { viewportHeight } = useWebViewport()
    const compactComposer = viewportHeight < 500
    const statuses: MockDraftRoomStatus[] = ['live', 'active', 'scheduled', 'completed']

    const createButton = (
        <Pressable
            style={[styles.draftButton, compactComposer && styles.mockCompactCreateButton]}
            onPress={onCreateRoom}
            disabled={roomSubmitting}
            role="button"
            aria-label="Create mock draft room"
            aria-disabled={roomSubmitting}
            accessibilityRole="button"
            accessibilityLabel="Create mock draft room"
            accessibilityState={{ disabled: roomSubmitting }}
        >
            <Text style={styles.draftButtonText}>Create Room</Text>
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
                        />
                    ))}
                </View>
            </View>
        )
    })

    const panelContent = (
        <>
            {rooms.length ? roomSections() : null}
            <View style={[styles.panelCard, compactComposer && styles.panelCardCompact]}>
                <Text style={styles.panelTitle}>Mock Draft Room</Text>
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
                        <Text style={styles.nominationModeLabel}>Room type</Text>
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
                        <Text style={styles.nominationModeLabel}>Starts</Text>
                        <TextInput
                            style={styles.textInput}
                            value={roomScheduledAt}
                            onChangeText={onRoomScheduledAtChange}
                            placeholder="2026-07-01 19:30"
                            autoCapitalize="none"
                            accessibilityLabel="Mock room start time"
                        />
                        <Text style={styles.nominationModeLabel}>Timer</Text>
                        <DraftChips
                            options={DRAFT_TIMER_CHIPS}
                            selectedValue={draftTimerSeconds}
                            onSelect={onDraftTimerSecondsChange}
                            groupLabel="Mock draft timer"
                            accessibilityLabelForOption={draftTimerChipLabel}
                        />
                    </>
                )}
                {compactComposer ? null : roomDraftType === 'auction' ? (
                    <>
                        <Text style={styles.nominationModeLabel}>Nomination order</Text>
                        <DraftChips
                            options={NOMINATION_ORDER_CHIPS}
                            selectedValue={nominationMode}
                            onSelect={onNominationModeChange}
                            groupLabel="Mock nomination order"
                        />
                    </>
                ) : (
                    <>
                        <Text style={styles.nominationModeLabel}>Rookie rounds</Text>
                        <DraftChips
                            options={ROOKIE_ROUND_CHIPS}
                            selectedValue={rookieRounds}
                            onSelect={onRookieRoundsChange}
                            groupLabel="Mock rookie draft rounds"
                            accessibilityLabelForOption={rookieRoundChipLabel}
                        />
                        <Text style={styles.nominationModeLabel}>Timeout behavior</Text>
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
        <ScrollView contentContainerStyle={compactComposer ? undefined : styles.panelScroll}>
            {compactComposer ? (
                <View style={[styles.panelScroll, styles.panelScrollCompactLandscape, styles.mockRoomsScrollCompact]}>
                    {panelContent}
                </View>
            ) : panelContent}
        </ScrollView>
    )
}

function settingCountLabel(count: number, singular: string, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`
}

function settingsWaiverPriorityRowLabel(row: WaiverPriorityRow, index: number, isMe: boolean) {
    return `Waiver priority ${index + 1}, ${row.teamName}${isMe ? ', your team' : ''}, manager ${row.displayName}`
}

function settingsCompactWaiverSummaryLabel(waiverOrder: WaiverPriorityRow[], myMemberId?: string) {
    if (!waiverOrder.length) return 'No waiver priorities yet. Priority order is listed here once the season starts.'
    const top = waiverOrder[0]
    const isMe = top.memberId === myMemberId
    return `Waiver priority, ${settingCountLabel(waiverOrder.length, 'team')}. First priority ${top.teamName}${isMe ? ', your team' : ''}.`
}

function inviteCodeShareLabel(inviteCode?: string | null) {
    return inviteCode ? `Share invite code ${inviteCode}` : 'Share invite code'
}

function SettingsCompactWaiverSummary({
    waiverOrder,
    myMemberId,
}: {
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
}) {
    const accessibilityLabel = settingsCompactWaiverSummaryLabel(waiverOrder, myMemberId)
    const value = waiverOrder.length ? `${waiverOrder.length} teams` : 'No priority'
    return (
        <View
            style={styles.settingsCompactWaiverSummary}
            role="status"
            aria-label={accessibilityLabel}
            aria-live="polite"
            accessibilityLabel={accessibilityLabel}
            accessibilityLiveRegion="polite"
        >
            <Text style={styles.settingsCompactWaiverLabel} numberOfLines={1}>Waivers</Text>
            <Text style={styles.settingsCompactWaiverValue} numberOfLines={1}>{value}</Text>
        </View>
    )
}

function SettingsWaiverPriorityCard({
    waiverOrder,
    myMemberId,
    compact,
}: {
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
    compact: boolean
}) {
    const listLabel = `Waiver priority, ${settingCountLabel(waiverOrder.length, 'team')}`
    const emptyLabel = 'No waiver priorities yet.'
    const emptyDescription = 'Priority order is listed here once the season starts.'
    const emptyAccessibilityLabel = `${emptyLabel} ${emptyDescription}`

    return (
        <View style={[styles.panelCard, compact && styles.panelCardCompact]}>
            <Text
                style={styles.panelTitle}
                role="heading"
                aria-level={2}
                accessibilityRole="header"
            >
                Waiver Priority
            </Text>
            {waiverOrder.length ? (
                <View
                    role="list"
                    aria-label={listLabel}
                    accessibilityRole="list"
                    accessibilityLabel={listLabel}
                >
                    {waiverOrder.map((row, index) => {
                        const isMe = row.memberId === myMemberId
                        const label = settingsWaiverPriorityRowLabel(row, index, isMe)
                        return (
                            <View
                                key={row.memberId}
                                style={[styles.settingListRow, isMe && styles.settingListRowMe]}
                                role="listitem"
                                aria-label={label}
                                accessibilityRole="text"
                                accessibilityLabel={label}
                            >
                                <Text style={[styles.settingListRank, isMe && styles.settingListTextMe]}>{index + 1}</Text>
                                <Text style={[styles.settingListTeam, isMe && styles.settingListTextMe]} numberOfLines={1}>{row.teamName}</Text>
                                <Text style={[styles.settingListName, isMe && styles.settingListTextMe]} numberOfLines={1}>{row.displayName}</Text>
                            </View>
                        )
                    })}
                </View>
            ) : (
                <View
                    style={styles.settingsEmptyState}
                    role="status"
                    aria-label={emptyAccessibilityLabel}
                    aria-live="polite"
                    accessibilityLabel={emptyAccessibilityLabel}
                    accessibilityLiveRegion="polite"
                >
                    <Text style={styles.settingsEmptyTitle}>{emptyLabel}</Text>
                    <Text style={styles.settingsEmptyText}>{emptyDescription}</Text>
                </View>
            )}
        </View>
    )
}

export function SettingsPanel({
    inviteCode,
    isCommissioner,
    waiverOrder,
    myMemberId,
    onShareInviteCode,
    onOpenBracket,
    onOpenCommissionerSettings,
}: {
    inviteCode?: string | null
    isCommissioner: boolean
    waiverOrder: WaiverPriorityRow[]
    myMemberId?: string
    onShareInviteCode: () => void
    onOpenBracket: () => void
    onOpenCommissionerSettings: () => void
}) {
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    const shareInviteAccessibilityLabel = inviteCodeShareLabel(inviteCode)

    if (compactLandscape) {
        return (
            <ScrollView contentContainerStyle={[styles.panelScroll, styles.settingsScrollCompact, styles.panelScrollCompactLandscape]}>
                <View style={styles.settingsCompactTopRow}>
                    <Pressable
                        style={[styles.secondaryDraftButton, styles.settingsCompactShareButton]}
                        onPress={onShareInviteCode}
                        role="button"
                        aria-label={shareInviteAccessibilityLabel}
                        accessibilityRole="button"
                        accessibilityLabel={shareInviteAccessibilityLabel}
                    >
                        <Text style={styles.secondaryDraftButtonText} numberOfLines={1}>
                            Invite {inviteCode}
                        </Text>
                    </Pressable>
                    <Pressable
                        style={[styles.secondaryDraftButton, styles.settingsCompactButton]}
                        onPress={onOpenBracket}
                        role="button"
                        aria-label="Open playoff bracket"
                        accessibilityRole="button"
                        accessibilityLabel="Open playoff bracket"
                    >
                        <Text style={styles.secondaryDraftButtonText} numberOfLines={1}>Bracket</Text>
                    </Pressable>
                    {isCommissioner ? (
                        <Pressable
                            style={[styles.secondaryDraftButton, styles.settingsCompactButton]}
                            onPress={onOpenCommissionerSettings}
                            role="button"
                            aria-label="Open commissioner settings"
                            accessibilityRole="button"
                            accessibilityLabel="Open commissioner settings"
                        >
                            <Text style={styles.secondaryDraftButtonText} numberOfLines={1}>Commissioner</Text>
                        </Pressable>
                    ) : null}
                    <SettingsCompactWaiverSummary waiverOrder={waiverOrder} myMemberId={myMemberId} />
                </View>
            </ScrollView>
        )
    }

    return (
        <ScrollView contentContainerStyle={styles.panelScroll}>
            <Pressable
                style={styles.inviteRow}
                onPress={onShareInviteCode}
                role="button"
                aria-label={shareInviteAccessibilityLabel}
                accessibilityRole="button"
                accessibilityLabel={shareInviteAccessibilityLabel}
            >
                <Text style={styles.inviteLabel}>Invite Code</Text>
                <Text style={styles.inviteCode}>{inviteCode}</Text>
                <Text style={styles.inviteCopy}>Share</Text>
            </Pressable>
            <View style={styles.settingsActionRow}>
                <Pressable
                    style={styles.secondaryDraftButton}
                    onPress={onOpenBracket}
                    role="button"
                    aria-label="Open playoff bracket"
                    accessibilityRole="button"
                    accessibilityLabel="Open playoff bracket"
                >
                    <Text style={styles.secondaryDraftButtonText}>Bracket</Text>
                </Pressable>
                {isCommissioner ? (
                    <Pressable
                        style={styles.secondaryDraftButton}
                        onPress={onOpenCommissionerSettings}
                        role="button"
                        aria-label="Open commissioner settings"
                        accessibilityRole="button"
                        accessibilityLabel="Open commissioner settings"
                    >
                        <Text style={styles.secondaryDraftButtonText}>Commissioner Settings</Text>
                    </Pressable>
                ) : null}
            </View>
            <SettingsWaiverPriorityCard waiverOrder={waiverOrder} myMemberId={myMemberId} compact={false} />
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
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorNoticeText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.dangerDark },
    draftLoadingNotice: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.lg,
        gap: spacing.xs,
    },
    draftLoadingNoticeCompact: {
        minHeight: 44,
        justifyContent: 'center',
        paddingVertical: spacing.sm,
    },
    draftLoadingTitle: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    draftLoadingText: {
        fontSize: fontSize.xs,
        lineHeight: 16,
        color: colors.textMuted,
    },
    activeDraftCompactRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    activeDraftCardCompact: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xxs,
        gap: 0,
    },
    activeDraftCompactTitle: {
        alignSelf: 'center',
        minWidth: 70,
        maxWidth: 96,
        fontSize: fontSize.sm,
        lineHeight: 18,
    },
    activeDraftCompactButton: {
        flex: 1,
        minWidth: 0,
    },
    prepNotice: {
        backgroundColor: colors.bgCard,
        borderWidth: 1,
        borderColor: colors.borderLight,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        padding: spacing.xl,
        gap: spacing.xs,
    },
    prepNoticeCompact: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xs,
        gap: spacing.sm,
    },
    prepNoticeTitle: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.extrabold,
        color: colors.textPrimary,
    },
    prepNoticeTitleCompact: {
        flexShrink: 0,
        fontSize: fontSize.sm,
        lineHeight: 18,
    },
    prepNoticeText: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textSecondary,
    },
    prepNoticeTextCompact: {
        flex: 1,
        minWidth: 0,
        fontSize: fontSize.xs,
        lineHeight: 16,
    },
    prepNoticeAction: {
        alignSelf: 'flex-start',
        paddingHorizontal: spacing.xl,
        marginTop: spacing.sm,
    },
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
    auctionCompactLabel: { marginTop: spacing.xs, marginBottom: 0 },
    nominationModeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
    nominationModeRowCompact: { marginBottom: 0 },
    nominationModeChip: {
        flexGrow: 1,
        flexBasis: 78,
        minHeight: 44,
        paddingVertical: spacing.sm,
        borderRadius: radii.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgCard,
        justifyContent: 'center',
        alignItems: 'center',
    },
    nominationModeChipOn: { borderColor: colors.primary, backgroundColor: colors.primary },
    nominationModeChipText: { fontSize: fontSize.sm, fontWeight: fontWeight.semibold, color: colors.textSecondary },
    nominationModeChipTextOn: { color: colors.textWhite },

    panelScroll: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
        paddingBottom: spacing['3xl'],
    },
    panelScrollCompactLandscape: { paddingBottom: 96 },
    activeDraftPanelScrollCompact: { paddingTop: spacing.xs },
    settingsScrollCompact: {
        paddingTop: spacing.sm,
        paddingHorizontal: spacing.md,
        gap: spacing.sm,
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
    panelCardCompact: {
        padding: spacing.lg,
        gap: spacing.sm,
    },
    auctionPanelCardCompact: {
        paddingTop: 0,
        paddingBottom: spacing.xs,
        gap: 0,
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
    auctionCompactStartRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    auctionCompactTimerWrap: {
        flex: 1,
        minWidth: 0,
    },
    auctionCompactStartButton: {
        flexBasis: 184,
        flexShrink: 0,
    },
    rookieCompactStartRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.sm,
    },
    rookieCompactRoundsWrap: {
        flex: 1,
        minWidth: 0,
    },
    rookieCompactStartButton: {
        flexBasis: 184,
        flexShrink: 0,
    },
    boardWrap: { flex: 1 },
    boardTop: {
        padding: spacing.xl,
        gap: spacing.lg,
        width: '100%',
        maxWidth: 760,
        alignSelf: 'center',
    },
    boardTopConstrained: {
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
        gap: spacing.sm,
    },
    boardTopScroll: { flexShrink: 0 },
    boardList: { flex: 1 },
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
    settingsActionRow: { gap: spacing.md },
    settingsCompactTopRow: {
        flexDirection: 'row',
        alignItems: 'stretch',
        gap: spacing.xs,
    },
    settingsCompactShareButton: {
        flex: 1.25,
        minWidth: 0,
        paddingHorizontal: spacing.sm,
    },
    settingsCompactButton: {
        flex: 1,
        minWidth: 0,
        paddingHorizontal: spacing.sm,
    },
    settingsCompactWaiverSummary: {
        flex: 0.95,
        minWidth: 0,
        minHeight: 44,
        borderRadius: radii.lg,
        borderCurve: 'continuous' as const,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgSubtle,
        justifyContent: 'center',
        paddingHorizontal: spacing.sm,
    },
    settingsCompactWaiverLabel: {
        fontSize: fontSize.xs,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        textTransform: 'uppercase',
        letterSpacing: 0,
    },
    settingsCompactWaiverValue: {
        fontSize: fontSize.sm,
        fontWeight: fontWeight.bold,
        color: colors.textSecondary,
    },
    settingListRow: {
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.sm,
        borderTopWidth: 1,
        borderTopColor: colors.separator,
    },
    settingListRowMe: { backgroundColor: colors.primaryLight, paddingHorizontal: spacing.sm, marginHorizontal: -spacing.sm },
    settingListTextMe: { color: colors.primaryDark, fontWeight: fontWeight.bold },
    settingListRank: { width: 28, fontSize: fontSize.md, fontWeight: fontWeight.bold, color: colors.textSecondary },
    settingListTeam: { flex: 1, minWidth: 0, fontSize: fontSize.md, fontWeight: fontWeight.semibold, color: colors.textPrimary },
    settingListName: { width: 120, textAlign: 'right', fontSize: fontSize.sm, color: colors.textMuted },
    settingsEmptyState: {
        minHeight: 44,
        justifyContent: 'center',
        gap: spacing.xs,
        paddingTop: spacing.xs,
    },
    settingsEmptyTitle: {
        fontSize: fontSize.md,
        fontWeight: fontWeight.bold,
        color: colors.textPrimary,
    },
    settingsEmptyText: {
        fontSize: fontSize.sm,
        lineHeight: 18,
        color: colors.textMuted,
    },

    inviteRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        minHeight: 44,
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
