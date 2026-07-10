import { useEffect, useRef, useState } from 'react'
import { LINEUP_SLOT_TYPES } from '@pancake/core'
import type { LeagueInfo } from '@/types/app'
import { getLeagueMembers, getLineupSlots, updateLeagueConfiguration } from '@/lib/league'
import { getErrorMessage, showAlert } from '@/lib/alert'
import { COMMISSIONER_SCORING_FIELDS } from '@/lib/commissioner-settings-fields'
import {
    EMPTY_COMMISSIONER_SETTINGS_DRAFT,
    buildCommissionerSettingsChange,
    commissionerHydrationDecision,
    tradeVetoModeFromValue,
    waiverModeFromValue,
    type CommissionerSettingsDraft,
} from '@/lib/commissioner-settings-draft'

type MemberOption = { id: string; team_name: string | null }

function remoteDraft(
    league: LeagueInfo,
    slotData: Awaited<ReturnType<typeof getLineupSlots>>,
): CommissionerSettingsDraft {
    const slots = Object.fromEntries(slotData.map((slot) => [slot.slot_type, slot.slot_count]))
    const source = league.scoring_settings && typeof league.scoring_settings === 'object' &&
        !Array.isArray(league.scoring_settings) ? league.scoring_settings : {}
    return {
        rosterSize: String(league.roster_size ?? 20),
        irSlots: String(league.ir_slots ?? 2),
        taxiSlots: String(league.taxi_slots ?? 0),
        auctionBudget: String(league.auction_budget ?? 200),
        playoffWeek: String(league.playoff_start_week ?? 20),
        weeklyAddLimit: String(league.weekly_add_limit ?? 0),
        waiverMode: waiverModeFromValue(league.waiver_mode),
        faabBudget: String(league.faab_starting_budget ?? 100),
        tradeVetoMode: tradeVetoModeFromValue(league.trade_veto_mode),
        tradeVetoWindowHours: String(league.trade_veto_window_hours ?? 24),
        tradeVetoThresholdPercent: String(league.trade_veto_threshold_percent ?? 50),
        scoring: Object.fromEntries(COMMISSIONER_SCORING_FIELDS.map(({ key }) => [
            key,
            source[key] != null ? String(source[key]) : '0',
        ])),
        slots,
    }
}

export function useCommissionerSettingsResource({
    league,
    ownerId,
    isCommissioner,
    refresh,
    onSaved,
}: {
    league: LeagueInfo | null
    ownerId: string | null
    isCommissioner: boolean
    refresh: () => Promise<void>
    onSaved: () => void
}) {
    const [draft, setDraft] = useState<CommissionerSettingsDraft>(EMPTY_COMMISSIONER_SETTINGS_DRAFT)
    const [baseline, setBaseline] = useState<CommissionerSettingsDraft>(EMPTY_COMMISSIONER_SETTINGS_DRAFT)
    const draftRef = useRef(draft)
    const baselineRef = useRef(baseline)
    const hydratedOwnerKey = useRef<string | null>(null)
    const forceHydrate = useRef(false)
    draftRef.current = draft
    baselineRef.current = baseline
    const [members, setMembers] = useState<MemberOption[]>([])
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'unauthorized'>('loading')
    const [loadError, setLoadError] = useState<string | null>(null)
    const [loadAttempt, setLoadAttempt] = useState(0)
    const ownerKey = league && ownerId && isCommissioner ? `${ownerId}:${league.id}` : null
    const activeOwnerKey = useRef(ownerKey)
    const mutation = useRef<{ ownerKey: string; token: symbol } | null>(null)
    const [savingOwnerKey, setSavingOwnerKey] = useState<string | null>(null)
    activeOwnerKey.current = ownerKey
    const ownsDraft = hydratedOwnerKey.current === ownerKey

    useEffect(() => {
        let cancelled = false
        if (!isCommissioner) {
            setLoadState('unauthorized')
            setLoadError(null)
            return
        }
        if (!league) {
            setLoadState('loading')
            return
        }
        setLoadState('loading')
        setLoadError(null)
        Promise.all([getLineupSlots(league.id), getLeagueMembers(league.id)])
            .then(([slotData, memberData]) => {
                if (cancelled) return
                const nextDraft = remoteDraft(league, slotData)
                const hydration = commissionerHydrationDecision({
                    incomingLeagueId: ownerKey ?? league.id,
                    hydratedLeagueId: hydratedOwnerKey.current,
                    draft: draftRef.current,
                    baseline: baselineRef.current,
                    remote: nextDraft,
                    force: forceHydrate.current,
                })
                forceHydrate.current = false
                setMembers(memberData)
                if (hydration === 'conflict') {
                    setLoadError('League settings changed while you were editing. Reload before making more changes.')
                    setLoadState('error')
                    return
                }
                if (hydration === 'hydrate') {
                    hydratedOwnerKey.current = ownerKey
                    setDraft(nextDraft)
                    setBaseline(nextDraft)
                }
                setLoadState('ready')
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    setLoadError(getErrorMessage(error) ?? 'Could not load league settings.')
                    setLoadState('error')
                }
            })
        return () => { cancelled = true }
    }, [isCommissioner, league, loadAttempt, ownerKey])

    const updateField = <Key extends keyof CommissionerSettingsDraft>(
        key: Key,
        value: CommissionerSettingsDraft[Key],
    ) => setDraft((current) => ({ ...current, [key]: value }))

    const updateScoring = (key: string, value: string) => {
        setDraft((current) => ({ ...current, scoring: { ...current.scoring, [key]: value } }))
    }

    const adjustSlot = (type: string, delta: number) => {
        setDraft((current) => ({
            ...current,
            slots: { ...current.slots, [type]: Math.max(0, (current.slots[type] ?? 0) + delta) },
        }))
    }

    const save = async () => {
        if (!league || !ownerKey || mutation.current?.ownerKey === ownerKey) return
        const mutationOwnerKey = ownerKey
        const mutationToken = Symbol('commissioner-settings-save')
        const submittedDraft = draft
        mutation.current = { ownerKey: mutationOwnerKey, token: mutationToken }
        const change = buildCommissionerSettingsChange(
            submittedDraft,
            baseline,
            league.status,
            COMMISSIONER_SCORING_FIELDS.map(({ key }) => key),
            LINEUP_SLOT_TYPES,
        )
        if ('error' in change) {
            mutation.current = null
            showAlert('Invalid', change.error)
            return
        }
        setSavingOwnerKey(mutationOwnerKey)
        try {
            if (Object.keys(change.updates).length > 0 || change.slotsChanged) {
                await updateLeagueConfiguration(league.id, change.updates, change.slotUpdates)
            }
            if (activeOwnerKey.current !== mutationOwnerKey) return
            setBaseline(submittedDraft)
            await refresh()
            if (activeOwnerKey.current !== mutationOwnerKey) return
            onSaved()
        } catch (error) {
            if (activeOwnerKey.current === mutationOwnerKey) showAlert('Error', getErrorMessage(error))
        } finally {
            if (mutation.current?.token === mutationToken) {
                mutation.current = null
                if (activeOwnerKey.current === mutationOwnerKey) setSavingOwnerKey(null)
            }
        }
    }

    return {
        adjustSlot,
        draft: ownsDraft ? draft : EMPTY_COMMISSIONER_SETTINGS_DRAFT,
        loadError,
        loadState: ownerKey && !ownsDraft ? 'loading' : loadState,
        members: ownsDraft ? members : [],
        retryLoad: () => {
            forceHydrate.current = true
            setLoadAttempt((attempt) => attempt + 1)
        },
        save,
        saving: savingOwnerKey === ownerKey,
        updateField,
        updateScoring,
    }
}
