import { Redirect } from 'expo-router'

// Dynasty rankings and news now live under Players. Old links and bookmarks
// land on the matching section there.
export default function DynastyRedirect() {
    return <Redirect href="/players?section=rankings" />
}
