import type { TradeVetoMode } from '@/types/app'
import type { LeagueSettingsUpdate, WaiverMode } from '@/lib/league'
import type { LeagueStatus } from '@/types/database'

export type CommissionerSettingsDraft = {
    scoring: Record<string, string>
    slots: Record<string, number>
    rosterSize: string
    irSlots: string
    taxiSlots: string
    auctionBudget: string
    playoffWeek: string
    weeklyAddLimit: string
    waiverMode: WaiverMode
    faabBudget: string
    tradeVetoMode: TradeVetoMode
    tradeVetoWindowHours: string
    tradeVetoThresholdPercent: string
}

export const EMPTY_COMMISSIONER_SETTINGS_DRAFT: CommissionerSettingsDraft = {
    scoring: {},
    slots: {},
    rosterSize: '',
    irSlots: '',
    taxiSlots: '',
    auctionBudget: '',
    playoffWeek: '',
    weeklyAddLimit: '',
    waiverMode: 'faab',
    faabBudget: '',
    tradeVetoMode: 'member_vote',
    tradeVetoWindowHours: '',
    tradeVetoThresholdPercent: '',
}

const DRAFT_SCALAR_FIELDS = [
    'rosterSize',
    'irSlots',
    'taxiSlots',
    'auctionBudget',
    'playoffWeek',
    'weeklyAddLimit',
    'waiverMode',
    'faabBudget',
    'tradeVetoMode',
    'tradeVetoWindowHours',
    'tradeVetoThresholdPercent',
] as const

function sameRecord<Value>(left: Record<string, Value>, right: Record<string, Value>): boolean {
    const leftKeys = Object.keys(left)
    return leftKeys.length === Object.keys(right).length &&
        leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

function sameCommissionerSettingsDraft(
    left: CommissionerSettingsDraft,
    right: CommissionerSettingsDraft,
): boolean {
    return DRAFT_SCALAR_FIELDS.every((field) => left[field] === right[field]) &&
        sameRecord(left.scoring, right.scoring) && sameRecord(left.slots, right.slots)
}

export function waiverModeFromValue(value: string | null | undefined): WaiverMode {
    return value === 'rolling' ? 'rolling' : 'faab'
}

export function tradeVetoModeFromValue(value: string | null | undefined): TradeVetoMode {
    if (value === 'disabled' || value === 'commissioner') return value
    return 'member_vote'
}

type CommissionerHydrationInput = {
    incomingLeagueId: string
    hydratedLeagueId: string | null
    draft: CommissionerSettingsDraft
    baseline: CommissionerSettingsDraft
    remote: CommissionerSettingsDraft
    force: boolean
}

export function commissionerHydrationDecision(input: CommissionerHydrationInput): 'hydrate' | 'preserve' | 'conflict' {
    if (input.force || input.hydratedLeagueId !== input.incomingLeagueId) return 'hydrate'
    const dirty = !sameCommissionerSettingsDraft(input.draft, input.baseline)
    const remoteChanged = !sameCommissionerSettingsDraft(input.remote, input.baseline)
    if (!remoteChanged) return dirty ? 'preserve' : 'hydrate'
    return dirty ? 'conflict' : 'hydrate'
}

type SettingsChange = {
    updates: LeagueSettingsUpdate
    slotsChanged: boolean
    slotUpdates: { slot_type: string; slot_count: number }[] | null
}

function parseStrictInteger(value: string): number | null {
    const normalized = value.trim()
    if (!/^-?\d+$/.test(normalized)) return null
    const parsed = Number(normalized)
    return Number.isSafeInteger(parsed) ? parsed : null
}

function parseStrictDecimal(value: string): number | null {
    const normalized = value.trim()
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return null
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
}

export function buildCommissionerSettingsChange(
    draft: CommissionerSettingsDraft,
    baseline: CommissionerSettingsDraft,
    status: LeagueStatus,
    scoringKeys: string[],
    slotTypes: readonly string[],
): SettingsChange | { error: string } {
    const integerFields = [
        ['rosterSize', 1, Infinity, 'Roster size must be at least 1.'],
        ['irSlots', 0, Infinity, 'IR slots must be 0 or more.'],
        ['taxiSlots', 0, Infinity, 'Taxi squad slots must be 0 or more.'],
        ['auctionBudget', 1, Infinity, 'Auction budget must be at least 1.'],
        ['playoffWeek', 18, 24, 'Playoff start week must be between 18 and 24.'],
        ['weeklyAddLimit', 0, Infinity, 'Weekly add limit must be 0 or more.'],
        ['faabBudget', 0, Infinity, 'FAAB starting budget must be 0 or more.'],
        ['tradeVetoWindowHours', draft.tradeVetoMode === 'disabled' ? 0 : 1, 168,
            `Veto window must be between ${draft.tradeVetoMode === 'disabled' ? 0 : 1} and 168 hours.`],
        ['tradeVetoThresholdPercent', 1, 100, 'Member veto threshold must be between 1% and 100%.'],
    ] as const
    type IntegerField = (typeof integerFields)[number][0]
    const parsed = new Map<IntegerField, number>()
    for (const [field, min, max, message] of integerFields) {
        const value = parseStrictInteger(draft[field])
        if (value == null || value < min || value > max) return { error: message }
        parsed.set(field, value)
    }
    const integerValue = (field: IntegerField) => {
        const value = parsed.get(field)
        if (value == null) throw new Error(`Missing validated commissioner setting: ${field}`)
        return value
    }

    const slotsChanged = slotTypes.some((type) => (draft.slots[type] ?? 0) !== (baseline.slots[type] ?? 0))
    if (slotsChanged && status !== 'setup') {
        return { error: 'Lineup slots can only be changed during league setup.' }
    }

    const updates: LeagueSettingsUpdate = {}
    if (scoringKeys.some((key) => draft.scoring[key] !== baseline.scoring[key])) {
        const scoringEntries: [string, number][] = []
        for (const key of scoringKeys) {
            const value = parseStrictDecimal(draft.scoring[key] ?? '')
            if (value == null) return { error: `Scoring value for ${key} must be a valid number.` }
            scoringEntries.push([key, value])
        }
        updates.scoring_settings = Object.fromEntries(scoringEntries)
    }
    if (draft.rosterSize !== baseline.rosterSize) updates.roster_size = integerValue('rosterSize')
    if (draft.irSlots !== baseline.irSlots) updates.ir_slots = integerValue('irSlots')
    if (draft.taxiSlots !== baseline.taxiSlots) updates.taxi_slots = integerValue('taxiSlots')
    if (draft.auctionBudget !== baseline.auctionBudget) updates.auction_budget = integerValue('auctionBudget')
    if (draft.playoffWeek !== baseline.playoffWeek) updates.playoff_start_week = integerValue('playoffWeek')
    if (draft.weeklyAddLimit !== baseline.weeklyAddLimit) {
        const weeklyAddLimit = integerValue('weeklyAddLimit')
        updates.weekly_add_unlimited = weeklyAddLimit === 0
        if (weeklyAddLimit > 0) updates.weekly_add_limit = weeklyAddLimit
    }
    if (draft.waiverMode !== baseline.waiverMode) updates.waiver_mode = draft.waiverMode
    if (draft.faabBudget !== baseline.faabBudget) updates.faab_starting_budget = integerValue('faabBudget')
    if (draft.tradeVetoMode !== baseline.tradeVetoMode) updates.trade_veto_mode = draft.tradeVetoMode
    if (draft.tradeVetoWindowHours !== baseline.tradeVetoWindowHours) {
        updates.trade_veto_window_hours = integerValue('tradeVetoWindowHours')
    }
    if (draft.tradeVetoThresholdPercent !== baseline.tradeVetoThresholdPercent) {
        updates.trade_veto_threshold_percent = integerValue('tradeVetoThresholdPercent')
    }
    return {
        updates,
        slotsChanged,
        slotUpdates: slotsChanged
            ? slotTypes.map((type) => ({ slot_type: type, slot_count: draft.slots[type] ?? 0 }))
            : null,
    }
}
