import assert from 'node:assert/strict'

export const contract = Object.freeze({
    baseline: '952580ce3204598d1fd120b3f121d166c7626028',
    managers: 3,
    runsPerArm: 5,
    duplicateWindowMs: 5000,
    minimumNoise: 0.1,
    liveIntervalMs: [30000, 45000, 60000],
    scenarios: {
        home: { minutes: 30 },
        tabs: { minutes: 30, navigationMinutes: 3 },
        background: { minutes: 22, hiddenMinutes: 20 },
        phone: { minutes: 30, viewport: { width: 390, height: 844 }, latencyMs: 150, bytesPerSecond: 200000 },
    },
    regions: ['score', 'roster', 'standings'],
})

export function compareRegions(baseline, candidate) {
    for (const region of contract.regions) {
        assert.ok(typeof baseline[region] === 'string' && baseline[region].trim(), `Missing baseline ${region}`)
        assert.equal(candidate[region], baseline[region], `Rendered ${region} differs`)
    }
}

function noise(values) {
    assert.ok(values.length >= contract.runsPerArm, 'At least five runs are required')
    const sorted = [...values].sort((left, right) => left - right)
    const median = sorted[Math.floor(sorted.length / 2)]
    return { median, relative: Math.max(contract.minimumNoise, median ? (sorted.at(-1) - sorted[0]) / median : 0) }
}

export function assessGain(baseline, candidate) {
    const before = noise(baseline)
    const after = noise(candidate)
    const threshold = Math.max(before.relative, after.relative)
    return { before: before.median, after: after.median, threshold, gain: before.median ? (before.median - after.median) / before.median : 0, passed: after.median < before.median * (1 - threshold) }
}

export function assertFreshness(baseline, candidate) {
    const before = noise(baseline)
    const after = noise(candidate)
    assert.ok(after.median <= before.median * (1 + Math.max(before.relative, after.relative)), 'Live score freshness regressed')
}
