import { calculateFantasyPoints } from '../scoring/formula'
import type { ScoringSettings, StatLine } from '../scoring/types'

export type DynastyStrategy = 'overall' | 'contend' | 'rebuild'

export const DYNASTY_STRATEGIES: DynastyStrategy[] = ['overall', 'contend', 'rebuild']

export const DYNASTY_STRATEGY_WEIGHTS = {
    overall: { production: 0.35, projection: 0.25, market: 0.25, age: 0.15 },
    contend: { production: 0.50, projection: 0.30, market: 0.15, age: 0.05 },
    rebuild: { production: 0.20, projection: 0.20, market: 0.30, age: 0.30 },
} as const satisfies Record<DynastyStrategy, Record<'production' | 'projection' | 'market' | 'age', number>>

export type DynastySource = {
    name: string
    fetchedAt: string | null
}

type AssetBase = {
    id: string
    label: string
    sources?: DynastySource[]
}

export type DynastyPlayerAsset = AssetBase & {
    kind: 'player'
    age: number | null
    dynastyRank: number | null
    rankMovement: number | null
    healthStatus: string | null
    productionStats?: StatLine | null
    projectionStats?: StatLine | null
    productionFantasyPoints?: number | null
    projectionFantasyPoints?: number | null
    isRookie?: boolean
}

export type DynastyPickAsset = AssetBase & {
    kind: 'pick'
    seasonYear: number
    round: number
    slot: number | null
    teams: number
}

export type DynastyFaabAsset = AssetBase & {
    kind: 'faab'
    amount: number
    budget: number
    freeAgentQuality: number
}

export type DynastyRosterSlotAsset = AssetBase & {
    kind: 'rosterSlot'
    count: number
    replacementValue: number
}

export type DynastyAsset = DynastyPlayerAsset | DynastyPickAsset | DynastyFaabAsset | DynastyRosterSlotAsset

export type DynastyEngineContext = {
    leagueId: string
    seasonYear: number
    scoringSettings: ScoringSettings
    replacementValue?: number
}

export type DynastyValueRange = {
    low: number
    high: number
}

export type DynastyAssetComponents = {
    production: number
    projection: number
    market: number
    age: number
    healthMultiplier: number
    movementMultiplier: number
    replacement: number
    rosterSlot: number
    package: number
    shortTermPoints: number
    longTermValue: number
}

export type DynastyAssetResult = {
    assetId: string
    kind: DynastyAsset['kind']
    label: string
    values: Record<DynastyStrategy, number>
    ranges: Partial<Record<DynastyStrategy, DynastyValueRange>>
    components: DynastyAssetComponents
    sources: DynastySource[]
    confidence: number
    missingInputs: string[]
    assumptions: string[]
}

export type DynastyTradeRoute = {
    fromMemberId: string
    toMemberId: string
    asset: DynastyAsset
}

export type DynastyTradeTeamResult = {
    memberId: string
    valuesSent: number
    valuesReceived: number
    shortTermPoints: number
    longTermValue: number
    packageEffect: number
    replacementEffect: number
    rosterSlotEffect: number
    impact: number
}

export type DynastyTradeAnalysis = {
    strategy: DynastyStrategy
    teams: DynastyTradeTeamResult[]
    assets: DynastyAssetResult[]
    sources: DynastySource[]
    confidence: number
    missingInputs: string[]
    assumptions: string[]
}

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
const round = (value: number) => Math.round(value)
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
    const market = normalizedRank(asset.dynastyRank)
    const age = normalizedAge(asset.age)
    const health = healthMultiplier(asset.healthStatus)
    const movement = movementMultiplier(asset.rankMovement)
    const replacementValue = clamp(context.replacementValue ?? 180, 0, 500)
    const values = Object.fromEntries(DYNASTY_STRATEGIES.map((strategy) => {
        const weights = DYNASTY_STRATEGY_WEIGHTS[strategy]
        const raw = 1000 * (
            production * weights.production +
            projection * weights.projection +
            market * weights.market +
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

    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges: {},
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

function valueFaab(asset: DynastyFaabAsset): DynastyAssetResult {
    const budget = finite(asset.budget) && asset.budget > 0 ? asset.budget : 100
    const amount = clamp(finite(asset.amount) ? asset.amount : 0, 0, budget)
    const quality = clamp(finite(asset.freeAgentQuality) ? asset.freeAgentQuality : 0.5, 0, 1)
    const overall = round((amount / budget) * (45 + quality * 105))
    const values = {
        overall,
        contend: round(overall * 1.15),
        rebuild: round(overall * 0.85),
    }
    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges: {},
        components: { ...EMPTY_COMPONENTS, production: values.contend, longTermValue: values.rebuild },
        sources: asset.sources ?? [],
        confidence: asset.budget > 0 ? 0.9 : 0.65,
        missingInputs: asset.budget > 0 ? [] : ['FAAB budget'],
        assumptions: ['FAAB value scales with league budget and available free-agent quality.'],
    }
}

function valueRosterSlot(asset: DynastyRosterSlotAsset): DynastyAssetResult {
    const slotValue = round(clamp(asset.replacementValue, 0, 500) * asset.count * 0.18)
    const values = { overall: slotValue, contend: round(slotValue * 1.1), rebuild: round(slotValue * 0.9) }
    return {
        assetId: asset.id,
        kind: asset.kind,
        label: asset.label,
        values,
        ranges: {},
        components: { ...EMPTY_COMPONENTS, rosterSlot: slotValue, longTermValue: values.rebuild },
        sources: asset.sources ?? [],
        confidence: 0.85,
        missingInputs: [],
        assumptions: ['A roster slot uses 18% of the league replacement value.'],
    }
}

export function valueDynastyAsset(context: DynastyEngineContext, asset: DynastyAsset): DynastyAssetResult {
    if (asset.kind === 'player') return valuePlayer(context, asset)
    if (asset.kind === 'pick') return valuePick(context, asset)
    if (asset.kind === 'faab') return valueFaab(asset)
    return valueRosterSlot(asset)
}

export function valueDynastyAssets(context: DynastyEngineContext, assets: DynastyAsset[]): DynastyAssetResult[] {
    return assets.map((asset) => valueDynastyAsset(context, asset))
}

function packagePenalty(values: number[]): number {
    const positive = values.filter((value) => value > 0).sort((left, right) => right - left)
    if (positive.length < 2) return 0
    const strongest = positive[0]
    const weakTotal = positive.slice(1).reduce((total, value) => total + value, 0)
    return round(Math.max(0, weakTotal - strongest * 0.6) * 0.25)
}

function uniqueSources(results: DynastyAssetResult[]): DynastySource[] {
    const map = new Map<string, DynastySource>()
    for (const result of results) {
        for (const source of result.sources) map.set(`${source.name}:${source.fetchedAt ?? ''}`, source)
    }
    return [...map.values()]
}

export function analyzeDynastyTrade(
    context: DynastyEngineContext,
    strategy: DynastyStrategy,
    routes: DynastyTradeRoute[],
): DynastyTradeAnalysis {
    const results = routes.map((route) => valueDynastyAsset(context, route.asset))
    const memberIds = [...new Set(routes.flatMap((route) => [route.fromMemberId, route.toMemberId]))].sort()
    const replacementValue = clamp(context.replacementValue ?? 180, 0, 500)
    const teams = memberIds.map((memberId): DynastyTradeTeamResult => {
        const sentIndexes = routes.flatMap((route, index) => route.fromMemberId === memberId ? [index] : [])
        const receivedIndexes = routes.flatMap((route, index) => route.toMemberId === memberId ? [index] : [])
        const sentValues = sentIndexes.map((index) => results[index].values[strategy])
        const receivedValues = receivedIndexes.map((index) => results[index].values[strategy])
        const sentPenalty = packagePenalty(sentValues)
        const receivedPenalty = packagePenalty(receivedValues)
        const valuesSent = Math.max(0, sentValues.reduce((total, value) => total + Math.max(0, value), 0) - sentPenalty)
        const valuesReceived = Math.max(0, receivedValues.reduce((total, value) => total + Math.max(0, value), 0) - receivedPenalty)
        const sentPlayers = sentIndexes.filter((index) => routes[index].asset.kind === 'player').length
        const receivedPlayers = receivedIndexes.filter((index) => routes[index].asset.kind === 'player').length
        const slotDelta = sentPlayers - receivedPlayers
        const rosterSlotEffect = round(slotDelta * replacementValue * 0.18)
        const replacementEffect = slotDelta > 0 ? round(slotDelta * replacementValue * 0.08) : 0
        const shortTermPoints = roundOne(
            receivedIndexes.reduce((total, index) => total + results[index].components.shortTermPoints, 0) -
            sentIndexes.reduce((total, index) => total + results[index].components.shortTermPoints, 0),
        )
        const longTermValue = round(
            receivedIndexes.reduce((total, index) => total + results[index].components.longTermValue, 0) -
            sentIndexes.reduce((total, index) => total + results[index].components.longTermValue, 0),
        )
        return {
            memberId,
            valuesSent,
            valuesReceived,
            shortTermPoints,
            longTermValue,
            packageEffect: sentPenalty - receivedPenalty,
            replacementEffect,
            rosterSlotEffect,
            impact: round(valuesReceived - valuesSent + rosterSlotEffect + replacementEffect),
        }
    })
    const confidence = results.length === 0
        ? 0
        : roundOne(results.reduce((total, result) => total + result.confidence, 0) / results.length)
    return {
        strategy,
        teams,
        assets: results,
        sources: uniqueSources(results),
        confidence,
        missingInputs: [...new Set(results.flatMap((result) => result.missingInputs))],
        assumptions: [...new Set(results.flatMap((result) => result.assumptions))],
    }
}
