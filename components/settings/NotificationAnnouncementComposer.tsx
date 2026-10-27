import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useLeagueContext } from '@/contexts/league-context'
import { sessionGeneration } from '@/lib/session-cache-registry'
import { useAuth } from '@/hooks/use-auth'
import { publishLeagueAnnouncement } from '@/lib/notification-preferences'
import { holdPwaUpdate } from '@/lib/pwa-update-guard'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'

export function NotificationAnnouncementComposer() {
    const { current, currentLeague, membershipValidated, isCommissioner } = useLeagueContext()
    const { user } = useAuth()
    const key = membershipValidated && isCommissioner && user && current && currentLeague ? `${user.id}:${sessionGeneration()}:${current.id}:${currentLeague.id}` : null
    const latest = useRef(key)
    latest.current = key
    const [state, setState] = useState({ key, body: '', requestId: crypto.randomUUID(), busy: false, status: '' })
    const owned = state.key === key
    const body = owned ? state.body : ''
    const busy = owned && state.busy
    const hasInput = body.length > 0
    useEffect(() => key && hasInput ? holdPwaUpdate('announcement editor') : undefined, [key, hasInput])
    if (!key || !currentLeague) return null
    function change(text: string) {
        setState({ key, body: text, requestId: crypto.randomUUID(), busy: false, status: '' })
    }
    async function publish() {
        if (!body.trim() || busy || !currentLeague) return
        const requestId = state.requestId
        setState(value => ({ ...value, busy: true, status: '' }))
        try {
            await publishLeagueAnnouncement(currentLeague.id, body, requestId)
            if (latest.current === key) setState({ key, body: '', requestId: crypto.randomUUID(), busy: false, status: 'Published' })
        } catch {
            if (latest.current === key) setState(value => ({ ...value, busy: false, status: 'Publish failed. Retry.' }))
        }
    }
    return <View style={styles.group}>
        <View style={styles.row}>
            <TextInput aria-label="League announcement" accessibilityLabel="League announcement" placeholder="League announcement" placeholderTextColor={colors.textMuted}
                value={body} onChangeText={change} editable={!busy} maxLength={500} style={styles.input} />
            <Pressable role="button" aria-label="Publish announcement" disabled={busy || !body.trim()} onPress={() => void publish()}
                accessibilityState={{ disabled: busy || !body.trim(), busy }} style={[styles.action, (busy || !body.trim()) && styles.disabled]}>
                <Text style={styles.actionText}>{busy ? 'Sending…' : 'Publish'}</Text>
            </Pressable>
        </View>
        {owned && state.status ? <Text role="status" style={textStyles.meta}>{state.status}</Text> : null}
        {owned && state.status === 'Published' ? <Text style={textStyles.meta}>Members see this in the app. Only members who turned on Commissioner messages also get a push.</Text> : null}
    </View>
}

const styles = StyleSheet.create({
    group: { gap: spacing.xs, marginBottom: spacing.md },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    input: { flex: 1, minWidth: 0, minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: spacing.sm, color: colors.textPrimary, fontSize: 16 },
    action: { minHeight: 44, paddingHorizontal: spacing.md, justifyContent: 'center', borderRadius: radii.md, backgroundColor: colors.primary },
    actionText: { color: colors.textWhite, fontWeight: '600' },
    disabled: { opacity: 0.5 },
})
