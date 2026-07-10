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
    const dirty = JSON.stringify(input.draft) !== JSON.stringify(input.baseline)
    const remoteChanged = JSON.stringify(input.remote) !== JSON.stringify(input.baseline)
    if (!remoteChanged) return dirty ? 'preserve' : 'hydrate'
    return dirty ? 'conflict' : 'hydrate'
}

type SettingsChange = {
    updates: LeagueSettingsUpdate
    slotsChanged: boolean
    slotUpdates: { slot_type: string; slot_count: number }[] | null
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
    const parsed = {} as Record<(typeof integerFields)[number][0], number>
    for (const [field, min, max, message] of integerFields) {
        const value = Number.parseInt(draft[field], 10)
        if (!Number.isFinite(value) || value < min || value > max) return { error: message }
        parsed[field] = value
    }

    const slotsChanged = slotTypes.some((type) => (draft.slots[type] ?? 0) !== (baseline.slots[type] ?? 0))
    if (slotsChanged && status !== 'setup') {
        return { error: 'Lineup slots can only be changed during league setup.' }
    }

    const updates: LeagueSettingsUpdate = {}
    if (scoringKeys.some((key) => draft.scoring[key] !== baseline.scoring[key])) {
        updates.scoring_settings = Object.fromEntries(scoringKeys.map((key) => {
            const value = Number.parseFloat(draft.scoring[key] ?? '0')
            return [key, Number.isFinite(value) ? value : 0]
        }))
    }
    if (draft.rosterSize !== baseline.rosterSize) updates.roster_size = parsed.rosterSize
    if (draft.irSlots !== baseline.irSlots) updates.ir_slots = parsed.irSlots
    if (draft.taxiSlots !== baseline.taxiSlots) updates.taxi_slots = parsed.taxiSlots
    if (draft.auctionBudget !== baseline.auctionBudget) updates.auction_budget = parsed.auctionBudget
    if (draft.playoffWeek !== baseline.playoffWeek) updates.playoff_start_week = parsed.playoffWeek
    if (draft.weeklyAddLimit !== baseline.weeklyAddLimit) {
        updates.weekly_add_unlimited = parsed.weeklyAddLimit === 0
        if (parsed.weeklyAddLimit > 0) updates.weekly_add_limit = parsed.weeklyAddLimit
    }
    if (draft.waiverMode !== baseline.waiverMode) updates.waiver_mode = draft.waiverMode
    if (draft.faabBudget !== baseline.faabBudget) updates.faab_starting_budget = parsed.faabBudget
    if (draft.tradeVetoMode !== baseline.tradeVetoMode) updates.trade_veto_mode = draft.tradeVetoMode
    if (draft.tradeVetoWindowHours !== baseline.tradeVetoWindowHours) {
        updates.trade_veto_window_hours = parsed.tradeVetoWindowHours
    }
    if (draft.tradeVetoThresholdPercent !== baseline.tradeVetoThresholdPercent) {
        updates.trade_veto_threshold_percent = parsed.tradeVetoThresholdPercent
    }
    return {
        updates,
        slotsChanged,
        slotUpdates: slotsChanged
            ? slotTypes.map((type) => ({ slot_type: type, slot_count: draft.slots[type] ?? 0 }))
            : null,
    }
}
