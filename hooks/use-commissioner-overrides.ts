import { useEffect, useRef, useState } from 'react'
import { adjustFaabBalance, overrideWeeklyAddCount } from '@/lib/league'
import { showAlert, showSuccess } from '@/lib/alert'
import { getErrorMessage } from '@/lib/shared/errors'

export function useCommissionerOverrides(
    ownerId: string | null,
    leagueId: string | undefined,
    members: { id: string }[],
) {
    const ownerKey = ownerId && leagueId ? `${ownerId}:${leagueId}` : null
    const activeOwnerKeyRef = useRef(ownerKey)
    activeOwnerKeyRef.current = ownerKey
    const membersRef = useRef(members)
    membersRef.current = members
    const mutationSequenceRef = useRef(0)
    const activeMutationRef = useRef<{ ownerKey: string; token: number } | null>(null)
    const [fieldsOwnerKey, setFieldsOwnerKey] = useState(ownerKey)
    const [memberId, setMemberId] = useState<string | null>(null)
    const [faab, setFaab] = useState('')
    const [adds, setAdds] = useState('')
    const [saving, setSaving] = useState<{ ownerKey: string; token: number } | null>(null)

    useEffect(() => {
        setFieldsOwnerKey(ownerKey)
        setMemberId(membersRef.current[0]?.id ?? null)
        setFaab('')
        setAdds('')
    }, [ownerKey])

    useEffect(() => {
        if (!members.some((member) => member.id === memberId)) setMemberId(members[0]?.id ?? null)
    }, [memberId, members])

    const saveValue = async (
        value: string,
        label: string,
        update: (numericValue: number) => Promise<unknown>,
        clear: () => void,
    ) => {
        if (!ownerKey || activeOwnerKeyRef.current !== ownerKey) return
        const normalized = value.trim()
        const numericValue = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
        if (!Number.isSafeInteger(numericValue) || numericValue < 0) {
            showAlert('Invalid', `${label} must be 0 or more.`)
            return
        }
        if (activeMutationRef.current?.ownerKey === ownerKey) return
        const mutation = { ownerKey, token: ++mutationSequenceRef.current }
        activeMutationRef.current = mutation
        setSaving(mutation)
        try {
            await update(numericValue)
            if (activeOwnerKeyRef.current === ownerKey && activeMutationRef.current?.token === mutation.token) {
                clear()
                showSuccess('Done', `${label} updated.`)
            }
        } catch (error) {
            if (activeOwnerKeyRef.current === ownerKey && activeMutationRef.current?.token === mutation.token) {
                showAlert('Error', getErrorMessage(error))
            }
        } finally {
            if (activeMutationRef.current?.token === mutation.token) {
                activeMutationRef.current = null
                setSaving((current) => current?.token === mutation.token ? null : current)
            }
        }
    }

    const ownsFields = fieldsOwnerKey === ownerKey

    return {
        overrideAdds: ownsFields ? adds : '',
        overrideFaab: ownsFields ? faab : '',
        overrideMemberId: ownsFields ? memberId : null,
        overrideSaving: saving?.ownerKey === ownerKey,
        setOverrideAdds: setAdds,
        setOverrideFaab: setFaab,
        setOverrideMemberId: setMemberId,
        handleFaabOverride: () => {
            if (!ownerKey || !leagueId || !memberId || !ownsFields) return Promise.resolve()
            return saveValue(faab, 'FAAB balance', (balance) => adjustFaabBalance(leagueId, memberId, balance), () => setFaab(''))
        },
        handleAddCountOverride: () => {
            if (!ownerKey || !leagueId || !memberId || !ownsFields) return Promise.resolve()
            return saveValue(adds, 'Weekly add count', (count) => overrideWeeklyAddCount(leagueId, memberId, count), () => setAdds(''))
        },
    }
}
