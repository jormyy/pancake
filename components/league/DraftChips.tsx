import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { View, Text, TextInput, Pressable, StyleSheet, Platform } from 'react-native'
import {
    NOMINATION_ORDER_MODES,
    NOMINATION_ORDER_MODE_LABELS,
    ROOKIE_TIMER_EXPIRY_BEHAVIORS,
    ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS,
    type NominationOrderMode,
    type RookieTimerExpiryBehavior,
} from '@/lib/draft'
import type { MockDraftRoomKind } from '@/lib/mockDraftRooms'
import { colors, fontSize, fontWeight, radii, spacing } from '@/constants/tokens'
import { nextRovingIndex } from '@/components/ui/rovingFocus'
import {
    DRAFT_TIMER_MAX_SECONDS,
    DRAFT_TIMER_MIN_SECONDS,
    normalizeDraftTimerSeconds,
    type DraftTimerOption,
    type RookieRoundOption,
} from '@/lib/draft-options'

type ChipValue = string | number
export type ChipOption<T extends ChipValue> = {
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

const DRAFT_TIMER_OPTIONS = [15, 30] as const
const ROOKIE_ROUND_OPTIONS = [2, 3] as const

export const MOCK_ROOM_TYPE_CHIPS: readonly ChipOption<MockDraftRoomKind>[] = [
    { value: 'auction', label: 'Auction' },
    { value: 'snake', label: 'Rookie' },
]
const DRAFT_TIMER_CHIPS: readonly ChipOption<DraftTimerOption>[] =
    DRAFT_TIMER_OPTIONS.map((value) => ({ value, label: `${value}s` }))
export const ROOKIE_ROUND_CHIPS: readonly ChipOption<RookieRoundOption>[] =
    ROOKIE_ROUND_OPTIONS.map((value) => ({ value, label: String(value) }))
export const NOMINATION_ORDER_CHIPS: readonly ChipOption<NominationOrderMode>[] =
    NOMINATION_ORDER_MODES.map((value) => ({ value, label: NOMINATION_ORDER_MODE_LABELS[value] }))
export const ROOKIE_TIMER_EXPIRY_CHIPS: readonly ChipOption<RookieTimerExpiryBehavior>[] =
    ROOKIE_TIMER_EXPIRY_BEHAVIORS.map((value) => ({ value, label: ROOKIE_TIMER_EXPIRY_BEHAVIOR_LABELS[value] }))

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

export type DraftControlProps = {
    nominationMode: NominationOrderMode
    onNominationModeChange: (value: NominationOrderMode) => void
    draftTimerSeconds: DraftTimerOption
    onDraftTimerSecondsChange: (value: DraftTimerOption) => void
    rookieRounds: RookieRoundOption
    onRookieRoundsChange: (value: RookieRoundOption) => void
    rookieTimerExpiryBehavior: RookieTimerExpiryBehavior
    onRookieTimerExpiryBehaviorChange: (value: RookieTimerExpiryBehavior) => void
}

function isDraftTimerPreset(value: DraftTimerOption) {
    return DRAFT_TIMER_OPTIONS.some((preset) => preset === value)
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
    // One deferred retry: the re-render after selection can replace the chip node.
    requestAnimationFrame(focus)
    setTimeout(focus, 150)
}

export function DraftChips<T extends ChipValue>({
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
        const nextIndex = nextRovingIndex(index, event.key, options.length)
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
export const rookieRoundChipLabel = (option: ChipOption<RookieRoundOption>) => `${option.value} rounds`
export const mockRoomTypeChipLabel = (option: ChipOption<MockDraftRoomKind>) => `${option.label} room`

export function DraftTimerControl({
    selectedValue,
    onSelect,
    groupLabel,
    compact = false,
}: {
    selectedValue: DraftTimerOption
    onSelect: (value: DraftTimerOption) => void
    groupLabel: string
    compact?: boolean
}) {
    const [customText, setCustomText] = useState(isDraftTimerPreset(selectedValue) ? '' : String(selectedValue))

    useEffect(() => {
        setCustomText(isDraftTimerPreset(selectedValue) ? '' : String(selectedValue))
    }, [selectedValue])

    function handleCustomChange(value: string) {
        const digits = value.replace(/[^0-9]/g, '')
        setCustomText(digits)
        if (!digits) return

        const parsed = Number.parseInt(digits, 10)
        if (
            Number.isFinite(parsed) &&
            parsed >= DRAFT_TIMER_MIN_SECONDS &&
            parsed <= DRAFT_TIMER_MAX_SECONDS
        ) {
            onSelect(parsed)
        }
    }

    function commitCustom() {
        const parsed = Number.parseInt(customText, 10)
        if (!Number.isFinite(parsed)) {
            setCustomText(isDraftTimerPreset(selectedValue) ? '' : String(selectedValue))
            return
        }
        const normalized = normalizeDraftTimerSeconds(parsed)
        setCustomText(String(normalized))
        onSelect(normalized)
    }

    const customSelected = !isDraftTimerPreset(selectedValue)

    return (
        <View style={[styles.timerControl, compact && styles.timerControlCompact]}>
            <View style={styles.timerPresetWrap}>
                <DraftChips
                    options={DRAFT_TIMER_CHIPS}
                    selectedValue={customSelected ? -1 : selectedValue}
                    onSelect={onSelect}
                    groupLabel={groupLabel}
                    accessibilityLabelForOption={draftTimerChipLabel}
                    compact={compact}
                />
            </View>
            <View style={[styles.customTimerField, customSelected && styles.customTimerFieldActive]}>
                <Text style={[styles.customTimerLabel, customSelected && styles.customTimerLabelActive]}>Custom</Text>
                <TextInput
                    style={styles.customTimerInput}
                    value={customText}
                    onChangeText={handleCustomChange}
                    onEndEditing={commitCustom}
                    onSubmitEditing={commitCustom}
                    keyboardType="number-pad"
                    placeholder="sec"
                    placeholderTextColor={colors.textPlaceholder}
                    accessibilityLabel="Custom timer seconds"
                />
            </View>
        </View>
    )
}

const styles = StyleSheet.create({
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
    timerControl: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.sm,
        marginBottom: spacing.sm,
    },
    timerControlCompact: {
        marginBottom: 0,
    },
    timerPresetWrap: {
        flex: 1,
        minWidth: 0,
    },
    customTimerField: {
        minWidth: 118,
        minHeight: 44,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radii.md,
        borderCurve: 'continuous' as const,
        backgroundColor: colors.bgCard,
        paddingHorizontal: spacing.sm,
        paddingVertical: 4,
        justifyContent: 'center',
    },
    customTimerFieldActive: {
        borderColor: colors.primary,
        backgroundColor: colors.primaryLight,
    },
    customTimerLabel: {
        fontSize: 10,
        fontWeight: fontWeight.bold,
        color: colors.textMuted,
        letterSpacing: 0,
    },
    customTimerLabelActive: { color: colors.primaryDark },
    customTimerInput: {
        minHeight: 22,
        padding: 0,
        fontSize: fontSize.sm,
        fontWeight: fontWeight.semibold,
        color: colors.textPrimary,
    },
})
