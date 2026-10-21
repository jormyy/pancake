import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useLeagueContext } from '@/contexts/league-context'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { useAuth } from '@/hooks/use-auth'
import { supabase } from '@/lib/supabase'
import { setPlayerWatch } from '@/lib/notification-preferences'
import { colors, spacing, textStyles } from '@/constants/tokens'
import { SettingsToggle } from './SettingsGroup'

export function NotificationPlayerWatch({ playerId }: { playerId: string }) {
    const { current, currentLeague, membershipValidated } = useLeagueContext()
    const { user } = useAuth()
    const key = membershipValidated && user && current && currentLeague ? `${user.id}:${sessionGeneration()}:${current.id}:${currentLeague.id}:${playerId}` : null
    const latest = useRef(key)
    latest.current = key
    const [revision, reload] = useState(0)
    const [state, setState] = useState<{ key: string | null; enabled: boolean; busy: boolean; error: boolean }>({ key: null, enabled: false, busy: true, error: false })
    useEffect(() => {
        if (!key || !current || !currentLeague) return
        let active = true
        setState({ key, enabled: false, busy: true, error: false })
        void supabase.from('player_watches').select('player_id').eq('league_id', currentLeague.id).eq('member_id', current.id).eq('player_id', playerId).maybeSingle().then(({ data, error }) => {
            if (active && latest.current === key) setState({ key, enabled: !!data, busy: false, error: !!error })
        })
        return () => { active = false }
    }, [key, current, currentLeague, playerId, revision])
    if (!key || !currentLeague) return null
    const ready = state.key === key && !state.busy && !state.error
    const enabled = state.key === key && state.enabled
    async function toggle() {
        if (!ready || !currentLeague) return
        setState({ key, enabled, busy: true, error: false })
        try {
            await setPlayerWatch(currentLeague.id, playerId, !enabled)
            if (latest.current === key) setState({ key, enabled: !enabled, busy: false, error: false })
        } catch {
            if (latest.current === key) setState({ key, enabled, busy: false, error: true })
        }
    }
    return <View style={styles.row}>
        <Text style={textStyles.rowTitle}>Watch for drops</Text>
        <Pressable role={state.error ? 'button' : 'switch'} aria-label={state.error ? 'Retry player watch' : 'Watch player for drops'} aria-checked={enabled} disabled={state.key !== key || state.busy} onPress={() => state.error ? reload(value => value + 1) : void toggle()}
            accessibilityState={{ checked: enabled, disabled: state.key !== key || state.busy }} style={styles.action}>
            {state.error ? <Text style={styles.error}>Retry</Text> : <SettingsToggle on={enabled} />}
        </Pressable>
    </View>
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: spacing.sm },
    action: { minWidth: 48, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    error: { color: colors.danger },
})
