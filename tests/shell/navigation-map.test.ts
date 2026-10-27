import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const matrix = JSON.parse(readFileSync('tests/e2e/surface-matrix.json', 'utf8'))

it('maps every route to visible content within four taps from Home', () => {
    for (const route of matrix.surfaces) {
        expect(route.navigation.entryFromHome, route.id).toBeTruthy()
        expect(route.navigation.firstView, route.id).toBeTruthy()
        expect(route.navigation.tapsFromHome, route.id).toBeGreaterThanOrEqual(0)
        expect(route.navigation.tapsFromHome, route.id).toBeLessThanOrEqual(4)
    }
})

it('keeps daily actions within three taps and all other actions within four', () => {
    expect(matrix.navigationActions.length).toBeGreaterThan(30)
    for (const feature of matrix.navigationActions) {
        expect(feature.entryFromHome, feature.feature).toBeTruthy()
        expect(feature.firstView, feature.feature).toBeTruthy()
        expect(feature.tapsFromHome, feature.feature).toBeLessThanOrEqual(feature.daily ? 3 : 4)
    }
})
