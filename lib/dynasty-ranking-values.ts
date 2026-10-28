import { calculateFantasyPoints } from '@/core/src/scoring/formula'
import type { ScoringSettings, StatLine } from '@/core/src/scoring/types'
import {
    DYNASTY_STRATEGIES,
    type DynastyAssetComponents,
    type DynastyAssetResult,
    type DynastyEngineContext,
    type DynastyPickAsset,
    type DynastyPlayerAsset,
    type DynastyStrategy,
    type DynastyValueRange,
} from '@/core/src/dynasty/decisionEngine'

const DYNASTY_STRATEGY_WEIGHTS = {
    overall: { production: 0.35, projection: 0.25, market: 0.25, age: 0.15 },
    contend: { production: 0.50, projection: 0.30, market: 0.15, age: 0.05 },
    rebuild: { production: 0.20, projection: 0.20, market: 0.30, age: 0.30 },
} as const satisfies Record<DynastyStrategy, Record<'production' | 'projection' | 'market' | 'age', number>>

const EMPTY_COMPONENTS: DynastyAssetComponents = {
    production: 0,
    projection: 0,
    market: 0,
    age: 0,
    healthMultiplier: 1,
    movementMultiplier: 1,
    replacement: 0,
    rosterSlot: 0,
    package: 0,
    shortTermPoints: 0,
    longTermValue: 0,
}

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value)
const round = (value: number) => Math.sign(value) * Math.round(Math.abs(value))
const roundOne = (value: number) => Math.round(value * 10) / 10

function normalizedAge(age: number | null): number {
    if (!finite(age)) return 0.5
    if (age <= 19) return 0.90
    if (age <= 22) return 1 - Math.abs(22 - age) * 0.03
    return clamp(1 - (age - 22) * 0.075, 0.08, 1)
}

function normalizedRank(rank: number | null): number {
    if (!finite(rank) || rank < 1) return 0.45
    return clamp(1 - (rank - 1) / 499, 0.02, 1)
}

function healthMultiplier(status: string | null): number {
    const value = status?.trim().toUpperCase() ?? ''
    if (!value || value === 'ACTIVE' || value === 'HEALTHY') return 1
    if (value.includes('OUT') || value === 'O') return 0.88
    if (value.includes('IR')) return 0.90
    if (value.includes('DOUBTFUL') || value === 'D') return 0.92
    if (value.includes('QUESTIONABLE') || value.includes('DAY') || value === 'Q') return 0.96
    return 0.98
}

function movementMultiplier(movement: number | null): number {
    if (!finite(movement)) return 1
    return 1 + clamp(movement / 100, -0.04, 0.04)
}

function fantasyPoints(
    stats: StatLine | null | undefined,
    direct: number | null | undefined,
    settings: ScoringSettings,
): number | null {
    if (stats) return calculateFantasyPoints(stats, settings)
    return finite(direct) ? direct : null
}

function valuePlayer(context: DynastyEngineContext, asset: DynastyPlayerAsset): DynastyAssetResult {
    const productionPoints = fantasyPoints(asset.productionStats, asset.productionFantasyPoints, context.scoringSettings)
    const projectionPoints = fantasyPoints(asset.projectionStats, asset.projectionFantasyPoints, context.scoringSettings)
    const production = finite(productionPoints) ? clamp(productionPoints / 65, 0, 1.15) : 0.45
    const projection = finite(projectionPoints) ? clamp(projectionPoints / 65, 0, 1.15) : production
    const market = normalizedRank(asset.marketRanks?.overall ?? asset.dynastyRank)
    const age = normalizedAge(asset.age)
    const health = healthMultiplier(asset.healthStatus)
    const movement = movementMultiplier(asset.rankMovement)
    const replacementValue = clamp(context.replacementValue ?? 180, 0, 500)
    const values = Object.fromEntries(DYNASTY_STRATEGIES.map((strategy) => {
        const weights = DYNASTY_STRATEGY_WEIGHTS[strategy]
        const strategyMarket = normalizedRank(asset.marketRanks?.[strategy] ?? asset.dynastyRank)
        const raw = 1000 * (
            production * weights.production +
            projection * weights.projection +
            strategyMarket * weights.market +
            age * weights.age
        )
        return [strategy, round(clamp(raw * health * movement, 0, 1000))]
    })) as Record<DynastyStrategy, number>
    const missingInputs = [
        !finite(productionPoints) ? 'current production' : null,
        !finite(projectionPoints) ? 'projection' : null,
        !finite(asset.dynastyRank) ? 'dynasty rank' : null,
        !finite(asset.age) ? 'age' : null,
    ].filter((value): value is string => value != null)
    const confidence = clamp(1 - missingInputs.length * 0.13 - (asset.sources?.some((source) => !source.fetchedAt) ? 0.05 : 0), 0.35, 1)
    const spread = 0.12 + missingInputs.length * 0.08 + (asset.isRookie ? 0.08 : 0)
    const ranges = Object.fromEntries(DYNASTY_STRATEGIES.map(strategy => [strategy, {
        low: round(Math.max(0, values[strategy] * (1 - spread))),
        high: round(Math.min(1000, values[strategy] * (1 + spread))),
    }]))

    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges,
        components: {
            production: round(production * 1000),
            projection: round(projection * 1000),
            market: round(market * 1000),
            age: round(age * 1000),
            healthMultiplier: health,
            movementMultiplier: movement,
            replacement: Math.max(0, values.overall - replacementValue),
            rosterSlot: 0,
            package: 0,
            shortTermPoints: roundOne(productionPoints ?? projectionPoints ?? 0),
            longTermValue: values.rebuild,
        },
        sources: asset.sources ?? [],
        confidence: roundOne(confidence),
        missingInputs,
        assumptions: [
            'Current production and projection use the active league scoring settings.',
            'Health changes value by no more than 12%.',
            'Rank movement changes value by no more than 4%.',
            'Player ranges are heuristic sensitivity bands, not statistical confidence intervals.',
            ...(asset.isRookie ? ['Rookie value ranges include extra development uncertainty.'] : []),
        ],
    }
}

const PICK_BASE = [0, 680, 420, 250, 140]

function pickSlotMultiplier(slot: number, teams: number): number {
    const boundedTeams = clamp(Math.trunc(teams), 4, 30)
    const boundedSlot = clamp(Math.trunc(slot), 1, boundedTeams)
    const progress = (boundedSlot - 1) / Math.max(1, boundedTeams - 1)
    return 1.30 - progress * 0.58
}

function pickValue(asset: DynastyPickAsset, strategy: DynastyStrategy, context: DynastyEngineContext, slot: number): number {
    const roundIndex = clamp(Math.trunc(asset.round), 1, 4)
    const base = PICK_BASE[roundIndex]
    const distance = Math.max(0, Math.trunc(asset.seasonYear - context.seasonYear))
    const decay = strategy === 'contend' ? 0.84 : strategy === 'rebuild' ? 0.95 : 0.90
    const strategyFactor = strategy === 'contend' ? 0.88 : strategy === 'rebuild' ? 1.08 : 1
    return round(clamp(base * Math.pow(decay, distance) * pickSlotMultiplier(slot, asset.teams) * strategyFactor, 0, 1000))
}

function valuePick(context: DynastyEngineContext, asset: DynastyPickAsset): DynastyAssetResult {
    const teams = clamp(Math.trunc(asset.teams), 4, 30)
    const knownSlot = finite(asset.slot) && asset.slot >= 1 && asset.slot <= teams ? Math.trunc(asset.slot) : null
    const values = {} as Record<DynastyStrategy, number>
    const ranges: Partial<Record<DynastyStrategy, DynastyValueRange>> = {}
    for (const strategy of DYNASTY_STRATEGIES) {
        if (knownSlot != null) {
            values[strategy] = pickValue(asset, strategy, context, knownSlot)
        } else {
            const early = pickValue(asset, strategy, context, 1)
            const late = pickValue(asset, strategy, context, teams)
            ranges[strategy] = { low: Math.min(early, late), high: Math.max(early, late) }
            values[strategy] = round((early + late) / 2)
        }
    }
    const distance = Math.max(0, asset.seasonYear - context.seasonYear)
    const confidence = clamp(0.94 - distance * 0.06 - (knownSlot == null ? 0.16 : 0), 0.45, 0.94)

    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges,
        components: {
            ...EMPTY_COMPONENTS,
            projection: values.contend,
            age: values.rebuild,
            shortTermPoints: 0,
            longTermValue: values.rebuild,
        },
        sources: asset.sources ?? [],
        confidence: roundOne(confidence),
        missingInputs: knownSlot == null ? ['pick slot'] : [],
        assumptions: [
            `Pick value decays from season ${context.seasonYear}.`,
            knownSlot == null ? `The range uses slots 1 through ${teams}.` : `The value uses known slot ${knownSlot}.`,
        ],
    }
}

export function valueDynastyRankingAsset(
    context: DynastyEngineContext,
    asset: DynastyPlayerAsset | DynastyPickAsset,
): DynastyAssetResult {
    return asset.kind === 'player' ? valuePlayer(context, asset) : valuePick(context, asset)
}
