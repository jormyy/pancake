import {
    View,
    Text,
    TextInput,
    Pressable,
    ScrollView,
    useWindowDimensions,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import MaterialIcons from '@expo/vector-icons/MaterialIcons'
import { Stack } from 'expo-router'
import type { TradeVetoMode, WaiverMode } from '@/lib/league'
import { colors } from '@/constants/tokens'
import type { CommissionerAction } from '@/components/commissioner/settings-policy'
import { LINEUP_SLOT_TYPES } from '@pancake/core'
import { styles } from '@/components/commissioner/settings-styles'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ui'
import {
    COMMISSIONER_SCORING_FIELDS,
    useCommissionerSettingsController,
} from '@/hooks/use-commissioner-settings-controller'

const SLOT_TYPES = LINEUP_SLOT_TYPES

export default function CommissionerSettingsScreen() {
    const { width, height } = useWindowDimensions()
    const compactLandscape = width >= 600 && height < 500
    const compactMobile = width <= 400
    const {
        adjustSlot, busyAction, draft, handleAddCountOverride, handleDeleteLeague,
        handleFaabOverride, isCommissioner, lifecycle, loadError, loadState, lowerPriorityActions,
        members, navigateBack, overrideAdds, overrideFaab, overrideMemberId,
        overrideSaving, retryLoad, save, saving, setOverrideAdds, setOverrideFaab,
        setOverrideMemberId, tradeVetoModeDescription, updateField, updateScoring,
    } = useCommissionerSettingsController()
    const {
        scoring, slots, rosterSize, irSlots, taxiSlots, auctionBudget, playoffWeek,
        weeklyAddLimit, waiverMode, faabBudget, tradeVetoMode, tradeVetoWindowHours,
        tradeVetoThresholdPercent,
    } = draft

    const screenHeader = (
        <View style={styles.screenHeader}>
            <Pressable onPress={navigateBack} style={styles.headerBack} role="link"
                aria-label="Back to league settings" accessibilityRole="link" accessibilityLabel="Back to league settings">
                <MaterialIcons name="arrow-back" size={22} color={colors.textPrimary} />
            </Pressable>
            <Text style={styles.screenTitle}>League Settings</Text>
        </View>
    )

    if (loadState !== 'ready') {
        return <>
            <Stack.Screen options={{ title: 'League Settings', presentation: 'modal', headerShown: false }} />
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {screenHeader}
                {loadState === 'error' ? <ErrorBanner message={loadError ?? 'Could not load league settings.'} onRetry={retryLoad} /> : null}
                <EmptyState fullScreen={false}
                    message={loadState === 'unauthorized' ? 'Commissioner access required' : loadState === 'error' ? 'Settings unavailable' : 'Loading league settings'}
                    description={loadState === 'unauthorized' ? 'Only league commissioners can manage these settings.' : 'League controls will appear when the current configuration is ready.'} />
            </SafeAreaView>
        </>
    }

    function renderAction(action: CommissionerAction, grid = false) {
        const color = action.color ?? colors.primary
        const accessibilityLabel = action.description ? `${action.label}. ${action.description}` : action.label
        const button = (
            <Pressable
                key={`${action.id}:${action.label}`}
                style={[styles.actionButton, grid && !action.description && styles.actionButtonGrid, { borderColor: color }]}
                onPress={action.onPress}
                disabled={busyAction !== null}
                role="button"
                aria-label={accessibilityLabel}
                aria-disabled={busyAction !== null}
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
            <SafeAreaView style={styles.container} edges={['bottom']}>
                {screenHeader}
                <ScrollView
                    contentContainerStyle={[styles.scroll, compactLandscape && styles.scrollCompact]}
                    keyboardShouldPersistTaps="handled"
                >
                    <View style={[styles.lifecycleCard, compactLandscape && styles.lifecycleCardCompact]}>
                        <View style={styles.lifecycleCopy}>
                            <Text style={styles.lifecycleTitle}>{lifecycle.label}</Text>
                            <Text style={styles.lifecycleDetail}>{lifecycle.detail}</Text>
                        </View>
                        <View style={[styles.lifecycleActions, compactLandscape && styles.lifecycleActionsCompact]}>
                            {lifecycle.actions.map((action) => renderAction(action, true))}
                        </View>
                    </View>

                    {/* ── Scoring ────────────────────────────────────── */}
                    <Text style={styles.sectionTitle}>SCORING</Text>
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
                                    value={scoring[key] ?? ''}
                                    onChangeText={(v) => {
                                        // Allow: leading minus, digits, one decimal point
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

                    {/* ── Lineup Slots ───────────────────────────────── */}
                    <Text style={styles.sectionTitle}>LINEUP SLOTS</Text>
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

                    {/* ── General ───────────────────────────────────── */}
                    <Text style={styles.sectionTitle}>GENERAL</Text>
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
                                label: 'Playoff Start Week (18–24)',
                                value: playoffWeek,
                                set: (value: string) => updateField('playoffWeek', value),
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

                    <Text style={styles.sectionTitle}>TRADE VETO</Text>
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

                    <Text style={styles.sectionTitle}>TRANSACTION OVERRIDES</Text>
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
                                placeholderTextColor={colors.textPlaceholder}
                            />
                            <Pressable style={styles.overrideButton} onPress={handleFaabOverride} disabled={overrideSaving}>
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
                                placeholderTextColor={colors.textPlaceholder}
                            />
                            <Pressable style={styles.overrideButton} onPress={handleAddCountOverride} disabled={overrideSaving}>
                                <Text style={styles.overrideButtonText}>Set Adds</Text>
                            </Pressable>
                        </View>
                    </View>

                    {/* ── Save ──────────────────────────────────────── */}
                    <Pressable
                        style={styles.saveButton}
                        onPress={save}
                        disabled={saving}
                    >
                        <Text style={styles.saveButtonText}>Save Settings</Text>
                    </Pressable>

                    <Text style={styles.sectionTitle}>COMMISSIONER ACTIONS</Text>
                    {lowerPriorityActions.map((action) => renderAction(action))}

                    {isCommissioner ? (
                        <>
                            <Text style={styles.sectionTitle}>DANGER ZONE</Text>
                            {renderAction({
                                id: 'delete-league',
                                label: 'Delete League',
                                color: colors.danger,
                                onPress: handleDeleteLeague,
                                description: 'Permanently removes the league, all rosters, history, and picks for every manager. This cannot be undone.',
                            })}
                        </>
                    ) : null}
                </ScrollView>
            </SafeAreaView>
        </>
    )
}
