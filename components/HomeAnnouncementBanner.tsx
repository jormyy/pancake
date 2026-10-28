import { formatLeagueDateTime } from '@/lib/timezone'
import { useLeagueTimezone } from '@/hooks/use-league-timezone'
import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, textStyles } from '@/constants/tokens'
import type { LeagueAnnouncement } from '@/lib/league-announcements'

function readDismissed(key: string): string | null {
    try {
        const value: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
        return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
    } catch {
        return null
    }
}

type BannerProps = {
    announcements: LeagueAnnouncement[]
    ownerId: string
    memberId?: string
    leagueId: string
    padX: number
}

export function HomeAnnouncementOnEntry({ loaded, revision = 0, ...props }: BannerProps & { loaded: boolean; revision?: number }) {
    const [snapshot, setSnapshot] = useState(() => ({ revision, loaded, announcements: loaded ? props.announcements : [] }))
    if (snapshot.revision !== revision || (!snapshot.loaded && loaded)) {
        setSnapshot({ revision, loaded, announcements: loaded ? props.announcements : [] })
    }
    return <HomeAnnouncementBanner {...props} announcements={snapshot.announcements} />
}

export function HomeAnnouncementBanner({ announcements, ownerId, memberId, leagueId, padX }: BannerProps) {
    const timezone = useLeagueTimezone()
    const key = `pancake-announcements-dismissed:${ownerId}:${leagueId}`
    const saved = useMemo(() => readDismissed(key), [key])
    const [dismissed, setDismissed] = useState({ key, publishedAt: saved })
    const publishedAt = dismissed.key === key ? dismissed.publishedAt : saved
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
    const announcement = [...announcements].sort((left, right) => right.published_at.localeCompare(left.published_at) || right.id.localeCompare(left.id))
        .find(row => row.author_member_id !== memberId && Date.parse(row.published_at) >= cutoff
            && (!publishedAt || Date.parse(row.published_at) > Date.parse(publishedAt)))
    if (!announcement) return null
    const date = formatLeagueDateTime(announcement.published_at, timezone)
    const dismiss = () => {
        const next = announcement.published_at
        setDismissed({ key, publishedAt: next })
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
