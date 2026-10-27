import { lazy, type ComponentType } from 'react'

type TimelineModule = { TimelineScreen?: ComponentType; default?: ComponentType }
export type TimelineModules = { (key: string): Promise<TimelineModule>; keys: () => string[] }

export async function resolveTimelineScreen(screens: TimelineModules) {
    const key = screens.keys()[0]
    if (!key) throw new Error('The season timeline is not available in this build.')
    const module = await screens(key)
    const Screen = module.TimelineScreen ?? module.default
    if (!Screen) throw new Error('The season timeline screen could not load.')
    return { default: Screen }
}

export function loadTimeline() {
    return lazy(() => import('@/components/timeline/TimelineScreen'))
}
