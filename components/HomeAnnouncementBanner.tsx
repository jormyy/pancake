import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'
import type { LeagueAnnouncement } from '@/lib/league-announcements'

function readDismissed(key: string): string[] {
    try {
        const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]')
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
    } catch {
        return []
    }
}

export function HomeAnnouncementBanner({ announcements, ownerId, leagueId, padX }: {
    announcements: LeagueAnnouncement[]
    ownerId: string
    leagueId: string
    padX: number
}) {
    const key = `pancake-announcements-dismissed:${ownerId}:${leagueId}`
    const saved = useMemo(() => readDismissed(key), [key])
    const [dismissed, setDismissed] = useState({ key, ids: saved })
    const ids = dismissed.key === key ? dismissed.ids : saved
    const announcement = [...announcements].sort((left, right) => right.published_at.localeCompare(left.published_at) || right.id.localeCompare(left.id)).find(row => !ids.includes(row.id))
    if (!announcement) return null
    const date = new Date(announcement.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
    const dismiss = () => {
        const next = [...new Set([...ids, announcement.id])].slice(-50)
        setDismissed({ key, ids: next })
        try { window.localStorage.setItem(key, JSON.stringify(next)) } catch {}
    }
    return <View testID="home-announcement" style={[styles.banner, { marginHorizontal: padX }]}>
        <View style={styles.copy}>
            <Text style={textStyles.meta}>{`Commissioner · ${date}`}</Text>
            <Text style={styles.body}>{announcement.body}</Text>
        </View>
        <Pressable onPress={dismiss} role="button" accessibilityRole="button" accessibilityLabel="Dismiss announcement" style={styles.dismiss}>
            <Text style={styles.dismissText}>×</Text>
        </Pressable>
    </View>
}

const styles = StyleSheet.create({
    banner: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, padding: spacing.sm, marginVertical: spacing.sm, borderRadius: radii.md, borderWidth: 1, borderColor: colors.primaryBorder, backgroundColor: colors.primaryLight },
    copy: { flex: 1, minWidth: 0, gap: spacing.xs },
    body: { ...textStyles.body, color: colors.textPrimary },
    dismiss: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
    dismissText: { ...textStyles.body, color: colors.textSecondary },
})
