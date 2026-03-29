import { NativeTabs, Label, Icon } from 'expo-router/unstable-native-tabs'
import { colors } from '@/constants/tokens'

export default function TabLayout() {
    return (
        <NativeTabs
            tintColor={colors.primary}
        >
            <NativeTabs.Trigger name="index">
                <Label>Home</Label>
                <Icon sf="house.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="players">
                <Label>Players</Label>
                <Icon sf="person.2.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="trades">
                <Label>Trades</Label>
                <Icon sf="arrow.left.arrow.right" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="league">
                <Label>League</Label>
                <Icon sf="trophy.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="profile">
                <Label>Profile</Label>
                <Icon sf="person.crop.circle.fill" />
            </NativeTabs.Trigger>
        </NativeTabs>
    )
}
