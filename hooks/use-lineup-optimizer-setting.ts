import { useCallback, useEffect, useState } from 'react'
import { useScope } from '@/hooks/use-scope'
import { showAlert } from '@/lib/alert'
import { getLineupOptimizerEnabled, setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'
import { getErrorMessage } from '@/lib/shared/errors'

type Scope = { memberId: string; leagueId: string; seasonId: string }

/** The team's auto lineup switch: on until the stored setting says otherwise, and saved optimistically. */
export function useLineupOptimizerSetting(scope: Scope | null) {
    const key = scope ? `${scope.memberId}:${scope.leagueId}:${scope.seasonId}` : null
    const [enabled, setEnabled] = useState(true)
    const [saving, setSaving] = useState(false)
    const owner = useScope(key)

    useEffect(() => {
        setEnabled(true)
        setSaving(false)
        if (!scope) return
        const ticket = owner.latest()
        getLineupOptimizerEnabled(scope.memberId, scope.seasonId)
            .then(value => { ticket.commit(() => setEnabled(value)) })
            .catch(() => {})
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, owner])

    const setAutomatic = useCallback(async (next: boolean) => {
        if (!scope) return
        // A newer toggle supersedes this one, so only the last save settles the switch.
        const ticket = owner.latest()
        setEnabled(next)
        setSaving(true)
        try {
            await setLineupOptimizerEnabled(scope.memberId, scope.leagueId, scope.seasonId, next)
            ticket.commit(() => setSaving(false))
        } catch (e) {
            ticket.commit(() => {
                setEnabled(!next)
                setSaving(false)
                showAlert('Auto-set failed', getErrorMessage(e))
            })
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, owner])

    return { enabled, saving, setAutomatic }
}
