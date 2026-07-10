import { useEffect, useState } from 'react'
import { adjustFaabBalance, overrideWeeklyAddCount } from '@/lib/league'
import { getErrorMessage, showAlert, showSuccess } from '@/lib/alert'

export function useCommissionerOverrides(
    leagueId: string | undefined,
    members: { id: string }[],
) {
    const [memberId, setMemberId] = useState<string | null>(null)
    const [faab, setFaab] = useState('')
    const [adds, setAdds] = useState('')
    const [saving, setSaving] = useState(false)

    useEffect(() => {
        if (!members.some((member) => member.id === memberId)) setMemberId(members[0]?.id ?? null)
    }, [memberId, members])

    const saveValue = async (
        value: string,
        label: string,
        update: (numericValue: number) => Promise<unknown>,
        clear: () => void,
    ) => {
        const normalized = value.trim()
        const numericValue = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
        if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
            showAlert('Invalid', `${label} must be 0 or more.`)
            return
        }
        setSaving(true)
        try {
            await update(numericValue)
            clear()
            showSuccess('Done', `${label} updated.`)
        } catch (error) {
            showAlert('Error', getErrorMessage(error))
        } finally {
            setSaving(false)
        }
    }

    return {
        overrideAdds: adds,
        overrideFaab: faab,
        overrideMemberId: memberId,
        overrideSaving: saving,
        setOverrideAdds: setAdds,
        setOverrideFaab: setFaab,
        setOverrideMemberId: setMemberId,
        handleFaabOverride: () => {
            if (!leagueId || !memberId) return Promise.resolve()
            return saveValue(faab, 'FAAB balance', (balance) => adjustFaabBalance(leagueId, memberId, balance), () => setFaab(''))
        },
        handleAddCountOverride: () => {
            if (!leagueId || !memberId) return Promise.resolve()
            return saveValue(adds, 'Weekly add count', (count) => overrideWeeklyAddCount(leagueId, memberId, count), () => setAdds(''))
        },
    }
}
