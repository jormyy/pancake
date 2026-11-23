import path from 'path'
import { ESLint } from 'eslint'
import { expect, it } from 'vitest'

const eslint = new ESLint({ cwd: path.resolve(__dirname, '../..') })

async function lifecycleMessages(code: string, filePath = 'hooks/probe.ts') {
    const [result] = await eslint.lintText(code, { filePath })
    return result.messages.filter(message => message.ruleId === 'pancake/lifecycle-owner').map(message => message.message)
}

it('accepts resources that recover through the lifecycle bus', async () => {
    expect(await lifecycleMessages(`import { useEffect } from 'react'
import { onLifecycle } from '@/lib/lifecycle'
export function useStandings(refresh: () => void) {
    useEffect(() => onLifecycle(['online', 'visible', 'rejoin'], refresh), [refresh])
}
`)).toEqual([])
})

it('rejects the hand-wired dynasty listeners that 8a1be1a8 had to add one resource at a time', async () => {
    const messages = await lifecycleMessages(`import { useEffect } from 'react'
export function useDynasty(resume: () => void) {
    useEffect(() => {
        window.addEventListener('online', resume)
        window.addEventListener('focus', resume)
        document.addEventListener('visibilitychange', resume)
        return () => {
            window.removeEventListener('online', resume)
            window.removeEventListener('focus', resume)
            document.removeEventListener('visibilitychange', resume)
        }
    }, [resume])
}
`)
    expect(messages).toHaveLength(3)
    expect(messages[0]).toContain('Use onLifecycle from lib/lifecycle')
})

it('rejects native AppState listeners', async () => {
    expect(await lifecycleMessages(`import { AppState } from 'react-native'
export const stop = AppState.addEventListener('change', () => {})
`)).toEqual([expect.stringContaining('Use onLifecycle from lib/lifecycle')])
})

it('rejects a raw channel like the auction room that stayed closed before 87cd49de', async () => {
    expect(await lifecycleMessages(`import { supabase } from '@/lib/supabase'
export const channel = supabase.channel('draft:1').subscribe()
`, 'lib/draft-probe.ts')).toEqual([expect.stringContaining('subscribeToTableChanges in lib/realtime')])
})

it('leaves element and service worker listeners alone', async () => {
    expect(await lifecycleMessages(`export function watch(input: HTMLInputElement, worker: ServiceWorkerContainer, onChange: () => void) {
    input.addEventListener('focus', onChange)
    worker.addEventListener('message', onChange)
    window.addEventListener('storage', onChange)
}
`)).toEqual([])
})

it('lets the lifecycle and realtime owners bind the browser and the socket', async () => {
    expect(await lifecycleMessages(`window.addEventListener('online', () => {})
`, 'lib/lifecycle.ts')).toEqual([])
    expect(await lifecycleMessages(`import { supabase } from '@/lib/supabase'
export const channel = supabase.channel('topic')
`, 'lib/realtime.ts')).toEqual([])
})
