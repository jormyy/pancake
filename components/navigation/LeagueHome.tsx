import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { Page, PageHeader } from '@/components/ui'
import { useLeagueContext } from '@/contexts/league-context'
import { spacing, textStyles } from '@/constants/tokens'

export const LEAGUE_LINKS = [
    { title: 'League', links: [
        { label: 'Standings', href: '/league?tab=results' },
        { label: 'Activity', href: '/league?tab=history' },
        { label: 'Picks and draft board', href: '/league?tab=picks' },
        { label: 'Playoffs', href: '/(modals)/bracket' },
        { label: 'League settings', href: '/league?tab=settings' },
        { label: 'Season timeline', href: '/(modals)/timeline' },
    ] },
    { title: 'My team', links: [
        { label: 'Roster', href: '/roster' },
        { label: 'Lineup', href: '/(modals)/lineup' },
        { label: 'Waivers', href: '/players?section=waivers' },
    ] },
    { title: 'Draft rooms', links: [
        { label: 'Draft Room', href: '/draft' },
        { label: 'Draft setup and mock rooms', href: '/league?tab=draft' },
    ] },
    { title: 'Account', links: [
        { label: 'Profile & settings', href: '/profile' },
        { label: 'Notifications', href: '/(modals)/notification-settings' },
        { label: 'Change password', href: '/(modals)/change-password' },
        { label: 'Create a League', href: '/(modals)/create-league' },
        { label: 'Join with Invite Code', href: '/(modals)/join-league' },
    ] },
] as const

export function LeagueHome() {
    const router = useRouter()
    const { currentLeague, isCommissioner } = useLeagueContext()
    return (
        <Page title="League">
            <PageHeader title={currentLeague?.name ?? 'League'} compact />
            <ScrollView contentContainerStyle={styles.body}>
                {LEAGUE_LINKS.map(section => <View key={section.title} style={styles.section}>
                    <Text style={textStyles.sectionLabel} accessibilityRole="header">{section.title}</Text>
                    {section.links.map(link => <Button key={link.label} title={link.label} variant="ghost"
                        accessibilityLabel={link.label} onPress={() => router.push(link.href as Href)} />)}
                </View>)}
                {isCommissioner ? <View style={styles.section}>
                    <Text style={textStyles.sectionLabel} accessibilityRole="header">Commissioner tools</Text>
                    <Button title="Commissioner" variant="ghost" onPress={() => router.push('/(modals)/commissioner-settings')} />
                </View> : null}
            </ScrollView>
        </Page>
    )
}

const styles = StyleSheet.create({
    body: { padding: spacing.lg, gap: spacing.xl },
    section: { gap: spacing.xs, alignItems: 'stretch' },
})
