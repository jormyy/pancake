import { useCallback, useEffect, useRef, useState } from 'react'
import { browserReadsAllowed } from '@/hooks/use-browser-read-activity'
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
        if (!leagueId || !seasonId || !key || !online || !browserReadsAllowed()) return
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

    useEffect(() => {
        const onFocus = () => { void refresh() }
        window.addEventListener('focus', onFocus)
        window.addEventListener('pageshow', onFocus)
        document.addEventListener('visibilitychange', onFocus)
        return () => {
            window.removeEventListener('focus', onFocus)
            window.removeEventListener('pageshow', onFocus)
            document.removeEventListener('visibilitychange', onFocus)
        }
    }, [refresh])

    useEffect(() => () => { requestRef.current += 1 }, [])

    return { notices: state.key === key ? state.notices : [], refresh }
}
