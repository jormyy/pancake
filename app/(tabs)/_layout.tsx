import { NativeTabs, Label, Icon } from 'expo-router/unstable-native-tabs'
import { colors } from '@/constants/tokens'

export default function TabLayout() {
    return (
        <NativeTabs
            tintColor={colors.primary}
        >
            <NativeTabs.Trigger name="index">
                <Label>Matchup</Label>
                <Icon sf="house.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="roster">
                <Label>Roster</Label>
                <Icon sf="list.bullet.clipboard.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="players">
                <Label>Players</Label>
                <Icon sf="person.2.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="trades">
                <Label>Trades</Label>
                <Icon sf="arrow.left.arrow.right" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="dynasty">
                <Label>Dynasty</Label>
                <Icon sf="sparkles" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="league">
                <Label>League</Label>
                <Icon sf="trophy.fill" />
            </NativeTabs.Trigger>
        </NativeTabs>
    )
}
