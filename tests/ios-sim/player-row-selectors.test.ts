import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { View, Pressable } from 'react-native'
import { readFileSync } from 'node:fs'
import { chromium, webkit } from 'playwright'
import { expect, it, vi } from 'vitest'
import { visibleTapLabel } from '../../scripts/ios-sim/run.mjs'
import { PlayerRowContent } from '@/components/player/PlayerRowContent'

vi.mock('react-native', async () => vi.importActual('react-native-web'))
vi.mock('@/lib/supabase', () => ({ supabase: {} }))

const cases = [
    ['players', 'player-list-light'], ['players', 'player-list-dark'],
    ['league', 'league-activity-light'], ['league', 'league-activity-dark'],
    ['league', 'league-dynasty-light'], ['league', 'league-dynasty-dark'],
    ['league-clock', 'league-activity-retry-light'], ['league-clock', 'league-activity-retry-dark'],
    ['league-member', 'league-activity-avatar-light'], ['league-member', 'league-activity-avatar-dark'],
    ['taxi', 'taxi-player-tags-light'], ['taxi', 'taxi-player-tags-dark'],
]

it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER).each(cases)('%s %s waits for a complete visible player row', async (file, name) => {
    const scenarios = JSON.parse(readFileSync(`scripts/ios-sim/scenarios/${file}.json`, 'utf8'))
    const scenario = scenarios.find((row: { name: string }) => row.name === name)
    const step = file === 'taxi' ? scenario.steps.find((row: { name?: string }) => row.name === 'veteran') : scenario.steps[0]
    const selector = step.expected.selector.replaceAll('{{outPlayer.display_name}}', 'Healthy Veteran')
    const Fixture = () => React.createElement(View, { nativeID: 'league-panel-history', style: { width: 320 } },
        React.createElement(Pressable, { accessibilityLabel: 'Open Healthy Veteran' },
            React.createElement(PlayerRowContent, { name: 'Healthy Veteran', team: 'GSW', positions: ['C'], yearsExp: 4, careerGames: 65, stats: '34 FP' })))
    const { AppRegistry } = await vi.importActual<{ AppRegistry: { registerComponent: (name: string, component: () => React.ComponentType) => void; getApplication: (name: string) => { element: React.ReactElement; getStyleElement: () => React.ReactElement } } }>('react-native-web')
    AppRegistry.registerComponent('RowSelector', () => Fixture)
    const application = AppRegistry.getApplication('RowSelector')
    const html = `<html><head>${renderToStaticMarkup(application.getStyleElement())}</head><body>${renderToStaticMarkup(application.element)}</body></html>`
    for (const engine of [chromium, webkit]) {
        const browser = await engine.launch()
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
            await page.setContent(html)
            expect(await page.locator(selector).first().isVisible()).toBe(true)
            await page.getByTestId('player-stats-line').evaluate(element => element.remove())
            expect(await page.locator(selector).count()).toBe(0)
        } finally {
            await browser.close()
        }
    }
})


it.skipIf(!process.env.PANCAKE_LAYOUT_BROWSER).each([
    ['shell', 'shell-light-menu'], ['shell', 'shell-dark-menu'],
    ['league', 'league-standings-light'], ['league', 'league-standings-dark'],
])('%s %s waits for the loaded lineup before tapping navigation', async (file, name) => {
    const scenarios = JSON.parse(readFileSync(`scripts/ios-sim/scenarios/${file}.json`, 'utf8'))
    const scenario = scenarios.find((row: { name: string }) => row.name === name)
    const browser = await webkit.launch()
    try {
        const page = await browser.newPage()
        const label = scenario.steps[0].action.tap
        await page.setContent(`<button aria-label="${label}">${label}</button><script>
            setTimeout(() => {
                document.querySelector('button').onclick = () => document.body.dataset.opened = 'true';
                const ready = document.createElement('button');
                ready.setAttribute('aria-label', 'Open auto-set lineup options');
                document.body.append(ready);
            }, 500);
        </script>`)
        const driver = { execute: (script: string, ...args: unknown[]) => page.evaluate(`(function(){${script}}).apply(null, ${JSON.stringify(args)})`) }
        for (const action of scenario.prepare ?? []) await visibleTapLabel(driver, action.reveal)
        await page.getByLabel(label, { exact: true }).click()
        expect(await page.locator('body').getAttribute('data-opened')).toBe('true')
    } finally {
        await browser.close()
    }
})
