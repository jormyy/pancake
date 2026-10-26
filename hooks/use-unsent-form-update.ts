import { useEffect } from 'react'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'

export function useUnsentFormUpdate(hasChanges: boolean, reason: string) {
    useEffect(() => hasChanges ? holdPwaUpdate(reason) : undefined, [hasChanges, reason])
}
