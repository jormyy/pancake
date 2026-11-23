import { useCallback, useEffect, useRef, useState } from 'react'
import { onLifecycle, readsAllowed } from '@/lib/lifecycle'
import { readAutoIrNotices } from '@/lib/lineup/ir-notice-read'
import type { IrNotice } from '@/lib/lineup/ir-notices'

export function useAutoIrNotices({ leagueId, seasonId, ownerKey, online }: {
    leagueId: string | null
    seasonId: string | null
    ownerKey: string | null
    online: boolean
}) {
    const key = ownerKey && seasonId ? `${ownerKey}:${seasonId}` : null
    const [state, setState] = useState<{ key: string | null; notices: IrNotice[] }>({ key: null, notices: [] })
    const requestRef = useRef(0)

    const refresh = useCallback(async () => {
        if (!leagueId || !seasonId || !key || !online || !readsAllowed()) return
        const requestId = ++requestRef.current
        try {
            const result = await readAutoIrNotices(leagueId, seasonId)
            if (requestRef.current !== requestId) return
            setState({ key, notices: result.enabled ? result.notices : [] })
        } catch {
            if (requestRef.current === requestId) setState({ key, notices: [] })
        }
    }, [leagueId, seasonId, key, online])

    useEffect(() => { void refresh() }, [refresh])

    useEffect(() => onLifecycle(['focus', 'visible', 'hidden'], () => { void refresh() }), [refresh])

    useEffect(() => () => { requestRef.current += 1 }, [])

    return { notices: state.key === key ? state.notices : [], refresh }
}
