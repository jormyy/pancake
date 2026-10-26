import { useEffect } from 'react'
import { useIsFocused } from '@react-navigation/native'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'

export function useUnsentFormUpdate(hasChanges: boolean, reason: string) {
    const focused = useIsFocused()
    useEffect(() => focused && hasChanges ? holdPwaUpdate(reason) : undefined, [focused, hasChanges, reason])
}
