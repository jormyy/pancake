import { expect, it, vi } from 'vitest'
import { resolveTimelineScreen, type TimelineModules } from '@/components/navigation/TimelineScreenLoader'

it('rejects a missing timeline screen so the route can show its retry control', async () => {
    const context = Object.assign(vi.fn(), { keys: () => [] }) as unknown as TimelineModules
    await expect(resolveTimelineScreen(context)).rejects.toThrow('not available in this build')
    expect(context).not.toHaveBeenCalled()
})

it.each(['named', 'default'])('loads the %s timeline export', async kind => {
    const Screen = () => null
    const module = kind === 'named' ? { TimelineScreen: Screen } : { default: Screen }
    const context = Object.assign(vi.fn(async () => module), { keys: () => ['./timeline/TimelineScreen.tsx'] })
    await expect(resolveTimelineScreen(context)).resolves.toEqual({ default: Screen })
    expect(context).toHaveBeenCalledWith('./timeline/TimelineScreen.tsx')
})

it('rejects an incomplete export', async () => {
    const context = Object.assign(vi.fn(async () => ({})), { keys: () => ['./timeline/TimelineScreen.tsx'] })
    await expect(resolveTimelineScreen(context)).rejects.toThrow('screen could not load')
})
