import { useCallback, useEffect, useRef, useState } from 'react'
import { showAlert } from '@/lib/alert'
import { getLineupOptimizerEnabled, setLineupOptimizerEnabled } from '@/lib/lineup/optimizerSettings'
import { getErrorMessage } from '@/lib/shared/errors'

type Scope = { memberId: string; leagueId: string; seasonId: string }

/** The team's auto lineup switch: on until the stored setting says otherwise, and saved optimistically. */
export function useLineupOptimizerSetting(scope: Scope | null) {
    const key = scope ? `${scope.memberId}:${scope.leagueId}:${scope.seasonId}` : null
    const [enabled, setEnabled] = useState(true)
    const [saving, setSaving] = useState(false)
    const keyRef = useRef(key)
    keyRef.current = key

    useEffect(() => {
        setEnabled(true)
        setSaving(false)
        if (!scope) return
        let cancelled = false
        getLineupOptimizerEnabled(scope.memberId, scope.seasonId)
            .then(value => { if (!cancelled) setEnabled(value) })
            .catch(() => {})
        return () => { cancelled = true }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    const setAutomatic = useCallback(async (next: boolean) => {
        if (!scope) return
        const requestKey = key
        setEnabled(next)
        setSaving(true)
        try {
            await setLineupOptimizerEnabled(scope.memberId, scope.leagueId, scope.seasonId, next)
        } catch (e) {
            if (keyRef.current !== requestKey) return
            setEnabled(!next)
            showAlert('Auto-set failed', getErrorMessage(e))
        } finally {
            if (keyRef.current === requestKey) setSaving(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key])

    return { enabled, saving, setAutomatic }
}
