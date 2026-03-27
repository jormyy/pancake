import { NativeTabs, Label, Icon } from 'expo-router/unstable-native-tabs'

const ORANGE = '#F97316'

export default function TabLayout() {
    return (
        <NativeTabs
            tintColor={ORANGE}
        >
            <NativeTabs.Trigger name="index">
                <Label>Home</Label>
                <Icon sf="house.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="players">
                <Label>Players</Label>
                <Icon sf="person.2.fill" />
            </NativeTabs.Trigger>
            <NativeTabs.Trigger name="roster">
                <Label>Roster</Label>
                <Icon sf="basketball.fill" />
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
