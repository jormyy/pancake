import { useDraftActivity as useModalActivity } from '@/components/league/draft-room/useDraftActivity'
import { useEffect, useRef, useState } from 'react'
import { LINEUP_SLOT_TYPES } from '@pancake/core'
import type { LeagueInfo } from '@/types/app'
import { fetchUserLeagues, getLeagueMembers, getLeaguePlayoffCalendar, getLineupSlots, updateLeagueConfiguration } from '@/lib/league'
import { apiPost } from '@/lib/shared/api'
import { showAlert } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'
import { COMMISSIONER_SCORING_FIELDS } from '@/lib/commissioner-settings-fields'
import {
    EMPTY_COMMISSIONER_SETTINGS_DRAFT,
    playoffFit,
    buildCommissionerSettingsChange,
    commissionerHydrationDecision,
    tradeDeadlineDraftValue,
    tradeVetoModeFromValue,
    waiverModeFromValue,
    type CommissionerSettingsDraft,
} from '@/lib/commissioner-settings-draft'

type MemberOption = { id: string; team_name: string | null }

function remoteDraft(
    league: LeagueInfo,
    slotData: Awaited<ReturnType<typeof getLineupSlots>>,
    memberCount: number,
): CommissionerSettingsDraft {
    const slots = Object.fromEntries(slotData.map((slot) => [slot.slot_type, slot.slot_count]))
    const source = league.scoring_settings && typeof league.scoring_settings === 'object' &&
        !Array.isArray(league.scoring_settings) ? league.scoring_settings : {}
    const rounds = league.playoff_round_lengths ?? league.playoff_round_weeks ?? Array.from({ length: memberCount >= 10 ? 3 : 2 }, () => 1)
    const roundCount = league.playoff_entrants ? Math.ceil(Math.log2(league.playoff_entrants)) : memberCount >= 10 ? 3 : 2
    const roundInputs = rounds.map(String)
    if (roundInputs.length < roundCount) roundInputs.unshift('')
    if (roundInputs.length > roundCount) roundInputs.shift()
    return {
        teamLimit: String(league.team_limit ?? 10),
        taxiRule: league.taxi_rule ?? 'drafted_rookies',
        taxiMaxSeasons: league.taxi_max_seasons == null ? '' : String(league.taxi_max_seasons),
        allowInactiveTrades: league.allow_inactive_trades ?? false,
        playoffEntrants: String(league.playoff_entrants ?? (memberCount >= 10 ? 6 : 4)),
        playoffRoundCount: String(roundCount),
        skippedWeeks: [],
        rosterSize: String(league.roster_size ?? 20),
        irSlots: String(league.ir_slots ?? 2),
        taxiSlots: String(league.taxi_slots ?? 0),
        auctionBudget: String(league.auction_budget ?? 200),
        playoffWeek: String(league.playoff_start_week ?? 20),
        playoffRoundWeeks: roundInputs,
        weeklyAddLimit: String(league.weekly_add_limit ?? 0),
        waiverMode: waiverModeFromValue(league.waiver_mode),
        faabBudget: String(league.faab_starting_budget ?? 100),
        tradeVetoMode: tradeVetoModeFromValue(league.trade_veto_mode),
        tradeVetoWindowHours: String(league.trade_veto_window_hours ?? 24),
        tradeVetoThresholdPercent: String(league.trade_veto_threshold_percent ?? 50),
        tradeDeadline: tradeDeadlineDraftValue(league.trade_deadline),
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
    const [playoffCalendar, setPlayoffCalendar] = useState<Awaited<ReturnType<typeof getLeaguePlayoffCalendar>>>(null)
    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'unauthorized'>('loading')
    const [loadOwnerKey, setLoadOwnerKey] = useState<string | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [loadAttempt, setLoadAttempt] = useState(0)
    const ownerKey = league && ownerId && isCommissioner ? `${ownerId}:${league.id}` : null
    const leagueId = league?.id
    const { canRead, capture, isCurrent, canAct, markReady, blockActions, epoch, ready } = useModalActivity(ownerKey)
    const activeOwnerKey = useRef(ownerKey)
    const mutation = useRef<{ ownerKey: string; token: symbol } | null>(null)
    const [savingOwnerKey, setSavingOwnerKey] = useState<string | null>(null)
    activeOwnerKey.current = ownerKey
    const ownsDraft = hydratedOwnerKey.current === ownerKey

    useEffect(() => {
        activeOwnerKey.current = ownerKey
        setSavingOwnerKey(null)
        return () => {
            activeOwnerKey.current = null
            mutation.current = null
        }
    }, [ownerKey])

    useEffect(() => {
        let cancelled = false
        setLoadOwnerKey(ownerKey)
        if (!isCommissioner) {
            setLoadState('unauthorized')
            setLoadError(null)
            return
        }
        if (!leagueId || !ownerId) {
            setLoadState('loading')
            return
        }
        if (!canRead()) return
        const generation = capture()
        blockActions()
        setLoadState(hydratedOwnerKey.current === ownerKey ? 'ready' : 'loading')
        setLoadError(null)
        Promise.all([getLineupSlots(leagueId), getLeagueMembers(leagueId), getLeaguePlayoffCalendar(leagueId), fetchUserLeagues(ownerId)])
            .then(([slotData, memberData, calendar, memberships]) => {
                if (cancelled || !isCurrent(generation)) return
                const membership = memberships.find(row => row.leagues.id === leagueId && (row.role === 'commissioner' || row.role === 'co_commissioner'))
                if (!membership) { setLoadState('unauthorized'); return }
                const league = membership.leagues
                const nextDraft = { ...remoteDraft(league, slotData, memberData.length), skippedWeeks: calendar?.skippedWeeks ?? [] }
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
                setPlayoffCalendar(calendar)
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
                markReady(generation)
                setLoadState('ready')
            })
            .catch((error: unknown) => {
                if (!cancelled && isCurrent(generation)) {
                    setLoadError(getErrorMessage(error) ?? 'Could not load league settings.')
                    setLoadState('error')
                }
            })
        return () => { cancelled = true }
    }, [isCommissioner, leagueId, ownerId, loadAttempt, ownerKey, canRead, capture, isCurrent, markReady, blockActions, epoch])

    const playoffFitPreview = playoffFit(playoffCalendar?.weeks ?? [], Number(draft.playoffWeek), draft.playoffRoundWeeks.map(Number))
    const playoffFitMessage = playoffFitPreview.status === 'fit' ? `Playoffs end in week ${playoffFitPreview.endWeek} of ${playoffFitPreview.lastAvailableWeek}.`
        : playoffFitPreview.status === 'calendar-unpublished' ? 'Calendar not published. Playoff changes cannot be saved.'
        : playoffFitPreview.status === 'invalid-settings' ? 'Enter positive whole weeks for each playoff round.'
        : `Playoffs need ${playoffFitPreview.requiredWeeks} weeks from week ${draft.playoffWeek}. Last available: week ${playoffFitPreview.lastAvailableWeek}. Choose an earlier start or shorter rounds.`

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

    const revalidateAuthority = async () => {
        if (!ownerId || !leagueId || !canAct()) return false
        const generation = capture()
        try {
            const memberships = await fetchUserLeagues(ownerId)
            if (!isCurrent(generation)) return false
            if (memberships.some(row => row.leagues.id === leagueId && (row.role === 'commissioner' || row.role === 'co_commissioner'))) return true
            blockActions()
            setLoadState('unauthorized')
        } catch (error) {
            if (isCurrent(generation)) {
                blockActions()
                setLoadState('error')
                setLoadError(getErrorMessage(error) ?? 'Could not verify commissioner access.')
            }
        }
        return false
    }

    const save = async () => {
        if (!canAct() || loadState !== 'ready' || !league || !ownerKey || activeOwnerKey.current !== ownerKey || mutation.current?.ownerKey === ownerKey) return
        const mutationOwnerKey = ownerKey
        const mutationToken = Symbol('commissioner-settings-save')
        const submittedDraft = draft
        mutation.current = { ownerKey: mutationOwnerKey, token: mutationToken }
        const ownsMutation = () => activeOwnerKey.current === mutationOwnerKey && mutation.current?.token === mutationToken
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
            if (!await revalidateAuthority() || !ownsMutation()) return
            if (Object.keys(change.updates).some(key => key.startsWith('playoff_'))) {
                if (playoffFitPreview.status !== 'fit') throw new Error(playoffFitMessage)
                const fit = await apiPost<ReturnType<typeof playoffFit>>('/league/playoff-fit', {
                    leagueId: league.id, start: Number(submittedDraft.playoffWeek), rounds: submittedDraft.playoffRoundWeeks.map(Number),
                })
                if (fit.status !== 'fit') throw new Error('Playoffs no longer fit the published calendar. Reload settings.')
                if (!ownsMutation()) return
            }
            if (Object.keys(change.updates).length > 0 || change.slotsChanged) {
                await updateLeagueConfiguration(league.id, change.updates, change.slotUpdates)
            }
            if (!ownsMutation()) return
            setBaseline(submittedDraft)
            await refresh()
            if (!ownsMutation()) return
            onSaved()
        } catch (error) {
            if (ownsMutation()) showAlert('Error', getErrorMessage(error))
        } finally {
            if (mutation.current?.token === mutationToken) {
                mutation.current = null
                if (activeOwnerKey.current === mutationOwnerKey) setSavingOwnerKey(null)
            }
        }
    }

    return {
        adjustSlot,
        hasDraft: Boolean(ownerKey && ownsDraft),
        authorityReady: ready && loadState === 'ready',
        revalidateAuthority,
        draft: ownsDraft ? draft : EMPTY_COMMISSIONER_SETTINGS_DRAFT,
        loadError: loadOwnerKey === ownerKey ? loadError : null,
        loadState: ownerKey && loadOwnerKey !== ownerKey ? 'loading' : loadState,
        members: ownsDraft ? members : [],
        playoffFitMessage,
        playoffFitStatus: playoffFitPreview.status,
        playoffCalendar: ownsDraft ? playoffCalendar : null,
        playoffRoundsNeedReview: ownsDraft && league?.playoff_round_weeks != null &&
            league.playoff_round_weeks.length !== (members.length >= 10 ? 3 : 2) && league.playoff_entrants == null,
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
