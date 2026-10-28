import { NotificationAnnouncementComposer } from '@/components/settings/NotificationAnnouncementComposer'
import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { Stack } from 'expo-router'
import type { ReactNode } from 'react'
import type { TradeVetoMode, WaiverMode } from '@/lib/league'
import { colors } from '@/constants/tokens'
import {
    ARCHIVE_LEAGUE_DESCRIPTION,
    type CommissionerAction,
} from '@/lib/commissioner-settings-policy'
import { LINEUP_SLOT_TYPES } from '@pancake/core'
import { styles } from '@/components/commissioner/settings-styles'
import { EmptyState } from '@/components/EmptyState'
import { ModalScreen } from '@/components/ui/ModalScreen'
import { ErrorBanner, usePageMetrics } from '@/components/ui'
import {
    useCommissionerSettingsController,
} from '@/hooks/use-commissioner-settings-controller'
import { COMMISSIONER_SCORING_FIELDS } from '@/lib/commissioner-settings-fields'

const SLOT_TYPES = LINEUP_SLOT_TYPES

export default function CommissionerSettingsScreen() {
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    const compactMobile = width <= 400
    const { padX } = usePageMetrics()
    const {
        adjustSlot, authorityReady, busyAction, draft, hasDraft, handleAddCountOverride, handleDeleteLeague,
        handleFaabOverride, isCommissioner, lifecycle, loadError, loadState, lowerPriorityActions,
        members, playoffCalendar, playoffFitMessage, playoffFitStatus, playoffRoundsNeedReview, navigateBack, overrideAdds, overrideFaab, overrideMemberId,
        overrideSaving, retryLoad, save, saving, setOverrideAdds, setOverrideFaab,
        setOverrideMemberId, tradeVetoModeDescription, updateField, updateScoring,
    } = useCommissionerSettingsController()
    const {
        timezone, scoring, slots, rosterSize, irSlots, taxiSlots, auctionBudget, playoffWeek,
        weeklyAddLimit, waiverMode, faabBudget, tradeVetoMode, tradeVetoWindowHours,
        tradeVetoThresholdPercent, tradeDeadline, playoffRoundWeeks,
    } = draft

    // Save stays in reach at the top while the long form scrolls under it.
    const saveAction = loadState === 'ready' || loadState === 'loading' ? (
                <Pressable
                    style={[styles.headerSave, (saving || !authorityReady || loadState !== 'ready') && styles.headerSaveDisabled]}
                    onPress={save}
                    disabled={saving || !authorityReady || loadState !== 'ready'}
                    role="button"
                    aria-label="Save league settings"
                    accessibilityRole="button"
                    accessibilityLabel="Save league settings"
                    accessibilityState={{ disabled: saving || !authorityReady || loadState !== 'ready', busy: saving }}
                >
                    <Text style={styles.headerSaveText}>{saving ? 'Saving…' : 'Save'}</Text>
                </Pressable>
    ) : null
    const frame = (children: ReactNode) => (
        <ModalScreen title="League Settings" onBack={navigateBack} backLabel="Back to league settings" actions={saveAction}>
            {children}
        </ModalScreen>
    )

    if ((!hasDraft && loadState !== 'ready') || loadState === 'unauthorized') {
        // While loading, only the header (identical to the loaded chrome)
        // renders — no placeholder card that would swap for the settings form.
        return <>
            <Stack.Screen options={{ title: 'League Settings', presentation: 'modal', headerShown: false }} />
            {frame(<>
                {loadState === 'error' ? <ErrorBanner message={`${loadError ?? 'Could not load league settings.'} Tap to retry.`} onRetry={retryLoad} /> : null}
                {loadState === 'unauthorized' || loadState === 'error' ? (
                    <EmptyState fullScreen={false}
                        message={loadState === 'unauthorized' ? 'Commissioner access required' : 'Settings unavailable'}
                        description={loadState === 'unauthorized' ? 'Only league commissioners can manage these settings.' : 'League controls will appear when the current configuration is ready.'} />
                ) : null}
            </>)}
        </>
    }

    function renderAction(action: CommissionerAction, grid = false) {
        // primaryDark is the accent text color in both themes; primary is a
        // fill color and drops to about 3:1 as text on dark surfaces.
        const color = action.intent === 'danger' ? colors.danger : colors.primaryDark
        const accessibilityLabel = action.description ? `${action.label}. ${action.description}` : action.label
        const button = (
            <Pressable
                key={`${action.id}:${action.label}`}
                style={[styles.actionButton, grid && !action.description && styles.actionButtonGrid, { borderColor: color }]}
                onPress={action.onPress}
                disabled={busyAction !== null || !authorityReady}
                role="button"
                aria-label={accessibilityLabel}
                aria-disabled={busyAction !== null || !authorityReady}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                accessibilityState={{ disabled: busyAction !== null }}
            >
                <Text style={[styles.actionButtonText, { color }]}>{action.label}</Text>
            </Pressable>
        )
        if (!action.description) return button
        return (
            <View key={`${action.id}:${action.label}`} style={[styles.actionWrap, grid && styles.actionButtonGrid]}>
                {button}
                <Text style={styles.actionDescription}>{action.description}</Text>
            </View>
        )
    }

    return (
        <>
            <Stack.Screen options={{ title: 'League Settings', presentation: 'modal', headerShown: false }} />
            {frame(
                <ScrollView
                    aria-busy={!authorityReady}
                    accessibilityState={{ busy: !authorityReady }}
                    contentContainerStyle={[styles.scroll, { paddingHorizontal: padX }, compactLandscape && styles.scrollCompact]}
                    keyboardShouldPersistTaps="handled"
                >
                    {loadState === 'error' ? <ErrorBanner message={`${loadError ?? 'Could not load league settings.'} Tap to retry.`} onRetry={retryLoad} /> : null}
                    <View style={[styles.lifecycleCard, compactLandscape && styles.lifecycleCardCompact]}>
                        <View style={styles.lifecycleCopy}>
                            <Text style={styles.lifecycleTitle}>{lifecycle.label}</Text>
                        </View>
                        <View style={[styles.lifecycleActions, compactLandscape && styles.lifecycleActionsCompact]}>
                            {lifecycle.actions.map((action) => renderAction(action, true))}
                        </View>
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Timezone</Text>
                    <View style={styles.card}>
                        <View style={styles.row}>
                            <Text style={styles.rowLabel}>League timezone</Text>
                            <TextInput
                                style={[styles.scoreInput, { flex: 1 }]}
                                accessibilityLabel="League timezone"
                                value={timezone ?? 'America/Los_Angeles'}
                                placeholder="America/Los_Angeles"
                                autoCapitalize="none"
                                autoCorrect={false}
                                editable={authorityReady && !saving}
                                onChangeText={value => updateField('timezone', value)}
                            />
                        </View>
                        <Text style={styles.actionDescription}>Waiver runs occur at local midnight. All times and day boundaries follow this timezone.</Text>
                    </View>
                    <NotificationAnnouncementComposer />
                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Scoring</Text>
                    <View style={styles.card}>
                        {COMMISSIONER_SCORING_FIELDS.map(({ key, label }, i) => (
                            <View
                                key={key}
                                style={[
                                    styles.row,
                                    i < COMMISSIONER_SCORING_FIELDS.length - 1 && styles.rowBorder,
                                ]}
                            >
                                <Text style={styles.rowLabel}>{label}</Text>
                                <TextInput
                                    style={styles.scoreInput}
                                    accessibilityLabel={`${label} weight`}
                                    value={scoring[key] ?? ''}
                                    onChangeText={(v) => {
                                        if (/^-?\d*\.?\d*$/.test(v) || v === '-') {
                                            updateScoring(key, v)
                                        }
                                    }}
                                    keyboardType="default"
                                    selectTextOnFocus
                                />
                            </View>
                        ))}
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Lineup slots</Text>
                    <View style={styles.card}>
                        {SLOT_TYPES.map((type, i) => (
                            <View
                                key={type}
                                style={[styles.row, i < SLOT_TYPES.length - 1 && styles.rowBorder]}
                            >
                                <Text style={styles.rowLabel}>{type}</Text>
                                <View style={styles.stepper}>
                                    <Pressable
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, -1)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Decrease ${type} slots`}
                                        hitSlop={8}
                                    >
                                        <Text style={styles.stepBtnText}>−</Text>
                                    </Pressable>
                                    <Text style={styles.stepValue}>{slots[type] ?? 0}</Text>
                                    <Pressable
                                        style={styles.stepBtn}
                                        onPress={() => adjustSlot(type, 1)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Increase ${type} slots`}
                                        hitSlop={8}
                                    >
                                        <Text style={styles.stepBtnText}>+</Text>
                                    </Pressable>
                                </View>
                            </View>
                        ))}
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">General</Text>
                    <View style={styles.card}>
                        {[
                            { label: 'Active Roster Size', value: rosterSize, set: (value: string) => updateField('rosterSize', value) },
                            { label: 'IR Slots', value: irSlots, set: (value: string) => updateField('irSlots', value) },
                            { label: 'Taxi Squad Slots', value: taxiSlots, set: (value: string) => updateField('taxiSlots', value) },
                            {
                                label: 'Auction Budget ($)',
                                value: auctionBudget,
                                set: (value: string) => updateField('auctionBudget', value),
                            },
                            {
                                label: 'Weekly Add Limit (0 = unlimited)',
                                value: weeklyAddLimit,
                                set: (value: string) => updateField('weeklyAddLimit', value),
                            },
                            {
                                label: 'FAAB Starting Budget',
                                value: faabBudget,
                                set: (value: string) => updateField('faabBudget', value),
                            },
                        ].map(({ label, value, set }, i, arr) => (
                            <View
                                key={label}
                                style={[styles.row, i < arr.length - 1 && styles.rowBorder]}
                            >
                                <Text style={styles.rowLabel}>{label}</Text>
                                <TextInput
                                    style={styles.scoreInput}
                                    accessibilityLabel={label}
                                    value={value}
                                    onChangeText={set}
                                    keyboardType="numeric"
                                    selectTextOnFocus
                                />
                            </View>
                        ))}
                        <View style={[styles.row, styles.rowBorder]}>
                            <Text style={styles.rowLabel}>Waiver Mode</Text>
                            <View style={styles.segmentRow}>
                                {(['faab', 'rolling'] as WaiverMode[]).map((mode) => {
                                    const active = waiverMode === mode
                                    return (
                                        <Pressable
                                            key={mode}
                                            style={[styles.segmentButton, active && styles.segmentButtonActive]}
                                            onPress={() => updateField('waiverMode', mode)}
                                        >
                                            <Text style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>
                                                {mode === 'faab' ? 'FAAB' : 'Rolling'}
                                            </Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </View>
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">League and taxi rules</Text>
                    <View style={styles.card}>
                        {[
                            { label: 'Team Limit', value: draft.teamLimit ?? '10', set: (value: string) => updateField('teamLimit', value) },
                            { label: 'Taxi Tenure (seasons)', value: draft.taxiMaxSeasons ?? '', set: (value: string) => updateField('taxiMaxSeasons', value) },
                        ].map(({ label, value, set }) => <View key={label} style={styles.row}>
                            <Text style={styles.rowLabel}>{label}</Text>
                            <TextInput style={styles.scoreInput} accessibilityLabel={label} value={value} onChangeText={set} keyboardType="numeric" />
                        </View>)}

                        <Pressable accessibilityRole="checkbox" aria-checked={draft.allowInactiveTrades ?? false} accessibilityState={{ checked: draft.allowInactiveTrades ?? false }}
                            onPress={() => updateField('allowInactiveTrades', !draft.allowInactiveTrades)} style={styles.row}>
                            <Text style={styles.rowLabel}>Allow IR and taxi trades</Text><Text>{draft.allowInactiveTrades ? 'On' : 'Off'}</Text>
                        </Pressable>
                        <Text style={styles.settingHint}>Team count locks after setup. Taxi rules apply at acquisition and season rollover. Expired tenure promotes the player; roster overflow needs resolution.</Text>
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Playoffs</Text>
                    <View style={styles.card}>
                        <Text style={styles.settingHint} accessibilityRole={playoffFitStatus === 'fit' ? undefined : 'alert'}>{playoffFitMessage}</Text>
                        {playoffRoundsNeedReview && (
                            <Text style={styles.settingHint}>
                                The team count changed. Review the round lengths and total before starting a draft or generating the schedule.
                            </Text>
                        )}
                        {[
                            { label: 'Playoff Start Week', value: playoffWeek, set: (value: string) => updateField('playoffWeek', value) },
                            { label: 'Playoff Entrants', value: draft.playoffEntrants ?? '', set: (value: string) => updateField('playoffEntrants', value) },
                            { label: 'Playoff Rounds', value: draft.playoffRoundCount ?? '', set: (value: string) => {
                                updateField('playoffRoundCount', value)
                                if (/^[1-9][0-9]*$/.test(value) && Number(value) === Math.ceil(Math.log2(Number(draft.playoffEntrants)))) updateField('playoffRoundWeeks', Array.from({ length: Number(value) }, (_, index) => playoffRoundWeeks[index] ?? '1'))
                            } },
                            ...playoffRoundWeeks.map((_, index) => `Round ${index + 1} Weeks`).map((label, index) => ({
                                label,
                                value: playoffRoundWeeks[index] ?? '',
                                set: (value: string) => updateField('playoffRoundWeeks',
                                    Array.from({ length: playoffRoundWeeks.length }, (_, round) => round === index ? value : playoffRoundWeeks[round] ?? '')),
                            })),
                        ].map(({ label, value, set }) => (
                            <View key={label} style={[styles.row, styles.rowBorder]}>
                                <Text style={styles.rowLabel}>{label}</Text>
                                <TextInput style={styles.scoreInput} accessibilityLabel={label} value={value}
                                    onChangeText={set} keyboardType="numeric" selectTextOnFocus />
                            </View>
                        ))}
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Skipped weeks (Pacific)</Text>
                    <View style={styles.card}>
                        <Text style={styles.settingHint}>Skipped weeks have no scores or records. Saved skips cannot be restored. Playoff seeds lock this control.</Text>
                        {(playoffCalendar?.ranges ?? []).filter((week) => week.week_number < Number(playoffWeek)).map((week) => {
                            const skipped = draft.skippedWeeks?.includes(week.week_number) ?? false
                            return <Pressable key={week.week_number} accessibilityRole="checkbox" aria-checked={skipped} accessibilityState={{ checked: skipped }} style={styles.row}
                                onPress={() => updateField('skippedWeeks', skipped ? (draft.skippedWeeks ?? []).filter((value) => value !== week.week_number) : [...draft.skippedWeeks ?? [], week.week_number].sort((a, b) => a - b))}>
                                <Text style={styles.rowLabel}>Week {week.week_number}: {week.week_start}–{week.week_end} PT</Text>
                                <Text>{skipped ? 'Skipped' : 'Play'}</Text>
                            </Pressable>
                        })}
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Trade deadline</Text>
                    <View style={styles.card}>
                        <View style={[styles.row, styles.rowBorder]}>
                            <Text style={styles.rowLabel}>Deadline (month/day)</Text>
                            <TextInput
                                style={styles.scoreInput}
                                value={tradeDeadline}
                                onChangeText={(value) => updateField('tradeDeadline', value)}
                                placeholder="None"
                                placeholderTextColor={colors.inputPlaceholder}
                                accessibilityLabel="Trade deadline, month and day"
                                selectTextOnFocus
                            />
                        </View>
                        <Text style={styles.settingHint}>
                            Repeats every season. Trades lock after this day and reopen once a champion is crowned. Leave blank for no deadline.
                        </Text>
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Trade veto</Text>
                    <View style={styles.card}>
                        <View style={[styles.row, styles.rowBorder, compactMobile && styles.rowStacked]}>
                            <Text style={styles.rowLabel}>Veto Mode</Text>
                            <View style={[styles.segmentRow, compactMobile && styles.segmentRowCompact]}>
                                {([
                                    { value: 'member_vote', label: 'Members' },
                                    { value: 'commissioner', label: 'Commish' },
                                    { value: 'disabled', label: 'Off' },
                                ] as { value: TradeVetoMode; label: string }[]).map((mode) => {
                                    const active = tradeVetoMode === mode.value
                                    return (
                                        <Pressable
                                            key={mode.value}
                                            style={[styles.segmentButton, compactMobile && styles.segmentButtonCompact, active && styles.segmentButtonActive]}
                                            onPress={() => updateField('tradeVetoMode', mode.value)}
                                        >
                                            <Text style={[styles.segmentButtonText, active && styles.segmentButtonTextActive]}>
                                                {mode.label}
                                            </Text>
                                        </Pressable>
                                    )
                                })}
                            </View>
                        </View>
                        <Text style={styles.settingHint}>{tradeVetoModeDescription}</Text>
                        <View style={[styles.row, styles.rowBorder]}>
                            <Text style={styles.rowLabel}>Veto Window Hours</Text>
                            <TextInput
                                style={styles.scoreInput}
                                value={tradeVetoWindowHours}
                                onChangeText={(value) => updateField('tradeVetoWindowHours', value)}
                                keyboardType="numeric"
                                selectTextOnFocus
                            />
                        </View>
                        <View style={styles.row}>
                            <Text style={styles.rowLabel}>Member Threshold %</Text>
                            <TextInput
                                style={styles.scoreInput}
                                value={tradeVetoThresholdPercent}
                                onChangeText={(value) => updateField('tradeVetoThresholdPercent', value)}
                                keyboardType="numeric"
                                selectTextOnFocus
                            />
                        </View>
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Transaction overrides</Text>
                    <View style={styles.card}>
                        <View style={styles.memberChipRow}>
                            {members.map((member) => {
                                const active = overrideMemberId === member.id
                                return (
                                    <Pressable
                                        key={member.id}
                                        style={[styles.memberChip, active && styles.memberChipActive]}
                                        onPress={() => setOverrideMemberId(member.id)}
                                    >
                                        <Text style={[styles.memberChipText, active && styles.memberChipTextActive]}>
                                            {member.team_name ?? 'Unnamed'}
                                        </Text>
                                    </Pressable>
                                )
                            })}
                        </View>
                        <View style={styles.overrideRow}>
                            <TextInput
                                style={styles.overrideInput}
                                value={overrideFaab}
                                onChangeText={setOverrideFaab}
                                keyboardType="numeric"
                                placeholder="FAAB balance"
                                placeholderTextColor={colors.inputPlaceholder}
                            />
                            <Pressable style={styles.overrideButton} onPress={handleFaabOverride} disabled={overrideSaving || !authorityReady}>
                                <Text style={styles.overrideButtonText}>Set FAAB</Text>
                            </Pressable>
                        </View>
                        <View style={styles.overrideRow}>
                            <TextInput
                                style={styles.overrideInput}
                                value={overrideAdds}
                                onChangeText={setOverrideAdds}
                                keyboardType="numeric"
                                placeholder="Weekly adds used"
                                placeholderTextColor={colors.inputPlaceholder}
                            />
                            <Pressable style={styles.overrideButton} onPress={handleAddCountOverride} disabled={overrideSaving || !authorityReady}>
                                <Text style={styles.overrideButtonText}>Set Adds</Text>
                            </Pressable>
                        </View>
                    </View>

                    <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Commissioner actions</Text>
                    {lowerPriorityActions.map((action) => renderAction(action))}

                    {isCommissioner ? (
                        <>
                            <Text style={styles.sectionTitle} role="heading" aria-level={2} accessibilityRole="header">Danger zone</Text>
                            {renderAction({
                                id: 'delete-league',
                                label: 'Archive League',
                                intent: 'danger',
                                onPress: handleDeleteLeague,
                                description: ARCHIVE_LEAGUE_DESCRIPTION,
                            })}
                        </>
                    ) : null}
                </ScrollView>,
            )}
        </>
    )
}

export { ScreenErrorFallback as ErrorBoundary } from '@/components/ScreenErrorFallback'
